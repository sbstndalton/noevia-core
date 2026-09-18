'use strict';
// Settings → Web address: the https name people reach noevia at.
// GET  /api/instance                 -> { id } (public; lets a new address prove it reaches this server)
// GET  /api/admin/web-address        -> current address, where it came from, earlier addresses
// POST /api/admin/web-address        -> { origin, force? } check that it reaches this server, then save
function createWebAddressRoutes({ auth, json, readBody, fetchImpl = fetch, timeoutMs = 8000 }) {
  /** Asks the new address for its instance id. Same id = the name routes here. */
  async function reaches(origin) {
    try {
      const r = await fetchImpl(`${origin}/api/instance`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      if (!r.ok) return `${new URL(origin).host} answered ${r.status}, not noevia.`;
      const body = await r.json().catch(() => ({}));
      return body.id === auth.instanceId ? null : `${new URL(origin).host} reaches a different server, not this noevia.`;
    } catch {
      return `${new URL(origin).host} can’t be reached yet. Check its DNS or tunnel route, then try again.`;
    }
  }
  const view = () => ({ origin: auth.origin, source: auth.originSource, previous: auth.previousOrigins, rpId: auth.rpId });

  return async function webAddressRoutes(req, res, { path, authn }) {
    if (path === '/api/instance' && req.method === 'GET') return json(res, 200, { id: auth.instanceId }), true;
    if (path !== '/api/admin/web-address') return false;
    if (!authn || authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required' }), true;
    if (req.method === 'GET') return json(res, 200, view()), true;
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }), true;
    const body = await readBody(req).catch(() => ({}));
    const next = String(body.origin || '').trim().replace(/\/+$/, '');
    let parsed; try { parsed = new URL(next); } catch { return json(res, 400, { error: 'Enter a full address, such as https://noevia.example.com.' }), true; }
    if (!body.force && parsed.origin !== auth.origin) {
      const problem = await reaches(parsed.origin);
      if (problem) return json(res, 409, { error: problem, unreachable: true }), true;
    }
    const error = auth.changeOrigin(next, authn.user.id);
    if (error) return json(res, 400, { error }), true;
    return json(res, 200, view()), true;
  };
}
module.exports = { createWebAddressRoutes };
