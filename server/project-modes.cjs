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

module.exports = { MODES, migrate, sanitize, enabled };
