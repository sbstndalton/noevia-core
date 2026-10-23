'use strict';
// Read-only Node oracle for the Rust-owned GET views. The Rust front owns both
// administrator POST writers and the direct Node guard refuses them before this factory.
function createWebAddressRoutes({ auth, json }) {
  const view = () => ({ origin: auth.origin, source: auth.originSource, previous: auth.previousOrigins, rpId: auth.rpId });

  return async function webAddressRoutes(req, res, { path, authn }) {
    if (path === '/api/instance' && req.method === 'GET') return json(res, 200, { id: auth.instanceId }), true;
    // Related Origin Requests: lets a renamed site keep using passkeys made under the old name.
    if (path === '/.well-known/webauthn' && req.method === 'GET') return json(res, 200, { origins: auth.relatedOrigins() }), true;
    if (path === '/api/admin/web-address/remove') {
      if (req.method === 'POST') return false; // The early owner guard refuses this writer.
      if (!authn || authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required' }), true;
      return json(res, 405, { error: 'method not allowed' }), true;
    }
    if (path !== '/api/admin/web-address') return false;
    if (!authn || authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required' }), true;
    if (req.method === 'GET') return json(res, 200, view()), true;
    return json(res, 405, { error: 'method not allowed' }), true;
  };
}
module.exports = { createWebAddressRoutes };
