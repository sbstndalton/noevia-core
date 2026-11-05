'use strict';
// Exact shared Node gate fragments at Core 3521cdc2; identity lookup is synthetic.
const crypto = require('node:crypto');
function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1);
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* keep the raw value */ }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}
function csrfValid(req, authn) {
    if (!authn || authn.legacy) return !!authn;
    const value = String(req.headers['x-csrf-token'] || '');
    const cookie = parseCookies(req).cowork_csrf || '';
    return value && value === cookie && digest(value) === authn.session.csrf_hash;
  }
function gate(req,res,p,requestAuth,authService,publicAuthRoutes,unauthorized,json) {
    const authn = p.startsWith('/api/') ? requestAuth.authenticate(req) : null;
    if (p.startsWith('/api/') && !publicAuthRoutes.has(p) && !authn) return unauthorized(res);
    if (authn && !['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET') && (!authService.originValid(req) || !requestAuth.csrfValid(req, authn))) {
      return json(res, 403, { error: 'invalid CSRF token' });
    }

 return false;
}
module.exports = { gate, csrfValid, digest };
