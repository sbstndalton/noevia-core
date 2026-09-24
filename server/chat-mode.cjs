'use strict';
// Chat / Cowork session modes (#236). A chat session runs one of two harnesses:
//   chat    the conversational turn loop (chat.cjs)
//   cowork  the code-harness task path (code-service.cjs over ACP), admin-only, needs the
//           codeHarness feature and a project with a registered repository.
// The browser decides which to try; this module is the server's authority on whether a
// `cowork` request may run at all. It never downgrades silently: a refused cowork request
// is an error the client shows, not a chat turn it did not ask for.

const MODES = new Set(['chat', 'cowork']);
const TURN_BOX_CAP = 20;

/**
 * Validate the request's `mode` and per-turn toolbox overrides.
 * @returns {{ status:number, error:string } | null}
 */
function requestShapeError(body) {
  if (body.mode !== undefined && !MODES.has(body.mode)) return { status: 400, error: 'mode must be "chat" or "cowork"' };
  if (body.turnToolboxes !== undefined) {
    const v = body.turnToolboxes;
    if (!Array.isArray(v) || v.length > TURN_BOX_CAP || v.some((id) => typeof id !== 'string' || !id || id.length > 80)) {
      return { status: 400, error: `turnToolboxes must be a list of at most ${TURN_BOX_CAP} toolbox ids` };
    }
  }
  return null;
}

/**
 * Whether a cowork request may run. Order matters: an account that could never use Cowork is
 * told so (403) before being told the server is not set up for it (409).
 * @returns {{ status:number, error:string } | null}
 */
function coworkRefusal({ authn, harnessEnabled, projectId }) {
  if (!authn || authn.user.role !== 'admin') return { status: 403, error: 'Cowork runs the coding harness, which is limited to administrators.' };
  if (!harnessEnabled) return { status: 409, error: 'Cowork needs the coding harness, which is off on this server.' };
  if (typeof projectId !== 'string' || !projectId) return { status: 409, error: 'Cowork runs inside a project; open a project chat first.' };
  return null;
}

module.exports = { MODES, TURN_BOX_CAP, requestShapeError, coworkRefusal };
