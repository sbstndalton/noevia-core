'use strict';
// gate.sh fails closed: any read it cannot do counts as busy. `docker` and `stat` are stubbed on PATH.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GATE = path.join(__dirname, 'gate.sh');
const hasJq = spawnSync('jq', ['--version']).status === 0;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-gate-'));
  const bin = path.join(dir, 'bin'), state = path.join(dir, 'state');
  fs.mkdirSync(bin); fs.mkdirSync(state);
  // docker logs <opts> NAME: fails for $STUB_LOGS_FAIL, prints $STUB_WEB_LOG for the web container.
  // docker stats <opts> NAME: fails when $STUB_STATS_FAIL=1, else prints $STUB_CPU (default 0.10%).
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
name="\${@: -1}"
case "$1" in
  logs) [ "$name" = "\${STUB_LOGS_FAIL:-}" ] && { echo "Error: No such container: $name" >&2; exit 1; }
        [ "$name" = web ] && printf '%s' "\${STUB_WEB_LOG:-}"; exit 0 ;;
  stats) [ "\${STUB_STATS_FAIL:-}" = 1 ] && exit 1; echo "\${STUB_CPU:-0.10%}"; exit 0 ;;
esac
exit 2
`, { mode: 0o755 });
  // stat -c %Y FILE: fails when $STUB_STAT_FAIL=1, else an mtime long ago.
  fs.writeFileSync(path.join(bin, 'stat'), '#!/bin/bash\n[ "${STUB_STAT_FAIL:-}" = 1 ] && exit 1\necho "${STUB_MTIME:-1000}"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(state, 'native-autotune-x.json'), JSON.stringify({ job: { status: 'failed' } }));
  fs.writeFileSync(path.join(state, 'system-one-decisions.jsonl'), '{}\n');
  const meminfo = path.join(dir, 'meminfo');
  fs.writeFileSync(meminfo, 'MemTotal:       31141888 kB\nMemAvailable:   12582912 kB\n');
  return { bin, state, meminfo };
}

function gate(env = {}) {
  const { bin, state, meminfo } = setup();
  const r = spawnSync('bash', [GATE], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, STATE_DIR: state, MEMINFO: meminfo,
    WEB_CONTAINER: 'web', ENGINE_CONTAINER: 'engine', CODE_CONTAINERS: 'code', ...env } });
  const line = r.stderr.trim().split('\n').at(-1);
  return { code: r.status, verdict: JSON.parse(line) };
}

test('idle when every read succeeds and nothing is running', { skip: !hasJq && 'jq is not installed' }, () => {
  const r = gate();
  assert.equal(r.code, 0);
  assert.deepEqual(r.verdict, { idle: true, availableGiB: 12 });
});

test('a failed docker logs is busy, not idle (web and engine)', { skip: !hasJq && 'jq is not installed' }, () => {
  assert.deepEqual([gate({ STUB_LOGS_FAIL: 'web' }).code, gate({ STUB_LOGS_FAIL: 'web' }).verdict.check], [1, 'chat']);
  assert.deepEqual([gate({ STUB_LOGS_FAIL: 'engine' }).code, gate({ STUB_LOGS_FAIL: 'engine' }).verdict.check], [1, 'engine']);
});

test('a failed stat is busy', { skip: !hasJq && 'jq is not installed' }, () => {
  const r = gate({ STUB_STAT_FAIL: '1' });
  assert.equal(r.code, 1);
  assert.equal(r.verdict.check, 'autotune');
  assert.match(r.verdict.detail, /cannot stat/);
});

test('a failed docker stats, an unreadable CPU figure or meminfo is busy', { skip: !hasJq && 'jq is not installed' }, () => {
  assert.equal(gate({ STUB_STATS_FAIL: '1' }).verdict.check, 'coding');
  assert.equal(gate({ STUB_CPU: '--' }).verdict.check, 'coding');
  const r = gate({ MEMINFO: '/nonexistent/meminfo' });
  assert.deepEqual([r.code, r.verdict.check], [1, 'memory']);
});

test('the real signals still close it: chat lines, a running tune, recent writes, CPU, memory', { skip: !hasJq && 'jq is not installed' }, () => {
  assert.equal(gate({ STUB_WEB_LOG: '[system-one] route {"selected":"fast"}\n' }).verdict.check, 'chat');
  assert.equal(gate({ STUB_MTIME: String(Math.floor(Date.now() / 1000)) }).verdict.check, 'autotune');
  assert.equal(gate({ STUB_CPU: '42.5%' }).verdict.check, 'coding');
  assert.equal(gate({ MIN_AVAILABLE_GB: '16' }).verdict.check, 'memory');
  const { bin, state, meminfo } = setup();
  fs.writeFileSync(path.join(state, 'native-autotune-x.json'), JSON.stringify({ job: { status: 'running' } }));
  const r = spawnSync('bash', [GATE], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, STATE_DIR: state, MEMINFO: meminfo, WEB_CONTAINER: 'web', ENGINE_CONTAINER: 'engine', CODE_CONTAINERS: 'code' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"check":"autotune","detail":"native-autotune-x.json running"/);
});

test('a missing state directory is busy', { skip: !hasJq && 'jq is not installed' }, () => {
  assert.equal(gate({ STATE_DIR: '/nonexistent/state' }).verdict.check, 'autotune');
});
