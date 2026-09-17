'use strict';
// GET /api/account/instructions            -> { text, updatedAt, maxChars }
// PUT /api/account/instructions { text }   -> { text, updatedAt, maxChars }   own account only
const instructions = require('../account-instructions.cjs');

function createAccountRoutes({ json, readJson, dir }) {
  return async function accountRoutes(req, res, { path, authn }) {
    if (path !== '/api/account/instructions') return false;
    if (!authn) return json(res, 401, { error: 'Sign in first' }), true;
    const out = (record) => json(res, 200, { ...record, maxChars: instructions.MAX_CHARS });
    if (req.method === 'GET') return out(instructions.read(dir())), true;
    if (req.method !== 'PUT') return json(res, 405, { error: 'method not allowed' }), true;
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }), true; }
    try { return out(instructions.write(dir(), body?.text)), true; }
    catch (e) { return json(res, e.status || 500, { error: e.publicMessage || 'Could not save your instructions' }), true; }
  };
}

module.exports = { createAccountRoutes };
