'use strict';
// tools/dockerfile-model-manager-features.cjs proves which cargo features the shipped model-manager
// binary was built with, so gen-model-manager-routes.cjs can trust the #[cfg(feature)] gates on the
// modules it reads. It must fail closed: commented-out lines, a second build, an ARG-expanded feature
// list or a copy from some other stage must never let a feature list stand in for the shipped one.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { proveFeatures } = require('../tools/dockerfile-model-manager-features.cjs');
const gen = require('../tools/gen-model-manager-routes.cjs');

const REAL = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'model-manager-dockerfile', 'services-b5e82adc.Dockerfile'), 'utf8');
const BIN = '/usr/local/bin/noevia-model-manager';
const BUILD = 'cargo build --release --locked -p gguf-meta -p noevia-model-manager --features noevia-model-manager/native-routing,noevia-model-manager/native-section-writes';
const df = ({ build = `RUN ${BUILD}`, copy = `COPY --from=gguf-meta /src/target/release/noevia-model-manager ${BIN}`, extra = '', runtimeExtra = '', tail = 'FROM runtime AS production' } = {}) => [
  'FROM rust:1 AS gguf-meta', 'WORKDIR /src', build, extra,
  'FROM debian AS runtime', runtimeExtra, copy, tail, '',
].join('\n');
const bad = (text, reason) => assert.throws(() => proveFeatures(text), reason);

test('the real services Dockerfile at b5e82adc proves native-routing and native-section-writes', () => {
  const proof = proveFeatures(REAL);
  assert.equal(proof.buildStage, 'gguf-meta');
  assert.equal(proof.noDefault, false);
  assert.ok(proof.features.includes('native-routing') && proof.features.includes('native-section-writes'));
  assert.equal(proof.features.length, 30);
});

test('a plain build is accepted; comments and continuations are read as Docker reads them', () => {
  assert.deepEqual(proveFeatures(df()).features, ['native-routing', 'native-section-writes']);
  const continued = df({ build: 'RUN cargo build --release \\\n # a comment inside the continuation\n  -p noevia-model-manager \\\n  --features noevia-model-manager/native-routing' });
  assert.deepEqual(proveFeatures(continued).features, ['native-routing']);
});

test('a second model-manager build is refused, with or without features', () => {
  bad(df({ extra: 'RUN cargo build --release -p noevia-model-manager --no-default-features' }), /second cargo build/);
  bad(df({ extra: 'RUN cargo build --release -p noevia-model-manager --features noevia-model-manager/native-routing' }), /second cargo build/);
  bad(df({ extra: 'RUN cargo build --release' }), /second cargo build/);
  bad(df({ extra: "RUN cargo build --release -p 'noevia-*'" }), /second cargo build/);
  // In the real file too: appended to the gguf-meta stage after the inference gate build.
  bad(REAL.replace('# Test-only frozen supervisor oracle', 'RUN cargo build --release -p noevia-model-manager --no-default-features\n# Test-only frozen supervisor oracle'), /second cargo build/);
});

test('a build in an ancestor stage plus a rebuild in the copied stage is two builds', () => {
  const text = ['FROM rust AS base', 'WORKDIR /src', `RUN ${BUILD}`, 'FROM base AS gguf-meta', 'RUN cargo build --release -p noevia-model-manager', 'FROM debian AS runtime',
    `COPY --from=gguf-meta /src/target/release/noevia-model-manager ${BIN}`, 'FROM runtime AS production'].join('\n');
  bad(text, /second cargo build/);
});

test('a commented-out feature build is not evidence: the real no-feature build is what counts', () => {
  const text = df({ build: `# RUN ${BUILD}\nRUN cargo build --release -p noevia-model-manager` });
  assert.deepEqual(proveFeatures(text).features, []);
  assert.throws(() => gen.enabledFeatures(text, '[features]\ndefault = []\nnative-routing = []\n'), /enables no noevia-model-manager features/);
  // A commented line in the middle of a continuation is dropped too.
  assert.deepEqual(proveFeatures(df({ build: 'RUN cargo build --release -p noevia-model-manager \\\n# --features noevia-model-manager/native-routing\n  --locked' })).features, []);
});

