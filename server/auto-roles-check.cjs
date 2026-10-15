// Auto routing stores model names, and presets change underneath them. A role pointing at a model
// the engine no longer serves would fail every Auto turn with an upstream error, so the chat route
// and the settings page check the roles against the served catalogue first.
const LABELS = { fast: 'Fast', smart: 'Smart', vision: 'Vision', code: 'Code', creative: 'Creative' };

/** Roles whose model is not in `installed`. An unknown catalogue (null) never reports anything. */
function missingRoles(roles, installed) {
  if (!roles || !Array.isArray(installed)) return [];
  // #545: a preset whose model file is gone is listed but cannot be served, so it counts as missing.
  const names = new Set(installed.filter((m) => !m.missingFile).map((m) => m.name));
  return Object.keys(LABELS).filter((role) => roles[role] && !names.has(roles[role])).map((role) => ({ role, model: roles[role] }));
}

function staleRolesError(missing) {
  if (!missing.length) return null;
  const list = missing.map(({ role, model }) => `${LABELS[role]} (${model})`).join(', ');
  return `Auto routing uses models that are no longer installed: ${list}. Choose new ones in Settings → Models & routing.`;
}

const NOT_CHAT = /^(embedding|embeddings|rerank|reranking|reranker)$/i;

/** #1816: true when moving a creative turn to the Creative model costs no model swap: the Creative model is loaded, or no
 *  chat model is. Unknown loaded state (no catalogue) keeps the router's pick, so this is false. */
function creativeMoveIsFree(roles, routedRole, installed) {
  if (!roles?.creative || !Array.isArray(installed)) return false;
  if (roles[routedRole] === roles.creative) return true;
  const loaded = installed.filter((m) => m && m.loaded && !(m.labels || []).some((l) => NOT_CHAT.test(l))).map((m) => m.name);
  return loaded.length === 0 || loaded.includes(roles.creative);
}

module.exports = { missingRoles, staleRolesError, creativeMoveIsFree };
