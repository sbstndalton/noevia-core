'use strict';

// Code actions (CODE_ACTIONS_IMPL, retired in #1071: always Rust).
// tests/fixtures/code-actions.v1.json (byte-identical to noevia-rs crates/code-actions/tests/fixtures/; CI compares
// them) holds the port's exact reply text for synthetic calls; for every row the port answers, that text IS what the
// former JS returned (the generator printed it from the JS). A row the port refuses (`refused`) has no JS answer there:
// tests/fixtures/code-actions-js.v1.json freezes it, and the JS answers for the seeded calls below, the find -exec chains
// and the oversized commands. Both files are frozen and sha256-pinned: the JS classifier and its generator are gone, and
// neither may be regenerated through the Rust path (that would erase the independent reference). The JS answers were
// frozen from noevia-core at e70151f (git archive) with the dav-parse.wasm that server/dav-parse.lock pins
// (sha256 c5c300907dba8ed36b38bbfcd92dc33f18be77319712504106abb09d5b8ce05b); the freeze script is not kept.
// Here every row runs through dav-parse.wasm's code_actions and through the functions code-harness.cjs calls. The old
// composition was the JS answer made stricter by the port; with the JS gone the port decides alone, so what must hold,
// and is counted below, is that nothing is weaker than the frozen JS answer (a class less consequential, an approval
// weaker, a standing approval or a plain-network reading the JS withheld, a decision that allows what the JS asked
// about), that the answers the port gives are the JS ones byte for byte, and that what the port refuses is put strictly here
// (classify: the unverified classification, never allowed or stood behind; decide: ask a person, as the wasm composition did;
// pickOption: cancel). The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const ca = require('../../server/code-actions.cjs');

const FILE = path.join(__dirname, '../fixtures/code-actions.v1.json');
const FROZEN_FILE = path.join(__dirname, '../fixtures/code-actions-js.v1.json');
// The frozen references are pinned: changing either is a deliberate act that also changes these.
const PINS = { [FILE]: 'af97068f9869d21f0888d5893311e7e4993fbb5450810e2e7ac9b3387c453edf', [FROZEN_FILE]: '826f9e5aed83ef1e4b5e301c07c3e84ae4059752f84b42791ac0f6c6899e0ec0' };
const FROZEN = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

// Guards a wrong test signature (options passed twice makes node:test take the second object as the body, so the body never
// runs and the test reports ok): when the module is there, every guarded body must have run.
let ran = 0;
test.after(() => { if (!skipWasm) assert.equal(ran, 5, 'a wasm-guarded test body did not run'); });
const RANK = { allow: 0, ask: 1, deny: 2 };
function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}
const refusal = (fn) => {
  try { fn(); return null; } catch (err) { if (err instanceof davParseWasm.DavParseError) return err.reason; throw err; }
};
/** A call classify() reads exactly as the projection says (classifyInput is not idempotent on locations). */
const callOf = (p) => ({ kind: p.kind, rawInput: p.rawInput, locations: p.locations.map((l) => (l === null ? null : { path: l })) });

const text = (i) => FROZEN.texts[i];
const DECISIONS = ['allow', 'ask', 'deny'];
const frozenDecision = ([d, r]) => ({ decision: DECISIONS[d], reason: text(r) });
const SEVERITY = ['external_account', 'git_push', 'delete', 'open_browser', 'install_dependency', 'execute_command', 'network', 'edit_file', 'read_repository', 'none'];
const APPROVAL = { never: 0, capability: 1, always: 2 };
const tally = (t, key) => { t[key] = (t[key] || 0) + 1; };
/** Why `now` is weaker than the frozen JS classification (an empty list: it is not). */
function weakerClassification(js, now) {
  const why = [];
  if (SEVERITY.indexOf(now.action) > SEVERITY.indexOf(js.action)) why.push('action');
  if (APPROVAL[now.approval] < APPROVAL[js.approval]) why.push('approval');
  if (now.standable && !js.standable) why.push('standable');
  if (now.simple && !js.simple) why.push('simple');
  if (now.readable && !js.readable) why.push('readable');
  return why;
}
function relateClassification(js, now, where) {
  const why = weakerClassification(js, now);
  assert.deepEqual(why, [], `${where}: weaker than the JS (${why})`);
  return JSON.stringify(js) === JSON.stringify(now) ? 'same' : now.unverified === true ? 'port-refused->unverified' : 'other';
}
function relateDecision(js, now, where) {
  assert.ok(RANK[now.decision] >= RANK[js.decision], `${where}: ${js.decision} became ${now.decision}`);
  if (now.decision !== js.decision) return `${js.decision}->${now.decision}`;
  return now.reason === js.reason ? `${js.decision} same` : `${js.decision} same decision, other words`;
}

