'use strict';

// Browser policy (BROWSER_POLICY_IMPL, retired in #1071: always Rust).
// tests/fixtures/browser-policy.v1.json (byte-identical to noevia-rs crates/browser-policy/tests/fixtures/;
// CI compares them) holds the port's exact replies for synthetic rows, first printed from the former JS rules
// (a `strict` row is one where the port answers more strictly: it does not know a code point).
// tests/fixtures/browser-policy-js.v1.json freezes what those JS rules answered for the same rows, for the
// seeded calls below, for every UTF-16 code unit as a key or a method, and for the large-input cases.
// Both files are frozen and sha256-pinned: the JS rules and their generator are gone, and neither may be
// regenerated through the Rust path (that would erase the independent reference).
// Provenance and one caveat (also in the frozen file's `note`): the "JS" answers were frozen from noevia-core at
// e70151f with the dav-parse.wasm that server/dav-parse.lock pins. For IP literals they come from ssrf.cjs
// isPrivateIp, which is itself the ssrf-policy crate, so comparing them with the browser-policy crate is circular;
// the independent reference for IP address classification is the ssrf-policy crate's own frozen fixtures
// (tests/fixtures/ssrf.v1.json, #795), not this file.
// Here every row runs through dav-parse.wasm's browser_policy and through the functions browser-executor.cjs
// calls. The old composition never let an action out that the JS held back, and let the port only add; with
// the JS gone the port decides alone, so what must hold, and is counted below, is that no frozen JS answer is
// weakened (a blocked or asking action is never allowed, a refused address or secret is never opened or
// typed), that the port adds restrictions only for what it does not know, and where it differs only in words.
// The port's label fold (ICU4X NFKD and the standard library's lowercasing, over its table of code points) is
// checked for every code point of its table, alone and in context, against this runtime's own normalize() and
// toLowerCase(), and every code point outside it must be unknown; key presses (String#trim, /\s/) and methods
// (toUpperCase) are checked for every UTF-16 code unit against the frozen JS answers. So it holds on the
// shipped ICU too. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped
// without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const bp = require('../../server/browser-policy.cjs');

const FILE = path.join(__dirname, '../fixtures/browser-policy.v1.json');
const FROZEN_FILE = path.join(__dirname, '../fixtures/browser-policy-js.v1.json');
// The frozen references are pinned: changing either is a deliberate act that also changes these.
const PINS = { [FILE]: 'c42a8ac82d8876faaebf661c81c277506964abc1e4befeec9a0005559626f1d7', [FROZEN_FILE]: '262f8793f4972ed361c486402bc14eabaf09e62d4aa9c727d550659174dfc03a' };
const FROZEN = JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const STATUSES = ['allow', 'needs_approval', 'blocked'];
// Guards a wrong test signature (options passed twice makes node:test take the second object as the body, so the
// body never runs and the test reports ok): when the module is there, every guarded body must have run.
let ran = 0;
test.after(() => { if (!skipWasm) assert.equal(ran, 6, 'a wasm-guarded test body did not run'); });
const RANK = { allow: 0, needs_approval: 1, blocked: 2 };

// browser_policy::KNOWN_RANGES.
const KNOWN = [[0x0000, 0x052f], [0x0590, 0x05ff], [0x0600, 0x06ff], [0x0900, 0x097f], [0x0e00, 0x0e7f], [0x1e00, 0x1fff], [0x2000, 0x206f],
  [0x2190, 0x21ff], [0x2500, 0x27bf], [0x3000, 0x30ff], [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xe000, 0xf8ff], [0xff01, 0xff9f], [0x1f300, 0x1f6ff],
  [0x1f900, 0x1faff]];
const knownCp = (cp) => KNOWN.some(([a, b]) => cp >= a && cp <= b);

/** The rule the port's fold mirrors (the former JS fold), over this runtime's normalize() and toLowerCase(). */
const fold = (text) => String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

const CALLS = {
  1: (a) => davParseWasm.browserPolicyClassify(...a),
  2: (a) => davParseWasm.browserPolicyNavigation(...a),
  3: (a) => davParseWasm.browserPolicySubstitute(...a),
  4: ([texts]) => davParseWasm.browserPolicyFold(texts),
};

