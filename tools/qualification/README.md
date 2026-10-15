# Required code-actions timing qualification (#1279)

The full concurrent suite retains every chain answer and oversized-input refusal. Its timing assertions alone live in `tests/server/code-actions-performance.qualification.cjs`, invoked explicitly after the suite with `node --test --test-concurrency=1`. The core runner, shipped runtime and full web Docker build require that phase. It has no skip flag or optional module mode; missing WASM fails. All original best-of-five inputs and bounds remain: 40/64/65/1000 levels <10ms; 5000 levels and all oversized refusals <50ms. Performance still qualifies wall-clock behavior, not an assertion of dedicated CPU capacity.

Focused evidence: required qualification passed against the immutable module from rs run 38006228318 (ref eb14179c, artifact 11651252899), SHA256 `040738a438de8241bd2cd1558f2b06beaa32c5c9be01c30f09cd87cb2e978575`. Removing the actual core invocation and Docker invocation each made their own-repo guard fail (exit1); original files restored. Guards do not depend on an unmerged companion repository.

Historical #1212 negative control uses rs main-before-fix `68d8fbce93309ea30bca99e4b0c795e99b9bddd4`, run37983041912 artifact11642226463, module SHA256 `68cf8a00c86f436fd5c5a5bbcc22ae3f9071c77b100e2b584ef19594ed488a9d`. Matching core oracle `263aff90c7f7d1f204f9a54a16a569a1e00b9739` archive SHA256 `25a50c790c9a4ede298825e518f3519681c29a9a8ecc54c5341c63d6a664f779` was twice fetched byte-identically. `node tools/qualification/old-module-control.cjs <isolated-old-core> <old-wasm>` first proved a valid small classifier answer equals Node, then rejected the actual 40-level chain qualification within a bounded 2s child process. It never accepts missing-module/checksum/ABI/startup failure as the control. Artifact reuse avoids rebuilding unchanged historical code; if expired, the old module can be reproduced with that immutable rs source's build script. Synthetic classifier strings only, no command execution or live state.

# Candidate native reasoning qualification (#1320)

`reasoning-front.yml` adds one required gate to the existing six. Its immutable
merged Rust input is fa8661143c9b3b55f5e7d111ff458254424ddb42 (noevia-rs#112, core#126 corpus, #1806),
archive SHA256 9d011cb54e46479b729723a9482e79131d87ed2df0092728b41b3f33112716a6.
Its corpus records core 885e625cddd1af99e23d892505f4e1eeb87608db (contracts/http/core.ref,
recorded with NOEVIA_CONTRACT_FIXED_NOW); the candidate core is separately the exact
workflow checkout HEAD, clean and descended from 885e625. The launch template at c90210ee
carries the launcher's `__PROMPTS_OVERRIDE__` slot, which the adapter fills with nothing,
as the merged launcher does outside its prompts modes. Earlier input: 592d94a7, archive
74be654e, corpus core 641917e2.
The merged Rust launcher and its core.ref enforcement remain unchanged.

The separately named Rust `core-acceptance` adapter verifies the immutable
archive and three exact host input/spawn/verification template hashes. It emits
those original templates with the actual candidate paths. The only compatibility
shim is an explicit three-line `corpus-launcher` script in an isolated acceptance
bin directory; it delegates to `core-acceptance`, with the original native/replay
binaries symlinked alongside it. The unchanged host-control binary is copied
so its current_exe sibling lookup resolves this declared acceptance directory. It neither replaces nor edits the merged launcher.
Artifact provenance records candidate HEAD, fixture core, Rust input, template,
adapter and shim hashes. There is no production runtime change or release pin.

The actual candidate52-case route/SQLite oracle must equal the immutable merged
cases. The actual candidate full193 Node/native exchanges and final state must
match; valid native identity with omitted reasoning capability must refuse all
three PUTs without setting/audit writes. Strict UTC365 request anchors and fixed
8 GiB input remain required. Wrong12GiB input must change exactly three strict
budget fields; missing preload, wrong candidate SHA and altered immutable template
must decisively fail their specific assertions. Missing dependency/startup failure
cannot qualify those negative controls. Existing usage/sampling/OCR inputs and
WASM040738 remain intact. Owner flags remain default off.

# Native engine statistics front qualification (#1650)

`stats-front.yml` qualifies Node's half of GET /api/stats moving to the Rust front
(`statsRustOwned` in `server/routes/models.cjs`). Its native source is the noevia-rs#112 merge
commit fa8661143c9b3b55f5e7d111ff458254424ddb42 (carries #98 and the core#126 corpus), archive SHA-256
9d011cb54e46479b729723a9482e79131d87ed2df0092728b41b3f33112716a6 (twice fetched,
byte-identical). The same archive still feeds the
`core-acceptance` adapter unchanged. The gate requires:

- the candidate core's own handler (rs `crates/server-stats/tests/oracle.cjs`, run on this HEAD)
  to give every committed native case's exact status and body;
- the native crate and front tests;
- the full corpus replay through the front with `NOEVIA_RUST_AUTH=1 NOEVIA_RUST_STATS=1`;
- the omission control: with the front's switch removed but Node confirmed, every GET /api/stats
  is 503 while native setup still answers 201, and nothing else differs.

No production runtime change or release pin; the switch stays off.
