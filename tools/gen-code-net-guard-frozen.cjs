#!/usr/bin/env node
'use strict';
// Freezes what the JavaScript code-net guard answered, next to what the pinned Rust module answers,
// for the retirement of its JavaScript authority (#1071). The old guard is the byte-pinned
// tests/reference/code-net-guard-js.cjs (a verbatim copy of server/code-net-guard.cjs at the core
// commit named by --core-commit); the Rust half is the dav-parse.wasm named by DAV_PARSE_WASM, which
// must be the module server/dav-parse.lock pins. Synthetic addresses and names only; nothing is read
// from the network.
//   DAV_PARSE_WASM=path/to/dav-parse.wasm node tools/gen-code-net-guard-frozen.cjs \
//     --core-commit <40 hex digits> > tests/fixtures/code-net-guard-frozen.v1.json
//
// Sections (every row is JSON-safe; the seeds are fixed):
//   specRows:   { spec, js, port, old }   COWORK_CODE_NET_ADDR: the JS parse, the Rust parse, and
//               whether the old guard (JS and Rust must agree) started
//   answerRows: { answers, jsFound, oldHost, newHost }   one lookup's answers: what the JS kept, and
//               what the old and the Rust-only host did with them
//   guardRows:  { spec, lookups, locals, old, next }   a whole guard over several lookups and ten local
//               addresses: old = the real old guard (JS and Rust), next = the Rust-only decision
// `counts` folds the rows into relations. "weaker" always means the JavaScript refused (stopped
// startup, kept an address, refused a request) and the Rust-only answer permits; it must be 0, here
// and in tests/server/code-net-guard-differential.test.cjs.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const argAt = process.argv.indexOf('--core-commit');
const coreCommit = argAt > 0 ? process.argv[argAt + 1] : undefined;
if (!/^[0-9a-f]{40}$/.test(coreCommit || '')) throw Error('--core-commit <40 hex digits> is required');
const wasmPath = process.env.DAV_PARSE_WASM;
if (!wasmPath || !fs.existsSync(wasmPath)) throw Error('DAV_PARSE_WASM must name the pinned dav-parse.wasm');

const oraclePath = path.join(root, 'tests/reference/code-net-guard-js.cjs');
const fixturePath = path.join(root, 'tests/fixtures/code-net-guard.v1.json');
const wasm = require(path.join(root, 'server/dav-parse-wasm.cjs'));
const lock = wasm.readLock();
const wasmSha256 = sha256(wasmPath);
if (wasmSha256 !== lock.DAV_PARSE_WASM_SHA256) throw Error('DAV_PARSE_WASM is not the module server/dav-parse.lock pins');
const oracle = require(oraclePath);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

let seed = 0;
const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % m; };
const pick = (xs) => xs[rnd(xs.length)];

const ALPHA = ['0', '1', '2', '5', '9', 'a', 'f', 'F', 'g', ':', ':', '.', '.', '%', 'x', '-', '_', 'e', 's', ' '];
const PIECES = ['172.30.0.2', '::ffff:', '::', '::1', 'fe80::', '%eth0', '255', '256', '01', '0x7f', 'egress', 'xn--', 'EGRESS', '1.2.3.4', 'ac1e:2', 'web', 'a.b', '10.0.0.1'];
const NON_ASCII = [0xe9, 0xa0, 0x2003, 0xff45, 0xfeff, 0x212a, 0x130, 0xd800].map((c) => String.fromCharCode(c));
const IPS = ['172.30.0.2', '172.30.0.3', '172.18.0.5', '127.0.0.1', '10.0.0.1', '::1', '0:0::1', 'fe80::1', 'FE80::1%ETH0', '2001:db8::1', '2001:DB8::A:b',
  '::ffff:172.30.0.2', '::FFFF:172.30.0.2', '::ffff:ac1e:2', '::ffff:999.1.1.1', '1.2.3', '01.2.3.4', '255.255.255.255', '0.0.0.0', '::', '::2:3:4:5:6:7:8'];