/** The JS inputs a classify projection stands for (a null origin: a truthy non-string). */
function fromProjection([a, e, p]) {
  const action = { type: a.type, element: e };
  if (a.url !== null) action.url = a.url;
  if (a.method !== null) action.method = a.method;
  if (a.key !== null) action.key = a.key;
  return [action, { origin: p.origin === null ? {} : p.origin, allowedDomains: p.allowedDomains }];
}

const text = (i) => FROZEN.texts[i];
const frozenClassify = ([status, reason]) => ({ status: STATUSES[status], reason: text(reason) });
const frozenNav = ([ok, t]) => (ok ? { ok: true, origin: text(t) } : { ok: false, reason: text(t) });
const tally = (t, key) => { t[key] = (t[key] || 0) + 1; };
/** How a new action answer relates to the frozen JS one. Never weaker. */
function relateAction(js, now, where) {
  assert.ok(RANK[now.status] >= RANK[js.status], `${where}: ${js.status} became ${now.status}`);
  if (RANK[now.status] > RANK[js.status]) return `${js.status}->${now.status}`;
  return now.reason === js.reason ? `${js.status} same` : `${js.status} same status, other words`;
}

test('the fixture files are frozen and pinned, line up, and no JS rule, switch or generator remains', () => {
  for (const [file, pin] of Object.entries(PINS)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), pin, path.basename(file));
  assert.equal(FROZEN.version, 1);
  assert.equal(FROZEN.rows.length, fixtures.rows.length);
  assert.equal(FROZEN.seeded.classify.length, 6000);
  assert.equal(FROZEN.keys.codes.length, 65536 * 8);
  assert.deepEqual(Object.keys(bp).sort(), ['actionProjection', 'checkNavigation', 'classifyAction', 'domainsProjection', 'elementProjection', 'maskSecrets',
    'pageProjection', 'secretsProjection', 'substituteSecrets']);
  assert.ok(!fs.existsSync(path.join(__dirname, '../../tools/gen-browser-policy-fixtures.cjs')));
});

test('fixture rows: the port replies exactly as the file says; the functions the executor calls never weaken the frozen JS answer', { skip: skipWasm }, () => {
  ran++;
  assert.ok(fixtures.rows.length >= 8000);
  let strict = 0;
  const seen = { classify: {}, nav: {}, secrets: {} };
  for (const [i, row] of fixtures.rows.entries()) {
    const args = JSON.parse(row.wire);
    const want = JSON.parse(row.want);
    assert.deepEqual(CALLS[row.op](args), want, `row ${i}`);
    if (row.strict) strict++;
    const frozen = FROZEN.rows[i];
    if (row.op === 1) {
      const [action, page] = fromProjection(args);
      const js = frozenClassify(frozen);
      const now = quietly(() => bp.classifyAction(action, page));
      const rel = relateAction(js, now, `row ${i}`);
      if (!row.strict) assert.ok(rel.endsWith(' same'), `row ${i} ${rel}`);
      else assert.notEqual(now.status, 'allow', `row ${i}`);
      tally(seen.classify, rel);
    } else if (row.op === 2) {
      const js = frozenNav(frozen);
      const now = quietly(() => bp.checkNavigation(...args));
      if (js.ok) assert.ok(!now.ok || now.origin === js.origin, `row ${i}: the origin changed`);
      else assert.equal(now.ok, false, `row ${i}: a refused address is opened`);
      tally(seen.nav, js.ok === now.ok ? (JSON.stringify(js) === JSON.stringify(now) ? 'same' : 'same outcome, other words') : 'js-ok port-refuses');
      if (!row.strict) assert.deepEqual(now, js, `row ${i}`);
    } else if (row.op === 3) {
      const [t, pairs, origin] = args;
      const secrets = Object.fromEntries(pairs.map(([n, d]) => [n, { value: `v-${n}`, domains: d }]));
      const now = quietly(() => bp.substituteSecrets(t, secrets, origin));
      const [ok, vt, used] = frozen;
      if (ok) assert.deepEqual(now, { ok: true, value: text(vt), used }, `row ${i}`);
      else assert.deepEqual(now, { ok: false, reason: text(vt) }, `row ${i}`);
      tally(seen.secrets, ok ? 'typed' : 'refused');
    }
  }
  assert.ok(strict > 200, `${strict} strict rows`);
  assert.deepEqual(seen, {"classify":{"needs_approval same":2597,"allow same":1539,"blocked same":386,"allow->needs_approval":128,"needs_approval same status, other words":133},"nav":{"same":1316},"secrets":{"typed":537,"refused":1414}});
});

