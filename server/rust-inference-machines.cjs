'use strict';
const MACHINES_CLIENT_MARKER = 'noevia-inference-machines-client/1';
const ROUTE_REFUSAL = Object.freeze({ error: 'Inference machines are owned by the Rust front.', code: 'RUST_INFERENCE_MACHINES_OWNED' });
module.exports = { MACHINES_CLIENT_MARKER, ROUTE_REFUSAL };