test('the fixture files are frozen and pinned, line up, and no JS classifier, switch or generator remains', () => {
  for (const [file, pin] of Object.entries(PINS)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), pin, path.basename(file));
  assert.equal(FROZEN.version, 1);
  assert.equal(FROZEN.seeded.classify.length, 2000);
  assert.equal(FROZEN.seeded.decide.length, 12000);
  assert.deepEqual(Object.keys(ca).sort(), ['ACTIONS', 'COMMAND_KEYS', 'UNVERIFIED_ASK', 'classify', 'classifyInput', 'commandOf', 'decide', 'decideInput', 'pickInput', 'pickOption']);
  assert.ok(!fs.existsSync(path.join(__dirname, '../../tools/gen-code-actions-fixtures.cjs')));
});

test('classify rows: the port replies as the file says (the JS answer); the function code-harness calls returns it, or the unverified classification', { skip: skipWasm }, () => {
  ran++;
  assert.ok(fixtures.classify.length >= 1000);
  const seen = {};
  for (const [i, row] of fixtures.classify.entries()) {
    const [projection] = JSON.parse(row.wire);
    const call = callOf(projection);
    const now = quietly(() => ca.classify(call));
    if (row.want !== undefined) {
      assert.equal(davParseWasm.codeActionsClassify(projection).text, row.want, `row ${i}`);
      assert.deepEqual(now, JSON.parse(row.want), `row ${i} (the JS answer)`);
      tally(seen, 'same');
    } else {
      assert.equal(refusal(() => davParseWasm.codeActionsClassify(projection)), row.refused, `row ${i} refused`);
      const js = JSON.parse(text(FROZEN.classifyRefused[i]));
      tally(seen, relateClassification(js, now, `row ${i}`));
      assert.equal(now.unverified, true, `row ${i}`);
    }
  }
  assert.equal(Object.keys(FROZEN.classifyRefused).length, fixtures.classify.filter((r) => r.refused !== undefined).length);
  assert.deepEqual(seen, {"same":1082,"port-refused->unverified":5});
});

test('decide rows: the same decision and reason; a refused row is denied, never less than the frozen JS decision', { skip: skipWasm }, () => {
  ran++;
  assert.ok(fixtures.decide.length >= 3000);
  const seen = {};
  for (const [i, row] of fixtures.decide.entries()) {
    const [classified, capabilities, domains, inWorkspace] = JSON.parse(row.wire);
    const input = { classified, capabilities, domains, inWorkspace };
    const now = quietly(() => ca.decide(input));
    if (row.want !== undefined) {
      assert.equal(davParseWasm.codeActionsDecide(classified, capabilities, domains, inWorkspace).text, row.want, `row ${i}`);
      assert.deepEqual(now, JSON.parse(row.want), `row ${i} (the JS answer)`);
      tally(seen, `${now.decision} same`);
    } else {
      assert.equal(refusal(() => davParseWasm.codeActionsDecide(classified, capabilities, domains, inWorkspace)), row.refused, `row ${i} refused`);
      tally(seen, relateDecision(frozenDecision(FROZEN.decideRefused[i]), now, `row ${i}`));
    }
  }
  assert.equal(Object.keys(FROZEN.decideRefused).length, fixtures.decide.filter((r) => r.refused !== undefined).length);
  assert.deepEqual(seen, {"ask same":2043,"deny same":1215,"allow same":133,"ask same decision, other words":25,"allow->ask":3});
});

test('pick rows: the same option', { skip: skipWasm }, () => {
  ran++;
  for (const [i, row] of fixtures.pick.entries()) {
    const [options, wanted] = JSON.parse(row.wire);
    assert.equal(davParseWasm.codeActionsPick(options, wanted).text, row.want, `row ${i}`);
    assert.deepEqual(ca.pickOption(options, wanted), JSON.parse(row.want), `row ${i}`);
  }
});

// Seeded live calls: the fixture vocabulary plus non-ASCII text and URL hosts the port refuses.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CERTAIN_URLS = ['https://example.com/x', 'http://evil.test:8080', 'https://u:p@api.example.com', 'http://1.2.3.4/', 'HTTP://EXAMPLE.COM', 'http://'];
const UNSURE_URLS = ['https://b\u00fccher.example', 'http://\u1e9e.io', 'https://xn--n3h.example', 'http://0x7f.1', 'http://[::1]', 'http://a..b',
  'https://\u0441\u0430\u0439\u0442.example', 'http://example.com.', 'http://ex%61mple.com', 'https://\uff45xample.com'];
