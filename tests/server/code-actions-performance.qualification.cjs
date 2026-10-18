'use strict';
// #1279: required, isolated qualification AFTER the full suite, one test worker.
// Every original best-of-five input and 10/50ms bound is retained; no skip mode.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const test=require('node:test');
const davParseWasm=require('../../server/dav-parse-wasm.cjs');
const ca=require('../../server/code-actions.cjs');
assert.ok(fs.existsSync(process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM),'required qualification WASM missing');
function refusal(fn) { try {fn();return null;} catch(e) {if(e instanceof davParseWasm.DavParseError)return e.reason;throw e;} }
test('find -exec chains: linear, the same answer as the former JS (frozen, by hash), and refusals fast (noevia#1212)', {}, () => {
  const call = (command) => ({ kind: 'execute', rawInput: { command }, locations: [] });
  const timed = (fn) => { let best = Infinity, out; for (let i = 0; i < 5; i++) { const t = process.hrtime.bigint(); out = fn(); best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6); } return [out, best]; };
  for (const [k, n] of [40, 64, 65, 1000, 5000].entries()) {
    process.stderr.write(`qualification_case=chain:${n}\n`);
    const c = call(`find .${' -exec find .'.repeat(n)} -print${' \\;'.repeat(n)}`);
    const [r, ms] = timed(() => davParseWasm.codeActionsClassify(ca.classifyInput(c)).text);
    // The JS classifier is gone (#1071): its answer is frozen in tests/fixtures/code-actions-js.v1.json, by sha256. The hashes are meant
    // to be re-pinned deliberately, in a reviewed commit that says why the crate's reading of these commands changed.
    const frozen = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/code-actions-js.v1.json'), 'utf8')).chains[k];
    assert.equal(crypto.createHash('sha256').update(r).digest('hex'), frozen, `${n}`);
    // Identical thresholds, isolated from concurrent suite workers (#1279).
    assert.ok(ms < (n <= 1000 ? 10 : 50), `${n} levels: ${ms} ms`);
  }
  for (const command of [`find .${' -exec find .'.repeat(64)}${' x'.repeat(20_000)}`, 'a;'.repeat(120_000), '$(a) '.repeat(30_000), 'x'.repeat(2 * 1024 * 1024)]) {
    process.stderr.write(`qualification_case=refusal:${command.length}\n`);
    const [why, ms] = timed(() => refusal(() => davParseWasm.codeActionsClassify(ca.classifyInput(call(command)))));
    assert.equal(why, 'too_large');
    assert.ok(ms < 50, `${command.length} chars: ${ms} ms`);
  }
});
