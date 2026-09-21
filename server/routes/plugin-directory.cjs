'use strict';
// GET /api/plugins/directory?kind=mcp|skills&q=  -> { items, source }   any signed-in user
//
// Read-only browsing of what other people publish: MCP servers from the public MCP registry
// and skills from Anthropic's public skills repository. Only these two fixed hosts are ever
// fetched, the query is the only user input, and nothing is installed from here.
const SOURCES = {
  mcp: { label: 'MCP registry', home: 'https://registry.modelcontextprotocol.io' },
  skills: { label: 'anthropics/skills on GitHub', home: 'https://github.com/anthropics/skills' },
};
const TTL = 60 * 60 * 1000;
const STARTERS = (() => { const { mcp, skills } = require('../plugin-starters.json'); return { mcp, skills }; })();

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

function mcpItems(body) {
  const list = Array.isArray(body?.servers) ? body.servers : [];
  const seen = new Set();
  return list.map((entry) => entry?.server || entry).filter((s) => s && typeof s.name === 'string').filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name); return true;
  }).map((s) => ({
    id: s.name,
    name: s.title || s.name.split('/').pop(),
    publisher: s.name.includes('/') ? s.name.split('/')[0] : '',
    description: String(s.description || '').slice(0, 300),
    version: s.version || '',
    url: typeof s.repository?.url === 'string' && /^https:\/\//.test(s.repository.url) ? s.repository.url : (typeof s.websiteUrl === 'string' && /^https:\/\//.test(s.websiteUrl) ? s.websiteUrl : ''),
    remote: Array.isArray(s.remotes) && s.remotes.length > 0,
    ...installable(s),
  }));
}

function skillItems(body) {
  return (Array.isArray(body) ? body : []).filter((d) => d?.type === 'dir' && typeof d.name === 'string').map((d) => ({
    id: d.name,
    name: d.name.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    publisher: 'Anthropic',
    description: '',
    version: '',
    url: typeof d.html_url === 'string' && d.html_url.startsWith('https://github.com/') ? d.html_url : '',
    remote: false,
  }));
}

function createPluginDirectoryRoutes({ json, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const cache = new Map();
  async function load(kind, q) {
    const key = `${kind}:${q}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL) return hit.items;
    const url = kind === 'mcp'
      ? `https://registry.modelcontextprotocol.io/v0/servers?limit=40${q ? `&search=${encodeURIComponent(q)}` : ''}`
      : 'https://api.github.com/repos/anthropics/skills/contents/skills';
    const r = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'noevia' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw Object.assign(new Error(`The directory answered ${r.status}`), { status: 502 });
    let items = kind === 'mcp' ? mcpItems(await r.json()) : skillItems(await r.json());
    if (kind === 'skills' && q) items = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
    if (cache.size > 200) cache.clear();
    cache.set(key, { at: now(), items });
    return items;
  }
  /** noevia's curated starters (plugin-starters.json), each resolved against the live directory. */
  async function starters(kind) {
    const key = `starters:${kind}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL) return hit.items;
    const picks = STARTERS[kind];
    let found;
    if (kind === 'skills') {
      const all = await load('skills', '');
      found = picks.map((p) => all.find((i) => i.id === p.id)).map((item, n) => item && { ...item, why: picks[n].why });
    } else {
      found = await Promise.all(picks.map(async (p) => {
        const item = await findRegistryServer(p.id, { fetchImpl }).catch(() => null);
        return item && { ...item, why: p.why };
      }));
    }
    const items = found.filter(Boolean);
    cache.set(key, { at: now(), items });
    return items;
  }
  return async function pluginDirectoryRoutes(req, res, { path, url }) {
    if (path !== '/api/plugins/directory') return false;
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
    const params = url?.searchParams ?? new URL(req.url, 'http://local').searchParams;
    const kind = params.get('kind') === 'skills' ? 'skills' : 'mcp';
    const q = String(params.get('q') || '').trim().slice(0, 80);
    if (params.get('starters') === '1') {
      try { return json(res, 200, { items: await starters(kind), source: SOURCES[kind] }), true; }
      catch { return json(res, 502, { error: 'The directory could not be reached right now.', source: SOURCES[kind] }), true; }
    }
    try {
      return json(res, 200, { items: await load(kind, q), source: SOURCES[kind] }), true;
    } catch (error) {
      return json(res, 502, { error: 'The directory could not be reached right now.', source: SOURCES[kind] }), true;
    }
  };
}
/**
 * Fetch one published skill's SKILL.md (only SKILL.md: scripts and assets are never fetched or
 * run). Fixed host, validated name, 32 KiB cap, and the result must be valid skill frontmatter.
 */
async function fetchPublishedSkill(name, { fetchImpl = globalThis.fetch } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(name || ''))) throw Object.assign(new Error('Unknown skill'), { status: 400 });
  const r = await fetchImpl(`https://raw.githubusercontent.com/anthropics/skills/main/skills/${name}/SKILL.md`, { headers: { 'user-agent': 'noevia' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (r.status === 404) throw Object.assign(new Error('That skill has no SKILL.md'), { status: 404 });
  if (!r.ok) throw Object.assign(new Error('The skills repository could not be reached right now.'), { status: 502 });
  const content = await r.text();
  if (Buffer.byteLength(content) > 32768) throw Object.assign(new Error('That skill is larger than the 32 KiB limit for project skills.'), { status: 422 });
  return content;
}

/** Look one server up in the public registry by its exact name; returns the mapped item or null. */
async function findRegistryServer(name, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof name !== 'string' || !name || name.length > 200) return null;
  // NOEVIA_QA_MCP_REGISTRY points the lookup at a synthetic registry in QA runs only.
  const base = process.env.NOEVIA_QA_MCP_REGISTRY || 'https://registry.modelcontextprotocol.io';
  const r = await fetchImpl(`${base}/v0/servers?limit=40&search=${encodeURIComponent(name)}`, { headers: { accept: 'application/json', 'user-agent': 'noevia' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Object.assign(new Error('The MCP registry could not be reached right now.'), { status: 502 });
  return mcpItems(await r.json()).find((i) => i.id === name) || null;
}

module.exports = { createPluginDirectoryRoutes, mcpItems, skillItems, fetchPublishedSkill, findRegistryServer, installable, RESERVED_HEADERS };
