// Auto routing stores model names, and presets change underneath them. A role pointing at a model
// the engine no longer serves would fail every Auto turn with an upstream error, so the chat route
// and the settings page check the roles against the served catalogue first.
const LABELS = { fast: 'Fast', smart: 'Smart', vision: 'Vision', code: 'Code' };

/** Roles whose model is not in `installed`. An unknown catalogue (null) never reports anything. */
function missingRoles(roles, installed) {
  if (!roles || !Array.isArray(installed)) return [];
  const names = new Set(installed.map((m) => m.name));
  return Object.keys(LABELS).filter((role) => roles[role] && !names.has(roles[role])).map((role) => ({ role, model: roles[role] }));
}

function staleRolesError(missing) {
  if (!missing.length) return null;
  const list = missing.map(({ role, model }) => `${LABELS[role]} (${model})`).join(', ');
  return `Auto routing uses models that are no longer installed: ${list}. Choose new ones in Settings → Models & routing.`;
}

module.exports = { missingRoles, staleRolesError };
