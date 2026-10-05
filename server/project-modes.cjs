'use strict';
// Which app modes a project appears in. Chat is the only mode with routes today;
// Cowork and Code are recorded so a project can be prepared for them, and are
// enforced once those modes exist. A project always has at least one mode.
const MODES = ['chat', 'cowork', 'code'];

function migrate(project) {
  if (Array.isArray(project.modes) && project.modes.length) return false;
  project.modes = ['chat'];
  return true;
}

function sanitize(value) {
  if (!Array.isArray(value)) throw Object.assign(new Error('modes must be an array'), { status: 400 });
  const chosen = MODES.filter((mode) => value.includes(mode));
  if (value.some((mode) => !MODES.includes(mode))) throw Object.assign(new Error(`modes may only contain ${MODES.join(', ')}`), { status: 400 });
  if (!chosen.length) throw Object.assign(new Error('a project needs at least one mode'), { status: 400 });
  return chosen;
}

function enabled(project, mode) {
  return (Array.isArray(project?.modes) && project.modes.length ? project.modes : ['chat']).includes(mode);
}

// Where a chat may live (#810): a project with Chat mode that is not archived. A chat moved anywhere
// else is hidden from the sidebar and every send is refused, so framing never offers or moves into one.
function chatDestination(project) {
  return !!project && typeof project === 'object' && project.archived !== true && enabled(project, 'chat');
}

module.exports = { MODES, migrate, sanitize, enabled, chatDestination };