/** Fold `texts` through the port in batches; every known one must equal this runtime's fold. */
function checkFolds(texts, label) {
  for (let k = 0; k < texts.length; k += 4096) {
    const part = texts.slice(k, k + 4096);
    const { folded } = davParseWasm.browserPolicyFold(part);
    for (const [j, t] of part.entries()) {
      const known = [...t].every((ch) => { const cp = ch.codePointAt(0); return !(cp >= 0xd800 && cp <= 0xdfff) && knownCp(cp); });
      if (known) assert.equal(folded[j], fold(t), `${label} ${JSON.stringify(t)} (U+${t.codePointAt(0).toString(16)})`);
      else assert.equal(folded[j], null, `${label} unknown ${JSON.stringify(t)}`);
    }
  }
}

test('every code point of the fold table folds as this runtime does: alone, between letters, doubled, with marks', { skip: skipWasm }, () => {
  ran++;
  let checked = 0;
  // Latin, Greek, kana and Cyrillic marks, and the new scripts' (Hebrew points, Arabic harakat and
  // shadda, Devanagari nukta/virama, Thai vowels/tones), in both canonical orders where they differ.
  const MARKS = ['\u0301', '\u0323\u0301', '\u0301\u0323', '\u0345', '\u3099', '\u0483', '\u05b0', '\u05bc\u05b8', '\u05b8\u05bc',
    '\u0651\u064e', '\u064e\u0651', '\u0670', '\u093c\u094d', '\u094d\u093c', '\u0e38\u0e48', '\u0e48\u0e38'];
  for (const [a, b] of KNOWN) {
    const batch = [];
    for (let cp = a; cp <= b; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      batch.push(c, `A${c}b`, `${c}${c}`, `Σ${c}`, `${c}Σ`, `xΣ${c}`, ...MARKS.map((m) => `${c}${m}`), ...MARKS.map((m) => `${m}${c}`));
    }
    checkFolds(batch, 'known');
    checked += b - a + 1;
  }
  assert.ok(checked > 36_000, `${checked}`);
  // Final sigma and whitespace in context.
  checkFolds(['ΣΑΣ', 'ΑΣ ΑΣ', 'Σ', 'aΣ', 'Σa', 'ΑΣ.', 'ΑΣ ', '  x  y 　 ', 'ǅ', 'Ǆa', 'ﾟ', 'ｶﾞ'], 'context');
});

test('every code point outside the fold table, and every lone surrogate, is unknown to the port', { skip: skipWasm }, () => {
  ran++;
  const outside = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) if (!knownCp(cp) && !(cp >= 0xd800 && cp <= 0xdfff)) outside.push(String.fromCodePoint(cp));
  for (let u = 0xd800; u <= 0xdfff; u++) outside.push(String.fromCharCode(u), `a${String.fromCharCode(u)}`);
  checkFolds(outside, 'outside');
});

