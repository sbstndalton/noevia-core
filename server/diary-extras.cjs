'use strict';
const { frameUntrusted } = require('./prompt-framing.cjs');
const PROJECT_ID = 'cowork-diary-extras';
const REFERENCE_LIMIT = 12000;
// The framed block, markers included, stays within the Diary's reference limit.
// Computed on first use, not at load: framing is Rust, and a missing module must stop startup with
// its own message (dav-parse-wasm.cjs verifyAtStartup), not crash this require.
let frameOverhead = null;
const FRAME_OVERHEAD = () => (frameOverhead ??= frameUntrusted('Diary attachment excerpts', '', '').length);
function reference(body) {
  return body?.extrasEnabled === true && typeof body.extraContext === 'string' ? frameUntrusted('Diary attachment excerpts', '', body.extraContext.slice(0, REFERENCE_LIMIT - FRAME_OVERHEAD())) : '';
}
function chatProjectId(chatId) {
  return typeof chatId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(chatId) ? 'cowork-chat-context-' + chatId : null;
}
function internalProject(project) { return project.id === PROJECT_ID || project.id.startsWith('cowork-chat-context-'); }
// (The Diary attachments project itself is made by the Rust front, #2206: noevia-rs crates/server-projects
// `diary_context`, which holds this module's former `newProject()`.)
module.exports = { PROJECT_ID, REFERENCE_LIMIT, reference, chatProjectId, internalProject };
