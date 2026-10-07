# noevia-core

The noevia Node server (`server/`), its tests (`tests/server/`, `tests/fixtures/`), the shared
`contracts/` (owned here; noevia-web consumes a pinned copy) and the code sandbox
(`code-sandbox/`, built as the code-sandbox sidecar image).

Split out of [sbstndalton/noevia](https://github.com/sbstndalton/noevia) `apps/web/server`,
`apps/web/contracts`, `apps/web/tests/{server,fixtures}` and `services/code-sandbox` by
`tools/repo-split` (issue #952, ADR 0001). Every file except this README and `.github/` is noevia
history filtered to those paths; the last commit names the noevia SHA it was cut from
(`Split-Source:`).

**Until the cutover in `docs/repo-split-cutover.md` (in noevia) is done, noevia is still the source
of truth.** This repo is re-extracted at the cut SHA and force-replaced, so do not commit here yet.

New server work is Rust (ADR 0001, owner rule of 2026-10-06); the Node server here keeps running
until it is replaced slice by slice. Tenant scope, auth, CSRF and all three write-approval actions
(Allow once, Decline, Allow for this chat) stay in this server.

## CI

`.github/workflows/ci.yml` builds a noevia-shaped workspace (noevia `main` for the integration
files, noevia-web and noevia-services `main`, this checkout on top) and runs the server tests
(including the root-only verifier test), the code-sandbox bridge tests and the web image build.
