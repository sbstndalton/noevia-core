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
  return async function pluginDirectoryRoutes(req, res, { path, url }) {
    if (path !== '/api/plugins/directory') return false;
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;
    const params = url?.searchParams ?? new URL(req.url, 'http://local').searchParams;
    const kind = params.get('kind') === 'skills' ? 'skills' : 'mcp';
    const q = String(params.get('q') || '').trim().slice(0, 80);
    try {
      return json(res, 200, { items: await load(kind, q), source: SOURCES[kind] }), true;
    } catch (error) {
      return json(res, 502, { error: 'The directory could not be reached right now.', source: SOURCES[kind] }), true;
    }
  };
}
module.exports = { createPluginDirectoryRoutes, mcpItems, skillItems };