test('any expansion in a cargo command is refused, mixed lists included', () => {
  bad(df({ build: `RUN cargo build --release -p noevia-model-manager --features \${MM_FEATURES}` }), /expansion or glob/);
  bad(df({ build: `RUN cargo build --release -p noevia-model-manager --features noevia-model-manager/native-routing,\${MM_FEATURES}` }), /expansion or glob/);
  bad(df({ build: 'RUN cargo build --release -p noevia-model-manager --features "noevia-model-manager/native-routing,$MM_FEATURES"' }), /expansion or glob/);
  bad(df({ build: 'RUN cargo build --release -p noevia-model-manager --features `echo noevia-model-manager/native-routing`' }), /expansion or glob/);
  bad(df({ build: 'RUN cargo build --release -p noevia-model-manager --features noevia-model-manager/native-*' }), /expansion or glob/);
  bad(REAL.replace('noevia-model-manager/native-host,', 'noevia-model-manager/native-host,${MM_FEATURES},'), /expansion or glob/);
});

test('options outside the supported set, bare features and unsupported spellings are refused', () => {
  bad(df({ build: 'RUN cargo build --release -p noevia-model-manager --target x86_64-unknown-linux-musl' }), /outside the supported set/);
  bad(df({ build: 'RUN cargo build --release -p noevia-model-manager --all-features' }), /outside the supported set/);
  bad(df({ build: 'RUN cargo build --release --workspace' }), /outside the supported set/);
  bad(df({ build: 'RUN cargo build --release -p noevia-model-manager --features native-routing' }), /not a literal package\/feature/);
  bad(df({ build: 'RUN cargo install --path bins/noevia-model-manager' }), /could produce noevia-model-manager|outside the supported set/);
  bad(df({ build: 'RUN cargo +nightly build --release -p noevia-model-manager' }), /unsupported global option/);
  bad(df({ build: 'RUN cargo build --release' }), /does not name -p noevia-model-manager/);
  bad(df({ build: 'RUN cargo xtask build' }), /not understood/);
  bad(df({ build: 'RUN ["cargo", "build", "--release", "-p", "noevia-model-manager"]' }), /exec form/);
  bad(df({ build: 'RUN sh -c "cargo build --release -p noevia-model-manager --features noevia-model-manager/native-routing"' }), /could build or rewrite/);
  bad(df({ build: 'RUN make build' }), /could build or rewrite/);
  bad(df({ build: 'ENV CARGO_TARGET_DIR=/elsewhere\nRUN cargo build --release -p noevia-model-manager' }), /redirects cargo output/);
});

test('the supported spellings are read: --package=, -F, --bin, --no-default-features', () => {
  const text = df({ build: 'RUN cargo build --release --package=noevia-model-manager --bin noevia-model-manager -F noevia-model-manager/native-routing --features=noevia-model-manager/native-a,other-crate/x --no-default-features' });
  const proof = proveFeatures(text);
  assert.deepEqual(proof.features, ['native-routing', 'native-a']);
  assert.equal(proof.noDefault, true);
  const cargo = '[features]\ndefault = ["native-default"]\nnative-default = []\nnative-routing = []\nnative-section-writes = []\nnative-a = []\n';
  assert.ok(gen.enabledFeatures(df(), cargo).has('native-default'), 'defaults count when the build keeps them');
  assert.ok(!gen.enabledFeatures(text, cargo).has('native-default'), 'but not after --no-default-features');
});

test('the build must be reached unconditionally', () => {
  bad(df({ build: `RUN false || ${BUILD}` }), /conditional/);
  bad(df({ build: `RUN (${BUILD})` }), /conditional|preceded by|inside a shell construct|unsupported/);
  bad(df({ build: `RUN if true; then ${BUILD}; fi` }), /shell construct|conditional|not a plain command/);
  bad(df({ build: `RUN ${BUILD} || true` }), /followed by/);
  bad(df({ build: `RUN ${BUILD} &` }), /followed by|preceded by/);
  bad(df({ build: `RUN true; ${BUILD}` }), /conditional/);
});

test('the binary may not be rewritten after the build', () => {
  bad(df({ build: `RUN ${BUILD} && cp /bin/true target/release/noevia-model-manager` }), /could rewrite the binary/);
  bad(df({ build: `RUN ${BUILD} && ./target/release/noevia-model-manager --features > target/release/noevia-model-manager` }), /writes a file/);
  bad(df({ extra: 'RUN rm target/release/noevia-model-manager' }), /mentions the target directory or the binary/);
  bad(df({ extra: 'COPY patched /src/target/release/noevia-model-manager' }), /copies over the built binary/);
});