test('every UTF-16 code unit as a key, and in a method: the answer equals the frozen JS one, or (unknown to the port) asks', { skip: skipWasm }, () => {
  ran++;
  const control = { tag: 'button', text: 'Home', inForm: true };
  const page = { origin: 'https://example.com', allowedDomains: ['example.com'] };
  const { reasons, codes } = FROZEN.keys;
  const frozenAt = (k) => ({ status: STATUSES[Number(codes[2 * k])], reason: reasons[parseInt(codes[2 * k + 1], 36)] });
  let unknown = 0;
  for (let u = 0; u <= 0xffff; u++) {
    const c = String.fromCharCode(u);
    [c, `${c}${c}`, `Shift+${c}`].forEach((key, k) => {
      const action = { type: 'press', key, element: control };
      const now = bp.classifyAction(action, page);
      const js = frozenAt(4 * u + k);
      const port = davParseWasm.browserPolicyClassify(bp.actionProjection(action, 'press'), bp.elementProjection(control), bp.pageProjection(page, 'press'));
      if (port.status === null) {
        unknown++;
        assert.equal(now.status === 'allow', false, `key U+${u.toString(16)}`);
        assert.ok(RANK[now.status] >= RANK[js.status], `key U+${u.toString(16)}`);
      } else assert.deepEqual(now, js, `key ${JSON.stringify(key)} (U+${u.toString(16)})`);
    });
    const nav = { type: 'navigate', url: 'https://example.com/', method: `GE${c}` };
    assert.deepEqual(bp.classifyAction(nav, page), frozenAt(4 * u + 3), `method GE+U+${u.toString(16)}`);
  }
  assert.ok(unknown > 1000, `${unknown}`);
});

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = ['Send', 'Löschen', 'Bestätigen', 'Veröffentlichen', 'Überweisen', 'Ｓｅｎｄ', 'ＰＡＹ ｎｏｗ', 'Next', 'Über uns', 'Ελληνικά', 'ΑΓΟΡΑ',
  'Удалить', 'Отправить', '購入する', '送信', '삭제', 'Comprar ahora', 'Supprimer', 'ﬁnish', 'sign up', 'place order', 'Delete​',
  'Paý', 'Seńd', '🛒 Cart', '🗑 Delete', 'x\ud800', 'İptal', 'ΣΑΣ', 'Read more', '', 'Check out', 'check　out', 'ǅ', 'Ａｃｃｅｐｔ'];
const TAGS = ['button', 'a', 'input', 'div', 'BUTTON', 'Button ', 'summary', 'ｂｕｔｔｏｎ', 'İnput', ''];
const TYPES = ['', 'submit', 'button', 'reset', 'image', 'text', 'xyz', 'SUBMIT', 'ｓｕｂｍｉｔ', 'ﬁle', 'checkbox'];
const ROLES = ['', 'button', 'link', 'option', 'ｌｉｎｋ', 'menuitem', 'presentation'];
const KEYS = ['Enter', ' ', '　', ' ', 'Space', 'Shift+Enter', 'Ｅｎｔｅｒ', 'Return', 'Tab', 'a', '+', 'ﬁ', 'Enteŕ', 'ENTER', 'Entér'];
const HOSTS = ['example.com', 'shop.example.com', 'EXAMPLE.com', 'example.com.', 'bücher.example.com', 'xn--bcher-kva.example.com', 'ｅｘａｍｐｌｅ.com',
  'example.com。', 'exam­ple.com', 'localhost', 'corp.internal.', '127.0.0.1', '93.184.216.34', '[2606:2800:220:1::]', '[::ffff:7f00:1]',
  'evil.net', 'example.com.evil.net', 'xn--nxasmq6b.example.com', 'ex%61mple.com', 'β.example.com', 'ß.example.com', 'İ.example.com'];

