'use strict';
// Rust port track R5 (shift 2): with NOEVIA_RUST_BROWSER=1 the Rust front runs Browser tasks (start, act, approve,
// finish, cancel, the executor, the approval cards and the job store; noevia-rs crates/browser-task) and this process
// runs none. Unset (the default), nothing here changes anything.
//
// When the front owns Browser mode:
//   - browser-service.cjs never recovers a tenant's browser journals (the front's own live tasks would be marked
//     interrupted) and refuses start, act, decide, finish and cancel with REFUSED; the task reads are the front's already;
//   - the task facts bridge (rust-task-facts.cjs) answers the flag only ({ enabled: true, owner: 'front' }) and the
//     front adds its own facts;
//   - Browser mode is available when the front has a browser engine to drive (NOEVIA_BROWSER_ENGINE set), not when
//     this process has Playwright: the flag is still this process's (features.cjs), its availability the front's
//     engine. Without an engine the reason is the existing "needs a Chromium browser" one, so the panel words it as
//     today and the feature cannot be switched on.

const REFUSED = 'Browser tasks run in the native executor on this server.';
// features.cjs's Chromium reason, verbatim: its boot facts map exactly this text to 'chromium'.
const NO_ENGINE = 'Needs a Chromium browser installed for Playwright on this server.';

/** Whether the Rust front owns Browser tasks (NOEVIA_RUST_BROWSER=1). */
function frontOwnsBrowser(env = process.env) { return env?.NOEVIA_RUST_BROWSER === '1'; }

/** Why the front cannot run Browser tasks, or null when its engine is configured. */
function nativeBrowserReason(env = process.env) { return String(env?.NOEVIA_BROWSER_ENGINE || '').trim() ? null : NO_ENGINE; }

module.exports = { REFUSED, NO_ENGINE, frontOwnsBrowser, nativeBrowserReason };
