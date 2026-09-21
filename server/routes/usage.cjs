'use strict';
// GET /api/usage            -> the signed-in account's own summary
// GET /api/usage/aggregate  -> every current account merged            admin only
//
// Returns true when it handled the request. CSRF/origin checks run before routes are mounted.
// The numbers themselves are `usage.cjs` (recording) and `usage-summary.cjs` (derivation);
// this file only decides who may ask for which scope.
const { summarizeUsage, aggregateUsage } = require('../usage-summary.cjs');

function createUsageRoutes({ readUsage, usageDayKey, retentionDays, workspace, listUsers, userDir, json }) {
  return async function usageRoutes(req, res, { path, authn }) {
    if (path !== '/api/usage' && path !== '/api/usage/aggregate') return false;
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' }), true;

    const everyone = path === '/api/usage/aggregate';
    // Another account's usage is another person's record of what they asked for.
    if (everyone && authn.user.role !== 'admin') return json(res, 403, { error: 'administrator required' }), true;

    let store, aggregate = null;
    if (everyone) {
      try {
        const result = await aggregateUsage(listUsers(), userDir);
        store = result.store;
        aggregate = { accounts: result.accounts, unreadableAccounts: result.unreadableAccounts, checkedAt: result.checkedAt };
      } catch {
        // Bounded on purpose: too many accounts, or one file too large, is a refusal rather
        // than a number that took the box down to produce.
        return json(res, 503, { error: 'Aggregate usage could not be read within its limits.' }), true;
      }
    } else {
      store = readUsage(workspace());
    }
    return json(res, 200, { ...summarizeUsage(store, { dayKey: usageDayKey, retentionDays }), ...(aggregate ? { aggregate } : {}) }), true;
  };
}

module.exports = { createUsageRoutes };
