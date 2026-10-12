'use strict';
// How a project or free chat picks its tools (Automatic or Manual), and what Automatic does when the
// routed model cannot take tools. Pure: the caller supplies the project record and the template check.
//
// toolsModeOf mirrors the web (noevia-web src/tools-mode.ts): an explicit toolsMode wins; without one,
// a project that holds its own toolbox list is Manual, and one without a list is Automatic. Records
// stored before toolsMode existed keep the meaning they had (a list means Manual), so reading an old
// project never changes its tool set.

/** 'auto' (Automatic: the default set, narrowed per message) or 'manual' (the project's own list). */
function toolsModeOf(project) {
  if (project && (project.toolsMode === 'auto' || project.toolsMode === 'manual')) return project.toolsMode;
  return project && Array.isArray(project.toolboxes) ? 'manual' : 'auto';
}

/** The mode a new project starts in (#1522). Automatic, unless the request chose Manual: an explicit
 *  toolsMode, or its own toolbox list (an API caller that sends a list has picked its tools by hand,
 *  and Automatic would silently ignore that list). The web sends neither, so it gets Automatic. */
function initialToolsMode(body) {
  if (body && (body.toolsMode === 'auto' || body.toolsMode === 'manual')) return body.toolsMode;
  return body && Array.isArray(body.toolboxes) ? 'manual' : 'auto';
}

// Roles tried, in order, when the routed role's model cannot take tools (#1550): Smart first, the
// model meant for tool work; then Code, then Fast. The routed role itself is never retried.
const FALLBACK_ROLES = ['smart', 'code', 'fast'];

/**
 * #1550: Automatic tools on a routed model whose chat template cannot take tools would be answered
 * without them. Keep the model when it can take tools (or when its template is unknown, which the
 * template gate allows); otherwise move the turn to the first tool-capable role model.
 *
 * @param {{ model: string, routedRole: string|null, roles: Record<string, string|null|undefined>,
 *           allowsTools: (model: string) => Promise<boolean> }} input
 * @returns {Promise<{ rerouted: boolean, model: string, role: string|null }>} `rerouted: false` keeps
 *   the routed model; the caller's template gate then sends the "answers without tools" notice.
 */
async function toolCapableRoute({ model, routedRole, roles = {}, allowsTools }) {
  if (await allowsTools(model)) return { rerouted: false, model, role: routedRole };
  for (const role of FALLBACK_ROLES) {
    const candidate = roles[role];
    if (!candidate || role === routedRole || candidate === model) continue;
    if (await allowsTools(candidate)) return { rerouted: true, model: candidate, role };
  }
  return { rerouted: false, model, role: routedRole };
}

module.exports = { toolsModeOf, initialToolsMode, toolCapableRoute, FALLBACK_ROLES };