test('the final stage must copy the binary from the single build stage, once', () => {
  // Runtime copies from the legacy builder while an unused stage keeps a valid-looking gguf-meta copy.
  const legacy = ['FROM rust AS gguf-meta', 'WORKDIR /src', `RUN ${BUILD}`,
    'FROM rust AS legacy-builder', 'WORKDIR /src', 'RUN cargo build --release -p noevia-model-manager --features noevia-model-manager/native-host',
    'FROM debian AS runtime', `COPY --from=legacy-builder /src/target/release/noevia-model-manager ${BIN}`,
    'FROM debian AS unused', `COPY --from=gguf-meta /src/target/release/noevia-model-manager ${BIN}`,
    'FROM runtime AS production', ''].join('\n');
  // The final stage's binary is legacy-builder's, so legacy-builder's features are the ones that count.
  const proof = proveFeatures(legacy);
  assert.equal(proof.buildStage, 'legacy-builder');
  assert.deepEqual(proof.features, ['native-host']);
  const cargo = '[features]\ndefault = []\nnative-host = []\nnative-routing = []\nnative-section-writes = []\n';
  const lib = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'model-manager-routes-rs', 'lib-ok.rs'), 'utf8');
  assert.throws(() => gen.checkModuleDeclaration(lib, 'routing', gen.enabledFeatures(legacy, cargo), { file: 'lib.rs' }), /does not enable/);
  // The reviewer's variant: the unused stage is the only one that still copies from gguf-meta.
  bad(df({ copy: `COPY --from=legacy-builder /src/target/release/noevia-model-manager ${BIN}`, tail: 'FROM runtime AS production' }), /does not name a stage/);
  // Not a plain COPY --from of one file, or a second/later write to the path.
  bad(df({ extra: '', tail: `COPY --from=gguf-meta /src/target/release/noevia-model-manager ${BIN}\nFROM runtime AS production` }), /2 copies or overwrites/);
  bad(df({ tail: `FROM runtime AS production\nCOPY --from=gguf-meta /src/target/release/noevia-model-manager ${BIN}` }), /2 copies or overwrites/);
  bad(df({ tail: 'FROM runtime AS production\nADD rogue /usr/local/bin/' }), /not a plain COPY|copies or overwrites/);
  bad(df({ tail: 'FROM runtime AS production\nCOPY --from=gguf-meta /src/target/release/ /usr/local/bin/' }), /copies or overwrites/);
  bad(df({ tail: 'FROM runtime AS production\nCOPY rogue /usr/local/' }), /copies or overwrites/);
  bad(df({ tail: 'FROM runtime AS production\nRUN cp /bin/true /usr/local/bin/noevia-model-manager' }), /could replace it/);
  bad(df({ tail: 'FROM runtime AS production\nRUN ln -sf /bin/true /usr/local/bin/noevia-model-manager' }), /could replace it/);
  bad(df({ copy: `COPY --from=0 /src/target/release/noevia-model-manager ${BIN}` }), /does not name a stage/);
  bad(df({ copy: `COPY /src/target/release/noevia-model-manager ${BIN}` }), /not a plain COPY --from/);
  bad(df({ copy: `COPY --from=gguf-meta /src/target/release/other ${BIN}` }), /not the release binary/);
  bad(df({ copy: `COPY --from=gguf-meta /elsewhere/noevia-model-manager ${BIN}` }), /not the release binary/);
});

test('the final stage must inherit the copy; a different base or a late stage is refused', () => {
  bad(df({ tail: 'FROM debian AS production' }), /never copies/);
  bad(df({ tail: 'FROM gguf-meta AS production' }), /never copies|could replace it/);
  bad(df({ tail: 'FROM ${BASE} AS production' }), /unresolved base image/);
  bad(df({ tail: 'FROM runtime AS production\nONBUILD COPY x y' }), /ONBUILD/);
  bad(df({ tail: 'FROM runtime AS production\nSHELL ["/bin/sh","-c"]' }), /SHELL/);
  bad('# escape=`\n' + df(), /escape character/);
  // The copy in the final chain is the one that counts, even if the build stage is renamed away.
  bad(df().replace('AS gguf-meta', 'AS renamed'), /does not name a stage/);
});