const startupKind = (message) => (/should list IP addresses or host names, not/.test(message) ? 'js-malformed'
  : /Rust port refused COWORK_CODE_NET_ADDR/.test(message) ? 'port-refused'
    : /reads COWORK_CODE_NET_ADDR differently/.test(message) ? 'disagree' : null);
const fault = (err) => ({ fault: String(err?.reason || 'unexpected') });

// --- COWORK_CODE_NET_ADDR ----------------------------------------------------------------------
function jsSpec(spec) {
  try { const p = oracle.parseCodeNetSpec(spec); return { literals: [...p.literals], hosts: p.hosts }; }
  catch (err) { const m = /not "([\s\S]*)"$/.exec(err.message); if (!m) throw err; return { malformed: m[1] }; }
}
function portSpec(spec) {
  try { return wasm.codeNetSpec(spec); } catch (err) { return fault(err); }
}
async function oldStartup(spec) {
  try {
    const g = oracle.createCodeNetGuard({ spec, wasmLoader: () => wasm, lookup: async () => [], log: () => {}, retryMs: 3_600_000 });
    await g.ready; g.stop();
    return { started: true };
  } catch (err) {
    const refused = startupKind(err.message);
    if (!refused) throw err;
    return { started: false, refused };
  }
}
const HOSTS = ['egress', 'EGRESS', 'web', 'a.b', 'web-1.example', 'Web.Internal', 'a1', '1a', 'a-b', 'code.internal', 'xn--e1a.example', 'host.123', 'egress.0x7f', '010.0.0.1'];
function specWord() {
  return Array.from({ length: 1 + rnd(4) }, () => {
    const k = rnd(20);
    if (k < 12) return pick(PIECES);
    if (k < 13) return pick(NON_ASCII);
    return Array.from({ length: 1 + rnd(5) }, () => pick(ALPHA)).join('');
  }).join('');
}
// Mostly well-formed entries (so the readings are exercised), some junk (so the refusals are).
function specEntry() {
  const k = rnd(20);
  if (k < 8) return pick(IPS);
  if (k < 14) return pick(HOSTS);
  if (k < 16) return pick(NON_ASCII);
  return specWord();
}
function specs() {
  const out = [...fixtures.spec.map((r) => r.spec), ...fixtures.strictSpec.map((r) => r.spec)];
  seed = 853;
  const SEP = [',', ' ', ', ', '\t', '\n', ' , ', ',,'];
  for (let n = 0; n < 2000; n++) {
    const entries = Array.from({ length: rnd(5) }, specEntry);
    out.push((rnd(6) === 0 ? ' ' : '') + entries.join(pick(SEP)) + (rnd(6) === 0 ? ',' : ''));
  }
  return [...new Set(out)];
}
async function specSection() {
  const rows = [];
  for (const spec of specs()) rows.push({ spec, js: jsSpec(spec), port: portSpec(spec), old: await oldStartup(spec) });
  const counts = { rows: rows.length, bothStart: 0, jsMalformedRefused: 0, rustStricter: 0, weaker: 0 };
  for (const { js, port, old } of rows) {
    // The old guard started only if the JS parsed AND the port answered the same; the Rust-only guard starts iff the port parsed.
    const nextStarts = port.literals !== undefined;
    if (old.started && !(nextStarts && JSON.stringify(js) === JSON.stringify(port))) throw Error('the old guard started without Rust giving the JS reading');
    if (old.started) counts.bothStart++;
    else if (nextStarts) counts.weaker++;
    else if (js.malformed !== undefined) counts.jsMalformedRefused++;
    else counts.rustStricter++;
  }
  return { rows, counts };
}

