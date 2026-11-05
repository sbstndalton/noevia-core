'use strict';
// sbstndalton/noevia#2218: the Rust front's MCP tool executor (noevia-rs bins/noevia-server mcp_exec.rs) is held to the
// behaviour this process used to have, step for step, by tests/fixtures/mcp-exec.v1.json. That file is written from the
// frozen executor (tests/server/oracle/mcp-exec.cjs) over the real mcp.cjs transport; this test says it still is: a fresh
// run of tools/gen-mcp-exec-fixtures.cjs gives the committed bytes. The same bytes are committed in noevia-rs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'mcp-exec.v1.json');

test('the committed executor fixture is what the frozen Node executor says', { timeout: 120000 }, () => {
  const fresh = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'gen-mcp-exec-fixtures.cjs')], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  assert.equal(fresh, fs.readFileSync(FIXTURE, 'utf8'), 'regenerate: node tools/gen-mcp-exec-fixtures.cjs > tests/fixtures/mcp-exec.v1.json (and copy it to noevia-rs)');
});

test('the fixture covers every failure mode the executor has, per credential mode', () => {
  const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const ids = new Set(doc.cases.map((c) => c.id));
  for (const need of [
    'route-unknown-name', 'route-unknown-on-server', 'route-ambiguous', 'route-server-no-longer-configured', 'edit-target-refused-elsewhere',
    'auth-none', 'auth-bearer', 'auth-bearer-missing', 'auth-internal', 'auth-internal-without-a-session', 'auth-nextcloud', 'auth-nextcloud-origin-not-listed',
    'auth-directory-shared-key', 'auth-personal-key', 'auth-personal-no-key', 'auth-personal-broker-cannot-say', 'auth-oauth-token', 'auth-oauth-signed-out', 'auth-oauth-broker-cannot-say',
    'oauth-refused-then-new-token', 'oauth-refused-twice-marks-the-new-sign-in', 'oauth-refused-same-token-marks-it', 'oauth-refused-broker-cannot-say-leaves-401',
    'rate-limit-http-429-then-cooling-then-other-account', 'rate-limit-tool-error-text', 'http-500-is-a-neutral-line', 'json-rpc-error', 'reply-id-mismatch',
    'reply-over-the-body-cap', 'redirect-is-an-error', 'server-unreachable', 'event-stream-reply', 'session-closed-after-a-failed-call',
    'a-credential-header-cannot-take-over-the-session', 'result-uniform-records-are-tabulated', 'result-nested-json-is-compacted', 'operator-ignores-a-directory-twin',
  ]) assert.ok(ids.has(need), need);
  assert.ok(doc.cases.reduce((n, c) => n + c.steps.length, 0) >= 80);
});
