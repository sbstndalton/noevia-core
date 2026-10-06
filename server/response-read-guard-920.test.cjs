'use strict';
// #920 guard: server code must not buffer a whole fetch reply with a bare `.text()`, `.json()`,
// `.arrayBuffer()` or `.blob()`. A remote host (provider, storage, directory, admin-chosen
// endpoint) could stream an endless body into the single web process. Use `readCappedText`,
// `readCappedJson` or `readCappedBuffer` from http.cjs with a limit that fits the reply.
//
// The heuristic is deliberately simple: every non-comment line of apps/web/server/**/*.cjs
// (tests and node_modules excluded) that calls `<identifier>.text()` / `.json()` /
// `.arrayBuffer()` / `.blob()` with no arguments is flagged unless the same file has an entry in
// response-read-guard-920.allowlist.json whose `match` text occurs on that line. Each entry needs
// a reason (usually: a fallback for a test double that is not a stream, or a reader that is
// already capped). An entry that matches no line is stale and fails too, so the list cannot rot.
// Known gap: a call split across lines, or a reply read through a differently shaped API, is not
// seen; review those by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const CALL = /\b[A-Za-z_$][\w$]*\s*\.\s*(text|json|arrayBuffer|blob)\s*\(\s*\)/;
const allowlist = JSON.parse(fs.readFileSync(path.join(ROOT, 'response-read-guard-920.allowlist.json'), 'utf8'));

function serverFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) serverFiles(full, out);
    else if (entry.name.endsWith('.cjs') && !entry.name.endsWith('.test.cjs')) out.push(full);
  }
  return out;
}

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

function scan() {
  const flagged = [];
  const used = new Set();
  for (const file of serverFiles(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (isComment(line) || !CALL.test(line)) return;
      const hit = allowlist.findIndex((e) => e.file === rel && line.includes(e.match));
      if (hit >= 0) used.add(hit);
      else flagged.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  return { flagged, used };
}

test('#920: no bare response .text()/.json()/.arrayBuffer() outside the allow-list', () => {
  const { flagged } = scan();
  assert.deepEqual(flagged, [], 'Use readCappedText/readCappedJson/readCappedBuffer from http.cjs with a fitting limit, or add a reasoned entry to response-read-guard-920.allowlist.json');
});

test('#920: every allow-list entry has a reason and still matches a line', () => {
  for (const e of allowlist) {
    assert.ok(e.file && e.match && typeof e.reason === 'string' && e.reason.length >= 20, `entry needs file, match and a reason: ${JSON.stringify(e)}`);
  }
  const { used } = scan();
  const stale = allowlist.filter((_, i) => !used.has(i)).map((e) => `${e.file}: ${e.match}`);
  assert.deepEqual(stale, [], 'stale allow-list entries; remove them');
});

test('#920: the heuristic flags the calls it is meant to flag', () => {
  for (const line of ['const b = await r.json();', 'x = (await res.text()).slice(0, 5)', 'Buffer.from(await response.arrayBuffer())', 'await upstream.json().catch(() => ({}))']) {
    assert.ok(CALL.test(line), line);
  }
  for (const line of ['JSON.stringify(x)', 'await readCappedJson(r, 1024)', 'const t = await r.text(1)']) assert.ok(!CALL.test(line), line);
  assert.ok(isComment('  // res.text() would buffer'));
});