// --- a lookup's answers -------------------------------------------------------------------------
const decorate = (s, ascii = false) => pick([s, s, s, s, s, s.toUpperCase(), ` ${s}`, `${s} `, `\t${s}\n`, `${s}%x`, s, s, s, ascii ? s : `\xa0${s}`]);
function item(ascii = false) {
  const k = rnd(24);
  if (k < 10) return decorate(pick(IPS), ascii);
  if (k < 12) return pick(['', 'nope', 'localhost', ascii ? 'host' : 'h\xe9', '1.2.3.4 5', 'aaaaa']);
  if (k < 14) return null;
  if (k < 18) return { address: decorate(pick(IPS), ascii), family: pick([4, 6]) };
  if (k < 19) return { address: pick([null, 5, true, {}, [], '', ['172.30.0.2'], ['::1', 'x']]) };
  if (k < 20) return { family: 4 };
  if (k < 21) return ['172.30.0.2'];
  return pick([7, true, [], {}]);
}
function answers() {
  const k = rnd(10);
  if (k < 7) return Array.from({ length: rnd(6) }, () => item());
  if (k < 8) return item();
  if (k < 9) return [];
  return Array.from({ length: 10 + rnd(30) }, () => item(true));
}
const asList = (a) => (Array.isArray(a) ? a : [a]);
// The old host's own reading of the answers, as resolveOnce does in the byte-pinned JavaScript guard.
const jsFound = (a) => asList(a).map((x) => oracle.normalizeAddress(typeof x === 'string' ? x : x?.address)).filter((x) => net.isIP(x));
// What the old host sent the port (strings, or null for anything else).
const oldProjection = (a) => asList(a).map((x) => (typeof x === 'string' ? x : (typeof x?.address === 'string' ? x.address : null)));
// What the Rust-only host sends: every answer's address read once and turned into text.
const nextProjection = (a) => asList(a).map((x) => String((typeof x === 'string' ? x : x?.address) || ''));
function resolved(list) { try { return { addresses: wasm.codeNetResolved(list) }; } catch (err) { return fault(err); } }
function hostOld(a) {
  const found = jsFound(a);
  if (!found.length) return { none: true };
  const port = resolved(oldProjection(a));
  return port.fault ? { found, broken: port.fault } : { found, kept: port.addresses };
}
function hostNext(a) {
  const port = resolved(nextProjection(a));
  return port.fault ? { broken: port.fault } : port.addresses.length ? { kept: port.addresses } : { none: true };
}
function answerSection() {
  seed = 1071;
  const lists = [...fixtures.answers.map((r) => r.answers), ...fixtures.strictAnswers.map((r) => r.answers)];
  for (let n = 0; n < 2000; n++) lists.push(answers());
  const rows = [];
  const seen = new Set();
  for (const a of lists) {
    const key = JSON.stringify(a);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ answers: a, jsFound: jsFound(a), oldHost: hostOld(a), newHost: hostNext(a) });
  }
  const counts = { rows: rows.length, same: 0, noAddress: 0, rustFault: 0, rustExtra: 0, weaker: 0 };
  for (const { jsFound: found, newHost: next } of rows) {
    if (next.broken) counts.rustFault++;
    else if (next.none) { if (found.length) counts.weaker++; else counts.noAddress++; }
    else if (!found.every((x) => next.kept.includes(x))) counts.weaker++;
    else if (JSON.stringify(found) === JSON.stringify(next.kept)) counts.same++;
    else counts.rustExtra++;
  }
  return { rows, counts };
}

