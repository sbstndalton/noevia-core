'use strict';
// #2387 (G2): marker of the preset-facts pair. A Core that carries this file reads models.ini (parse,
// editor limit, revision, defaults, field names) only through the native reader, dav-parse.wasm ops 5
// and 6, which is the code the Rust front answers GET /api/models/preset and checks its conditional
// writes with. It has no facts bridge: a front that asks Node for facts would be a second authority.
// The supervisor and the release assembly pair this file with the front's `rust-preset-facts`
// capability, so a front that reads models.ini itself never runs beside a Core that parses its own.
const PROTOCOL = 'noevia-preset-facts/1';
// The wasm exports Core's preset store calls, and the only way it reads facts.
const NATIVE_EXPORTS = Object.freeze(['llamacppPresetsParse', 'llamacppPresetsFacts']);
/**
 * Boot check: the pinned module has the native reader. A module from before ops 5 and 6 would fail
 * every preset read with 503, so startup stops instead (the checksum pin cannot tell the two apart
 * from the Core source that calls them).
 */
function verifyNative(dav) {
  for (const name of NATIVE_EXPORTS) {
    if (typeof dav[name] !== 'function') throw new Error(`${PROTOCOL}: dav-parse.wasm wrapper has no ${name}`);
  }
  try {
    const empty = dav.llamacppPresetsFacts('', '');
    if (empty.exists !== false) throw new Error('an empty text has no sections');
  } catch (err) {
    throw new Error(`${PROTOCOL}: dav-parse.wasm lacks the native preset reader (${err.reason || err.message})`);
  }
}
module.exports = { PROTOCOL, NATIVE_EXPORTS, verifyNative };
