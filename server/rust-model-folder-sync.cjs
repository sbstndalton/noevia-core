'use strict';
// The models folder sync is the Rust front's (noevia-rs bins/noevia-server src/model_folder_sync, built with the
// `rust-model-folder-sync-v1` capability). A GGUF that appears in the models folder is registered with safe defaults
// through the model management service, and the engine's presets are reloaded once, by the front: this process no longer
// scans, registers or reloads for it, so there is never a second worker (a double registration) and, paired, never none.
//
// Nothing is served here. The front takes the same exclusion every other maintenance job takes (the inference gate's
// maintenance hold, or a lease on this process's maintenance gate, model-maintenance-lease.cjs), so a calibration, an
// auto-tune or a chat-bound maintenance job of this process keeps it from writing models.ini, and its registrations and
// its reload wait for them. The web supervisor and release assembly pair this module (its require in index.cjs) with the
// front's capability in both directions.
const RUST_MODEL_FOLDER_SYNC_OWNED = 'rust-model-folder-sync-v1';
module.exports = Object.freeze({ RUST_MODEL_FOLDER_SYNC_OWNED });