// --- a whole guard ----------------------------------------------------------------------------
const SCENARIO_SPECS = ['egress', '172.30.0.2', '172.30.0.2,egress', 'egress,web', '::1 web.internal', 'egress,egress', '0:0::1,egress', 'FE80::1 egress', '::ffff:172.30.0.2', 'a.b,c.d,e.f', '2001:db8::1,172.18.0.5'];
const LOCAL_POOL = ['172.30.0.2', '172.30.0.3', '172.18.0.5', '127.0.0.1', '::1', '0:0::1', '::ffff:172.30.0.2', '::FFFF:172.30.0.2', '::ffff:ac1e:2', ' 172.30.0.2 ', '172.30.0.2\xa0', 'fe80::1', 'fe80::1%eth0', '2001:db8::1', '2001:DB8:0:0:0:0:0:1', 'egress', 'nope', '', '10.0.0.1'];
// Locals are tagged so JSON can carry undefined: ['s', text], ['u'], ['null'], ['num', n], ['bool', b].
const decodeLocal = (e) => (e[0] === 's' || e[0] === 'num' || e[0] === 'bool' ? e[1] : e[0] === 'null' ? null : undefined);
function locals(members) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const k = rnd(20);
    if (k < 8 && members.length) out.push(['s', decorate(pick(members))]);
    else if (k < 15) out.push(['s', pick(LOCAL_POOL)]);
    else if (k < 16) out.push(['u']);
    else if (k < 17) out.push(['null']);
    else if (k < 18) out.push(['num', pick([0, 5, 127])]);
    else if (k < 19) out.push(['bool', pick([true, false])]);
    else out.push(['s', pick(IPS)]);
  }
  return out;
}
async function guardSection() {
  seed = 4242;
  const rows = [];
  for (let n = 0; n < 400; n++) {
    const spec = pick(SCENARIO_SPECS);
    const parsed = jsSpec(spec);
    const lookups = {};
    for (const host of parsed.hosts) {
      const k = rnd(10);
      lookups[host] = k < 7 ? { answers: answers() } : k < 8 ? { fail: true } : { answers: [] };
    }
    const found = Object.values(lookups).flatMap((l) => (l.answers === undefined ? [] : jsFound(l.answers)));
    const ls = locals([...parsed.literals, ...found]);
    // The old guard, run for real: served only when the JS and the port both serve.
    const g = oracle.createCodeNetGuard({ spec, wasmLoader: () => wasm, log: () => {}, retryMs: 3_600_000,
      lookup: async (host) => { const l = lookups[host]; if (l.fail) throw Error('synthetic lookup failure'); return l.answers; } });
    await g.ready;
    const old = [];
    for (const l of ls) old.push(await g.refuses(decodeLocal(l)));
    g.stop();
    // The Rust-only guard, from the port's own answers: one fault refuses everything.
    let broken = false;
    const set = new Set(portSpec(spec).literals);
    for (const host of parsed.hosts) {
      const l = lookups[host];
      if (broken || l.fail) continue;
      const o = hostNext(l.answers);
      if (o.broken) broken = true; else if (o.kept) for (const a of o.kept) set.add(a);
    }
    const next = ls.map((l) => {
      if (broken) return true;
      const v = decodeLocal(l);
      try { return wasm.codeNetRefuses([...set], typeof v === 'string' ? v : v ? String(v) : null); } catch { return true; }
    });
    rows.push({ spec, lookups, locals: ls, old, next });
  }
  const counts = { rows: rows.length, requests: 0, same: 0, refusedBoth: 0, rustStricter: 0, weaker: 0 };
  for (const { old, next } of rows) {
    for (let i = 0; i < old.length; i++) {
      counts.requests++;
      if (old[i] === next[i]) { counts.same++; if (old[i]) counts.refusedBoth++; } else if (next[i]) counts.rustStricter++; else counts.weaker++;
    }
  }
  return { rows, counts };
}

(async () => {
  const spec = await specSection(), ans = answerSection(), guard = await guardSection();
  for (const [name, s] of [['spec', spec], ['answers', ans], ['guard', guard]]) {
    if (s.counts.weaker !== 0) throw Error(`${name}: the Rust-only answer permits where the JavaScript refused (${s.counts.weaker})`);
  }
  const out = {
    version: 1,
    provenance: {
      coreCommit,
      oracle: 'tests/reference/code-net-guard-js.cjs',
      oracleSha256: sha256(oraclePath),
      fixtureSha256: sha256(fixturePath),
      wasmSha256,
      noeviaRsRef: lock.NOEVIA_RS_REF,
      generator: 'tools/gen-code-net-guard-frozen.cjs',
    },
    counts: { spec: spec.counts, answers: ans.counts, guard: guard.counts },
    specRows: spec.rows,
    answerRows: ans.rows,
    guardRows: guard.rows,
  };
  const parts = Object.entries(out).map(([k, v]) => (Array.isArray(v) ? `${JSON.stringify(k)}:[\n${v.map((r) => JSON.stringify(r)).join(',\n')}\n]` : `${JSON.stringify(k)}:${JSON.stringify(v)}`));
  process.stdout.write(`{\n${parts.join(',\n')}\n}\n`);
})().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; });