test('seeded live calls: no frozen JS answer is weakened, and every kind of difference is counted', { skip: skipWasm }, () => {
  ran++;
  const rand = mulberry32(0xb2055);
  const pick = (l) => l[Math.floor(rand() * l.length)];
  const pages = [{ origin: 'https://shop.example.com', allowedDomains: ['example.com', '93.184.216.34', '2606:2800:220:1::'] },
    { origin: '', allowedDomains: ['example.com', 'bücher.example.com', 'corp.internal'] }, { origin: 'https://example.com', allowedDomains: ['ｅｘａｍｐｌｅ.com'] }];
  const seen = { classify: {}, nav: {}, secrets: {} };
  for (let n = 0; n < 6000; n++) {
    const page = pick(pages);
    const type = pick(['click', 'click', 'press', 'press', 'navigate', 'navigate', 'type', 'upload', 'hover', 'evaluate']);
    const element = { tag: pick(TAGS), type: pick(TYPES), role: pick(ROLES), inForm: rand() < 0.5 };
    for (const k of ['name', 'text', 'value']) if (rand() < 0.5) element[k] = pick(LABELS);
    const url = `${pick(['https', 'http', 'HTTPS', 'ftp'])}://${pick(['', '', 'u@'])}${pick(HOSTS)}${pick(['', ':8443', ':443'])}/${pick(['', 'a', 'ä', '%2e%2e/x'])}`;
    const action = { type, element, url, method: pick([undefined, 'GET', 'POST', 'get']), key: pick(KEYS) };
    const now = quietly(() => bp.classifyAction(action, page));
    tally(seen.classify, relateAction(frozenClassify(FROZEN.seeded.classify[n]), now, `call ${n}`));
    const js = frozenNav(FROZEN.seeded.nav[n]);
    const navNow = quietly(() => bp.checkNavigation(url, page.allowedDomains));
    assert.ok(!navNow.ok || (js.ok && navNow.origin === js.origin), JSON.stringify([url, js, navNow]));
    tally(seen.nav, js.ok === navNow.ok ? (JSON.stringify(js) === JSON.stringify(navNow) ? 'same' : 'same outcome, other words') : 'js-ok port-refuses');
  }
  // Secrets: a value is typed only where the JS typed it, and the same one.
  const secrets = { gh: { value: 'ghp_synthetic', domains: ['github.com'] }, 'b.c': { value: 'two', domains: ['bücher.example.com', 'example.com'] } };
  for (let n = 0; n < 2000; n++) {
    const t = Array.from({ length: Math.floor(rand() * 4) }, () => pick(['{{secret:gh}}', '{{secret:b.c}}', '{{secret:nope}}', '{{secret:', '}}', 'x'])).join('');
    const origin = `https://${pick(HOSTS)}`;
    const now = quietly(() => bp.substituteSecrets(t, secrets, origin));
    const [ok, vt, used] = FROZEN.seeded.secrets[n];
    if (ok) assert.deepEqual(now, { ok: true, value: text(vt), used }, JSON.stringify([t, origin]));
    else assert.deepEqual(now, { ok: false, reason: text(vt) }, JSON.stringify([t, origin]));
    tally(seen.secrets, ok ? 'typed' : 'refused');
  }
  assert.deepEqual(seen, {"classify":{"needs_approval same":2660,"blocked same":929,"needs_approval same status, other words":187,"allow same":1998,"allow->needs_approval":226},"nav":{"same":6000},"secrets":{"refused":881,"typed":1119}});
});

test('large inputs are bounded in the port and through the functions the executor calls', { skip: skipWasm }, () => {
  ran++;
  const page = { origin: 'https://example.com', allowedDomains: Array.from({ length: 20_000 }, (_, i) => `d${i}.example.org`).concat('example.com') };
  const cases = [
    { type: 'click', element: { tag: 'a', text: 'check '.repeat(200_000) } },
    { type: 'click', element: { tag: 'a', name: 'Löschen '.repeat(100_000), text: 'Ｓ'.repeat(100_000) } },
    { type: 'press', key: '+'.repeat(1_000_000), element: { tag: 'a', text: 'Home' } },
    { type: 'press', key: 'enter'.repeat(200_000), element: { inForm: true } },
    { type: 'navigate', url: `https://${'a.'.repeat(30_000)}example.com/${'x'.repeat(500_000)}` },
    { type: 'navigate', url: `https://example.com${'.'.repeat(500_000)}/` },
  ];
  for (const [k, action] of cases.entries()) {
    const t = process.hrtime.bigint();
    const v = quietly(() => bp.classifyAction(action, page));
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(RANK[v.status] >= FROZEN.large[k], `case ${k}: ${v.status} after the JS said ${STATUSES[FROZEN.large[k]]}`);
    assert.ok(ms < 2000, `case ${k}: ${ms} ms`);
  }
  const t = process.hrtime.bigint();
  const big = '{{secret:'.repeat(200_000) + '{{secret:gh}}'.repeat(50_000);
  const r = quietly(() => bp.substituteSecrets(big, { gh: { value: 'v', domains: ['example.com'] } }, 'https://example.com'));
  assert.equal(r.ok, true);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 2000);
  // Over the module's cap: a refusal, so the executor's function asks (it never allows).
  const huge = { type: 'click', element: { tag: 'a', text: 'Home '.repeat(1_000_000) } };
  assert.equal(quietly(() => bp.classifyAction(huge, page)).status, 'needs_approval');
  assert.throws(() => davParseWasm.browserPolicyClassify(bp.actionProjection(huge, 'click'), bp.elementProjection(huge.element), bp.pageProjection(page, 'click')),
    (e) => e.reason === 'too_large');
});