const WORDS = ['ls', 'cat', 'echo', 'rm', 'git', 'push', 'curl', '-q', 'wget', '-qO-', 'npm', 'install', 'sh', '-c', 'eval', 'find', '-exec',
  '{}', ';', 'xargs', 'sudo', 'env', 'FOO=1', '$X', '>', 'out', '|', '&&', '$(', ')', '`', '"', "'", '\\', '\u00e9\u00e8', '\u65e5\u672c\u8a9e',
  '\u0410\u0411', '\ud83d\ude00', '\ud800', '\u00a0', '\u2028', '\u3000', '\ufeff', '\u0301', 'git-push', '-c', 'alias.x=push', 'http.proxy=x'];

test('seeded live calls: classification is the JS one; no decision is weaker than the JS one, and every kind of difference is counted', { skip: skipWasm }, () => {
  ran++;
  const rand = mulberry32(0x5eed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const seen = {};
  let at = 0;
  for (let n = 0; n < 2000; n++) {
    const parts = [];
    for (let k = 1 + Math.floor(rand() * 8); k > 0; k--) {
      const r = rand();
      if (r < 0.12) { const u = pick(UNSURE_URLS); parts.push(u); } else if (r < 0.3) parts.push(pick(CERTAIN_URLS)); else parts.push(pick(WORDS));
    }
    const call = { kind: pick(['execute', 'execute', 'fetch', 'other', 'read']), rawInput: { command: parts.join(' ') }, locations: [] };
    const js = JSON.parse(text(FROZEN.seeded.classify[n]));
    // classify never refuses on text: it is the JS answer.
    assert.deepEqual(ca.classify(call), js, JSON.stringify(call));
    for (const domains of [['example.com'], ['example.com', 'evil.test', '1.2.3.4'], []]) {
      for (const classified of [js, { ...js, approval: 'capability', simple: true }]) {
        const input = { classified, capabilities: [], domains, inWorkspace: null };
        const want = frozenDecision(FROZEN.seeded.decide[at++]);
        tally(seen, relateDecision(want, quietly(() => ca.decide(input)), `call ${n}`));
      }
    }
  }
  assert.equal(at, 12000);
  assert.deepEqual(seen, {"ask same decision, other words":2635,"allow same":2139,"ask same":6960,"allow->ask":266});
});

// The chain pins are sha256 of the former JS answer. They are meant to be re-pinned deliberately: if the crate's reading of these
// commands is ever supposed to change, change the hash in a reviewed commit that says why, never to make a failing run pass.
test('find -exec chains: the port gives the JS answer (by hash); oversized commands are refused, and the call is unverified, never weaker', { skip: skipWasm }, () => {
  ran++;
  const call = (command) => ({ kind: 'execute', rawInput: { command }, locations: [] });
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  [40, 64, 65, 1000, 5000].forEach((n, k) => {
    const c = call(`find .${' -exec find .'.repeat(n)} -print${' \\;'.repeat(n)}`);
    const r = davParseWasm.codeActionsClassify(ca.classifyInput(c)).text;
    assert.equal(sha(r), FROZEN.chains[k], `${n}`);
    assert.deepEqual(ca.classify(c), JSON.parse(r));
  });
  const commands = [`find .${' -exec find .'.repeat(64)}${' x'.repeat(20_000)}`, 'a;'.repeat(120_000), '$(a) '.repeat(30_000), 'x'.repeat(2 * 1024 * 1024)];
  commands.forEach((command, k) => {
    const frozen = FROZEN.big[k];
    const trimmed = command.trim(); // commandOf trims, so the classification carries the trimmed text
    assert.equal(trimmed.length, frozen.commandLength);
    assert.equal(sha(trimmed), frozen.commandSha256, 'the same command the JS was frozen on');
    const why = refusal(() => davParseWasm.codeActionsClassify(ca.classifyInput(call(command))));
    assert.equal(why, 'too_large');
    const now = quietly(() => ca.classify(call(command)));
    const { commandLength, commandSha256, ...js } = frozen;
    assert.deepEqual(weakerClassification(js, now), []);
    assert.equal(now.unverified, true);
    assert.equal(now.command, trimmed, 'the command text is kept for the card');
    assert.equal(now.standable, false);
    const d = ca.decide({ classified: now, capabilities: [], domains: [], inWorkspace: null });
    assert.equal(d.decision, 'ask', 'a person decides; the card shows the command and why it could not be checked');
    assert.match(d.reason, /could not be checked \(too large or complex to check\)/);
    assert.match(d.reason, /workspace limits could not be checked/);
    // Treated as the riskiest class: a task not granted it is denied, one granted it is asked.
    const restricted = ca.decide({ classified: now, capabilities: ['edit_file', 'execute_command'], domains: [], inWorkspace: null });
    assert.equal(restricted.decision, 'deny');
    assert.match(restricted.reason, /which this task was not granted/);
    assert.equal(ca.decide({ classified: now, capabilities: ['edit_file', 'external_account'], domains: [], inWorkspace: null }).decision, 'ask');
  });
});
