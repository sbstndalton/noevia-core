'use strict';
// GET /api/sampling-settings                 -> whether automatic sampling presets are on, and
//                                                the preset catalogue (issue #194)
// PUT /api/sampling-settings { enabled }      -> flips the server default, administrators only
//
// Mirrors routes/reasoning-settings.cjs: the toggle lives in the same key/value settings table
// ('auto_sampling_presets_enabled'), default on (missing/unset reads as enabled). Selection
// logic and precedence live in sampling-presets.cjs; this route only exposes the on/off switch
// used by chat.cjs and the model settings UI's "Automatic sampling presets" toggle.

const PASS = Symbol('unhandled');
const { PRESETS, PRESETS_VERSION } = require('../sampling-presets.cjs');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<string>} deps.readBody
 * @param {object} deps.authService   db and audit
 */
function createSamplingSettingsRoutes({ json, readBody, authService }) {
  const KEY = 'auto_sampling_presets_enabled';
  const currentlyEnabled = () => {
    const raw = authService.db.prepare('SELECT value FROM settings WHERE key=?').get(KEY)?.value;
    return raw === undefined || raw === null ? true : raw !== 'false';
  };
  async function handle(req, res, { path: p, authn }) {
    if (p === '/api/sampling-settings') {
      if (req.method === 'GET') {
        return json(res, 200, { enabled: currentlyEnabled(), presets: PRESETS, version: PRESETS_VERSION, admin: authn.user.role === 'admin' });
      }
      if (req.method === 'PUT') {
        if (authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required' });
        let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid JSON' }); }
        if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be true or false' });
        authService.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").run(KEY, String(body.enabled));
        authService.audit('sampling.autoPresets', authn.user.id, null, { enabled: body.enabled });
        return json(res, 200, { enabled: body.enabled });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }
    return PASS;
  }
  return async function samplingSettingsRoutes(req, res, ctx) {
    return (await handle(req, res, ctx)) !== PASS;
  };
}

module.exports = { createSamplingSettingsRoutes };
