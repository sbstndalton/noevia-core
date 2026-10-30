'use strict';
const { readCappedText, readCappedJson } = require('../http.cjs');
// The plugin directory library the Node-owned routes still use. GET /api/plugins/directory itself
// (the MCP registry and skills listings, the starters, the cache) is the Rust front's
// (sbstndalton/noevia#2190, noevia-rs bins/noevia-server plugin_directory_routes.rs; Node refuses it
// in rust-plugin-directory.cjs). What stays: `findRegistryServer` and `mcpItems` for adding a
// directory MCP server (routes/mcp-directory.cjs), `RESERVED_HEADERS` for its header names, and
// `fetchPublishedSkill` for a project skill (routes/projects.cjs). Only fixed hosts are fetched.

// A hosted server noevia can add as-is: a streamable-HTTP remote at a fixed https URL that needs
// no sign-in headers. Anything else (a package to run here, SSE, templated URLs, API keys) is
// browse-only for now.
// Headers a request must never carry from a stranger's config: transport, session and identity.
const RESERVED_HEADERS = /^(host|cookie|connection|content-length|content-type|transfer-encoding|origin|accept|mcp-session-id|mcp-protocol-version|proxy-.*|x-forwarded-.*)$/i;
const cleanHeaders = (list) => (Array.isArray(list) ? list : []).filter((h) => h && typeof h.name === 'string').map((h) => ({
  name: h.name, required: !!h.isRequired, secret: h.isSecret !== false,
  description: String(h.description || '').slice(0, 300),
  // "Bearer {api_key}" style templates: the admin types only the key.
  template: typeof h.value === 'string' && (h.value.match(/\{[^}]+\}/g) || []).length === 1 ? h.value.slice(0, 200) : null,
}));

// A hosted server noevia can add: a streamable-HTTP remote at a fixed https URL. Sign-in headers are
// fine when their names are plain and not reserved; the admin supplies the values when adding.
// Anything else (a package to run here, SSE, templated URLs) is browse-only.
function installable(s) {
  const remotes = Array.isArray(s.remotes) ? s.remotes : [];
  const usable = remotes.find((r) => r && r.type === 'streamable-http' && typeof r.url === 'string' && require('../directory-mcp.cjs').hostedUrlOk(r.url)
    && cleanHeaders(r.headers).every((h) => /^[A-Za-z0-9-]{1,64}$/.test(h.name) && !RESERVED_HEADERS.test(h.name)));
  if (usable) {
    const headers = cleanHeaders(usable.headers);
    return { remoteUrl: usable.url, installable: true, ...(headers.length ? { headers, needsKey: headers.some((h) => h.required) } : {}) };
  }
  const why = !remotes.length ? 'Runs as a program on the server; not supported'
    : remotes.some((r) => r?.type === 'streamable-http') ? 'Uses an address or header noevia cannot accept'
    : 'Uses a connection type noevia does not support';
  return { installable: false, notInstallable: why };
}

// Reverse-DNS namespace segments (and the registry's own generic word "mcp") that say nothing
// about which server this is, e.g. the "com" and "mcp" in "com.cloudflare.mcp".
const GENERIC_NAME_SEGMENTS = new Set(['com', 'org', 'net', 'io', 'ai', 'co', 'app', 'dev', 'www', 'mcp']);
const titleCase = (seg) => seg.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
const hostSlug = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return ''; } };

/**
 * A directory entry's readable title. A manifest `title` always wins. Otherwise the registry's
 * `name` is a reverse-DNS id like "com.notion/mcp" or "com.cloudflare.mcp/mcp": the segment after
 * the last `/` is usually the server's own slug ("exa", "linear"), but for some publishers it is
 * just the generic word "mcp" — identical across unrelated servers and meaningless on its own.
 * When that happens, fall back to the last non-generic namespace segment ("notion",
 * "cloudflare"), then to the repository/website host, before giving up and showing the raw id
 * rather than fabricate a title out of nothing but generic words.
 */
function fallbackServerName(s) {
  if (s?.title) return s.title;
  const raw = String(s?.name || '');
  const parts = raw.split('/');
  const slug = parts[parts.length - 1] || '';
  if (slug && slug.toLowerCase() !== 'mcp') return slug;
  const segments = parts.slice(0, -1).join('.').split('.').filter(Boolean);
  const meaningful = segments.filter((seg) => seg && !GENERIC_NAME_SEGMENTS.has(seg.toLowerCase()));
  const derived = meaningful[meaningful.length - 1] || hostSlug(s?.repository?.url) || hostSlug(s?.websiteUrl);
  return derived ? titleCase(derived) : (raw || slug);
}

function mcpItems(body) {
  const list = Array.isArray(body?.servers) ? body.servers : [];
  const seen = new Set();
  return list.map((entry) => entry?.server || entry).filter((s) => s && typeof s.name === 'string').filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name); return true;
  }).map((s) => ({
    id: s.name,
    name: fallbackServerName(s),
    publisher: s.name.includes('/') ? s.name.split('/')[0] : '',
    description: String(s.description || '').slice(0, 300),
    version: s.version || '',
    url: typeof s.repository?.url === 'string' && /^https:\/\//.test(s.repository.url) ? s.repository.url : (typeof s.websiteUrl === 'string' && /^https:\/\//.test(s.websiteUrl) ? s.websiteUrl : ''),
    remote: Array.isArray(s.remotes) && s.remotes.length > 0,
    ...installable(s),
  }));
}

// A directory listing of 40 servers or one repo's skill folders; 4 MB is far above that (#920).
const DIRECTORY_CAP = 4 * 1024 * 1024;

/**
 * Fetch one published skill's SKILL.md (only SKILL.md: scripts and assets are never fetched or
 * run). Fixed host, validated name, 32 KiB cap, and the result must be valid skill frontmatter.
 */
async function fetchPublishedSkill(name, { fetchImpl = globalThis.fetch } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(name || ''))) throw Object.assign(new Error('Unknown skill'), { status: 400 });
  const r = await fetchImpl(`https://raw.githubusercontent.com/anthropics/skills/main/skills/${name}/SKILL.md`, { headers: { 'user-agent': 'noevia' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (r.status === 404) throw Object.assign(new Error('That skill has no SKILL.md'), { status: 404 });
  if (!r.ok) throw Object.assign(new Error('The skills repository could not be reached right now.'), { status: 502 });
  const { text: content, capped } = await readCappedText(r, 32768);
  if (capped) throw Object.assign(new Error('That skill is larger than the 32 KiB limit for project skills.'), { status: 422 });
  return content;
}

/** Look one server up in the public registry by its exact name; returns the mapped item or null. */
async function findRegistryServer(name, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof name !== 'string' || !name || name.length > 200) return null;
  // NOEVIA_QA_MCP_REGISTRY points the lookup at a synthetic registry in QA runs only.
  const base = process.env.NOEVIA_QA_MCP_REGISTRY || 'https://registry.modelcontextprotocol.io';
  const r = await fetchImpl(`${base}/v0/servers?limit=40&search=${encodeURIComponent(name)}`, { headers: { accept: 'application/json', 'user-agent': 'noevia' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Object.assign(new Error('The MCP registry could not be reached right now.'), { status: 502 });
  return mcpItems(await readCappedJson(r, DIRECTORY_CAP)).find((i) => i.id === name) || null;
}

module.exports = { mcpItems, fetchPublishedSkill, findRegistryServer, installable, RESERVED_HEADERS, fallbackServerName };
