'use strict';
// Source-only selector checks. No Docker, network, installed harness or live service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const selectorSource = fs.readFileSync(path.join(__dirname, 'native-supervisor-entrypoint.sh'), 'utf8');
const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
const image = Object.freeze({
  node: '/usr/local/bin/node',
  oldSupervisor: '/srv/supervisor.cjs',
  wasmLoader: '/srv/sandbox-bridge-wasm.cjs',
  nativeSupervisor: '/usr/local/libexec/noevia/code-sandbox-supervisor',
  sessionHelper: '/usr/local/libexec/noevia/code-sandbox-session-exec',
  opencode: '/usr/local/bin/opencode',
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-selector-'));
  const immutable = path.join(root, 'immutable');
  fs.mkdirSync(immutable);
  const files = Object.fromEntries(Object.keys(image).map((key) => [key, path.join(immutable, key)]));
  const events = path.join(root, 'events');
  fs.writeFileSync(files.node, [
    '#!/bin/sh',
    'if [ "$1" = "-e" ]; then',
    '  printf "preflight\\n" >> "$NOEVIA_TEST_EVENTS"',
    '  [ "$NOEVIA_TEST_PREFLIGHT_FAIL" = 1 ] && exit 9',
    '  exit 0',
    'fi',
    'printf "node:%s\\n" "$1" >> "$NOEVIA_TEST_EVENTS"',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o555 });
  fs.writeFileSync(files.nativeSupervisor, [
    '#!/bin/sh',
    'printf "native:%s:%s\\n" "$CODE_HARNESS_COMMAND" "$SANDBOX_BRIDGE_IMPL" >> "$NOEVIA_TEST_EVENTS"',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o555 });
  for (const key of ['sessionHelper', 'opencode', 'oldSupervisor', 'wasmLoader']) {
    fs.writeFileSync(files[key], '#!/bin/sh\nexit 0\n', { mode: 0o555 });
  }
  let selector = selectorSource;
  for (const [key, productionPath] of Object.entries(image)) {
    selector = selector.replaceAll(productionPath, files[key]);
  }
  const script = path.join(immutable, 'selector.sh');
  fs.writeFileSync(script, selector, { mode: 0o555 });
  fs.chmodSync(immutable, 0o555);
  t.after(() => {
    fs.chmodSync(immutable, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, immutable, files, events, script,
    remove(key) {
      fs.chmodSync(immutable, 0o755);
      fs.rmSync(files[key]);
      fs.chmodSync(immutable, 0o555);
    },
    run(override = {}) {
      fs.rmSync(events, { force: true });
      const result = spawnSync('/bin/sh', [script], {
        encoding: 'utf8',
        timeout: 3000,
        env: {
          PATH: '/usr/bin:/bin',
          NOEVIA_TEST_EVENTS: events,
          NOEVIA_TEST_PREFLIGHT_FAIL: '0',
          CODE_HARNESS_COMMAND: 'opencode',
          SANDBOX_BRIDGE_IMPL: 'js',
          ...override,
        },
      });
      assert.equal(result.error, undefined);
      return { ...result, events: fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n') : [] };
    },
  };
}

test('Docker source pins the native supervisor and packages the native-only verifier', () => {
  assert.match(dockerfile, /NATIVE_SUPERVISOR_RS_REF=120533acc5362a81a2c24483320534873d402f9d/);
  assert.match(dockerfile, /NATIVE_SUPERVISOR_RS_SHA256=18add3ce17a73666a3673ea16d94b5b4d88b81a204cad214ffd8a4e1cbe8026c/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /cargo build --locked --release -p code-sandbox-supervisor --bins/);
  assert.match(dockerfile, /COPY --from=native-supervisor --chmod=0555 .*code-sandbox-supervisor/);
  assert.match(dockerfile, /COPY --from=native-supervisor --chmod=0555 .*code-sandbox-session-exec/);
  assert.match(dockerfile, /COPY --chmod=0555 native-supervisor-entrypoint\.sh \/srv\/native-supervisor-entrypoint\.sh/);
  assert.match(dockerfile, /^COPY supervisor\.cjs pi-acp-bridge\.cjs \.\/$/m);
  assert.match(dockerfile, /^COPY --from=native-verifier --chmod=0555 .*code-verify-native \/usr\/local\/libexec\/noevia\/code-verify-native$/m);
  assert.doesNotMatch(dockerfile, /^COPY\b[^\n]*\bverifier\.cjs\b/m);
  assert.match(dockerfile, /CMD \["\/srv\/native-supervisor-entrypoint\.sh"\]/);
  assert.doesNotMatch(dockerfile, /^ENTRYPOINT\b/m);
  assert.match(dockerfile, /FROM node:22-bookworm-slim\s*$/m);
  assert.match(dockerfile, /ARG HARNESS_VERSION=1\.18\.31/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^EXPOSE 8030$/m);
});

test('default and explicit Node rollback exec the existing supervisor, even without native binaries', (t) => {
  const f = fixture(t);
  f.remove('nativeSupervisor');
  f.remove('sessionHelper');
  for (const mode of [undefined, 'node']) {
    const env = mode === undefined ? {} : { CODE_SANDBOX_SUPERVISOR_IMPL: mode };
    const run = f.run(env);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.events, ['node:' + f.files.oldSupervisor]);
  }
});

test('explicit Rust uses read-only fixed binaries, absolute harness, and pinned preflight', (t) => {
  const f = fixture(t);
  for (const key of ['node', 'nativeSupervisor', 'sessionHelper', 'opencode']) {
    assert.equal(fs.statSync(f.files[key]).mode & 0o222, 0);
  }
  assert.equal(fs.statSync(f.immutable).mode & 0o222, 0);
  const openCode = f.run({ CODE_SANDBOX_SUPERVISOR_IMPL: 'rust', SANDBOX_BRIDGE_IMPL: 'rust' });
  assert.equal(openCode.status, 0, openCode.stderr);
  assert.deepEqual(openCode.events, ['preflight', 'native:' + f.files.opencode + ':rust']);
  const pi = f.run({ CODE_SANDBOX_SUPERVISOR_IMPL: 'rust', SANDBOX_BRIDGE_IMPL: 'rust', CODE_HARNESS_COMMAND: 'node' });
  assert.equal(pi.status, 0, pi.stderr);
  assert.deepEqual(pi.events, ['preflight', 'native:' + f.files.node + ':rust']);
});

test('unknown selector and unreviewed harness refuse without launching either supervisor', (t) => {
  const f = fixture(t);
  for (const env of [
    { CODE_SANDBOX_SUPERVISOR_IMPL: 'auto' },
    { CODE_SANDBOX_SUPERVISOR_IMPL: '' },
    { CODE_SANDBOX_SUPERVISOR_IMPL: 'rust', SANDBOX_BRIDGE_IMPL: 'rust', CODE_HARNESS_COMMAND: 'other' },
    { CODE_SANDBOX_SUPERVISOR_IMPL: 'rust', SANDBOX_BRIDGE_IMPL: 'rust', CODE_HARNESS_COMMAND: '/tmp/harness' },
  ]) {
    const run = f.run(env);
    assert.equal(run.status, 2);
    assert.deepEqual(run.events, []);
  }
});

test('missing native binary, helper, harness, or Rust bridge never falls back to Node', (t) => {
  const f = fixture(t);
  const rust = { CODE_SANDBOX_SUPERVISOR_IMPL: 'rust', SANDBOX_BRIDGE_IMPL: 'rust' };
  for (const key of ['nativeSupervisor', 'sessionHelper', 'opencode']) {
    const original = fs.readFileSync(f.files[key]);
    f.remove(key);
    const run = f.run(rust);
    assert.equal(run.status, 2, key);
    assert.deepEqual(run.events, []);
    fs.chmodSync(f.immutable, 0o755);
    fs.writeFileSync(f.files[key], original, { mode: 0o555 });
    fs.chmodSync(f.immutable, 0o555);
  }
  const incompatible = f.run({ ...rust, SANDBOX_BRIDGE_IMPL: 'js' });
  assert.equal(incompatible.status, 2);
  assert.deepEqual(incompatible.events, []);
  const unknownBridge = f.run({ ...rust, SANDBOX_BRIDGE_IMPL: 'surprise' });
  assert.equal(unknownBridge.status, 2);
  assert.deepEqual(unknownBridge.events, []);
  const failedPreflight = f.run({ ...rust, NOEVIA_TEST_PREFLIGHT_FAIL: '1' });
  assert.equal(failedPreflight.status, 2);
  assert.deepEqual(failedPreflight.events, ['preflight']);
});

test('non-executable helper is refused before preflight or native start', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.files.sessionHelper, 0o444);
  const run = f.run({ CODE_SANDBOX_SUPERVISOR_IMPL: 'rust', SANDBOX_BRIDGE_IMPL: 'rust' });
  assert.equal(run.status, 2);
  assert.deepEqual(run.events, []);
});

test('symlinked helper is refused before preflight or native start', (t) => {
  const f = fixture(t);
  f.remove('sessionHelper');
  fs.chmodSync(f.immutable, 0o755);
  fs.symlinkSync(f.files.nativeSupervisor, f.files.sessionHelper);
  fs.chmodSync(f.immutable, 0o555);
  const run = f.run({ CODE_SANDBOX_SUPERVISOR_IMPL: 'rust', SANDBOX_BRIDGE_IMPL: 'rust' });
  assert.equal(run.status, 2);
  assert.deepEqual(run.events, []);
});
