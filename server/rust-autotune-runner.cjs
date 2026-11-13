'use strict';
// sbstndalton/noevia#2516 (Rust port R6): who runs model auto-tune. AUTOTUNE_RUNNER_IMPL=rust (the web container's
// variable, read by this process and by the Rust front alike) hands the job, its state file
// native-autotune-<hash>.json, its private calibrator and its boot recovery to the front (noevia-rs
// crates/autotune-runner). This process then builds no auto-tuner, so exactly one owner ever writes the file; its
// auto-tune bridges answer { available: false } and POST /api/models/autotune is the front's. Unset or any other
// value: Node, as before. The release assembly pairs AUTOTUNE_RUNNER_OWNER with the front's capability
// (`rust-autotune-runner`) before the variable may be set.
const IMPL_ENV = 'AUTOTUNE_RUNNER_IMPL';
const AUTOTUNE_RUNNER_OWNER = 'noevia-autotune-runner-rust/1';
const frontOwnsRunner = (env = process.env) => env?.[IMPL_ENV] === 'rust';
module.exports = { IMPL_ENV, AUTOTUNE_RUNNER_OWNER, frontOwnsRunner };
