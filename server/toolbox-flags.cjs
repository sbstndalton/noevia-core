'use strict';
// One definition of "this toolbox ships with noevia" (#615), shared by every server path that
// hands toolboxes to the client: GET /api/toolboxes (the model popup and picker), GET
// /api/toolboxes/permitted (the composer tools menu), and the chat turn's `tools_scope` event.
// The client words an in-app box from its catalogue by id, so a path that leaves the flag out
// silently shows English. A box is in-app when it is built in, or curated in the MCP manifest
// (bindBoxes stamps `inApp: true`); a box a third party defined is never one.

/** @param {{ source?: string, inApp?: boolean }|null|undefined} box */
function isInAppBox(box) {
  return !!box && (box.source === 'builtin' || box.inApp === true);
}

/** Boxes named by the MCP manifest but not discovered right now are still ones noevia curates. */
const isManifestBoxInApp = () => true;

module.exports = { isInAppBox, isManifestBoxInApp };
