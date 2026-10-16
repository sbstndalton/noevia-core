# Required code-actions timing qualification (#1279)

The full concurrent suite retains every chain answer and oversized-input refusal. Its timing assertions alone live in `tests/server/code-actions-performance.qualification.cjs`, invoked explicitly after the suite with `node --test --test-concurrency=1`. The core runner, shipped runtime and full web Docker build require that phase. It has no skip flag or optional module mode; missing WASM fails. All original best-of-five inputs and bounds remain: 40/64/65/1000 levels <10ms; 5000 levels and all oversized refusals <50ms. Performance still qualifies wall-clock behavior, not an assertion of dedicated CPU capacity.

Focused evidence: required qualification passed against the immutable module from rs run 38006228318 (ref eb14179c, artifact 11651252899), SHA256 `040738a438de8241bd2cd1558f2b06beaa32c5c9be01c30f09cd87cb2e978575`. Removing the actual core invocation and Docker invocation each made their own-repo guard fail (exit1); original files restored. Guards do not depend on an unmerged companion repository.

Historical #1212 negative control uses rs main-before-fix `68d8fbce93309ea30bca99e4b0c795e99b9bddd4`, run37983041912 artifact11642226463, module SHA256 `68cf8a00c86f436fd5c5a5bbcc22ae3f9071c77b100e2b584ef19594ed488a9d`. Matching core oracle `263aff90c7f7d1f204f9a54a16a569a1e00b9739` archive SHA256 `25a50c790c9a4ede298825e518f3519681c29a9a8ecc54c5341c63d6a664f779` was twice fetched byte-identically. `node tools/qualification/old-module-control.cjs <isolated-old-core> <old-wasm>` first proved a valid small classifier answer equals Node, then rejected the actual 40-level chain qualification within a bounded 2s child process. It never accepts missing-module/checksum/ABI/startup failure as the control. Artifact reuse avoids rebuilding unchanged historical code; if expired, the old module can be reproduced with that immutable rs source's build script. Synthetic classifier strings only, no command execution or live state.

# Front route qualifications after the handoff (#1071)

The candidate-core front qualifications (`reasoning-front.yml`, `routing-mode.yml` with its
`routing-acceptance` tool, and the candidate replays in `usage-front.yml`, `sampling-front.yml` and
`stats-front.yml` with the `reasoning-acceptance` adapter) were retired with the Node handlers in
sbstndalton/noevia#1071: the usage, sampling, reasoning-default PUT, routing configuration, routing
default and engine statistics routes are the Rust front's permanently, and Node refuses them
unconditionally (`server/routes/front-owned-routes.test.cjs`, `routes/models.test.cjs`,
`routes/reasoning-settings.test.cjs`, `routing-modes.test.cjs`). The three required gates keep
their names and now run the native contracts against the Node oracle pinned at core `a11598b`, the
last core main with those handlers, plus the candidate's refusal tests.
