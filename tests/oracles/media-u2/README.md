These are test-only copies of the pre-port Node worker implementations from Core
`9bb163f`, retained for differential fixtures and historical worker tests. Only
relative import paths changed. Production server modules never import this folder.

`generate-fixture.cjs` generates the committed synthetic candidate,
progress-window and settings fixture (`fixtures/media-u2-node.json`, copied byte for byte
to noevia-rs `crates/embedding-worker/tests/fixtures/`) with Node 22. Native execution and persistence
coverage is in the Rust `embedding-worker` crate's `media_policy` and `media_workers`
test targets. Historical tests here are oracle coverage, not proof of native ownership.
