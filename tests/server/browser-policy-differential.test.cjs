'use strict';

// BROWSER_POLICY_IMPL: tests/fixtures/browser-policy.v1.json (byte-identical to noevia-rs
// crates/browser-policy/tests/fixtures/; CI compares them) holds browser-policy.cjs's answers,
// printed by tools/gen-browser-policy-fixtures.cjs from the JS itself (synthetic rows only). Here
// every row runs through dav-parse.wasm's browser_policy and through the switched functions;
// seeded live actions, addresses and secret placeholders check that the switched rules are never
// more permissive than the JS. The port's label fold (ICU4X NFKD and the standard library's
// lowercasing, over its table of code points) is checked for every code point of its table, alone
// and in context, against this runtime's own normalize() and toLowerCase(), and every code point
// outside it must be unknown; key presses (String#trim, /\s/) and methods (toUpperCase) are
// checked for every UTF-16 code unit. So it holds on the shipped ICU too. The WebAssembly half
// needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const bp = require('../../server/browser-policy.cjs');

const FILE = path.join(__dirname, '../fixtures/browser-policy.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-browser-policy-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const WASM = { impl: 'wasm' };
const RANK = { allow: 0, needs_approval: 1, blocked: 2 };

// browser_policy::KNOWN_RANGES.
const KNOWN = [[0x0000, 0x052f], [0x1e00, 0x1fff], [0x2000, 0x206f], [0x3000, 0x30ff], [0x4e00, 0x9fff], [0xac00, 0xd7a3],
  [0xff01, 0xff9f], [0x1f300, 0x1f6ff], [0x1f900, 0x1faff]];
const knownCp = (cp) => KNOWN.some(([a, b]) => cp >= a && cp <= b);

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

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('fixture rows: the exact reply; the switched rules equal the JS, or (strict rows) are stricter', { skip: skipWasm }, () => {
  assert.ok(fixtures.rows.length >= 8000);
  let strict = 0;
  for (const [i, row] of fixtures.rows.entries()) {
    const args = JSON.parse(row.wire);
    const want = JSON.parse(row.want);
    assert.deepEqual(CALLS[row.op](args), want, `row ${i}`);
    if (row.strict) strict++;
    if (row.op === 1) {
      const [action, page] = fromProjection(args);
      const js = bp.classifyActionJs(action, page);
      const sw = quietly(() => bp.classifyAction(action, page, WASM));
      if (!row.strict) assert.deepEqual(sw, js, `row ${i}`);
      else {
        assert.ok(RANK[sw.status] >= RANK[js.status] && sw.status !== 'allow', `row ${i}`);
        assert.equal(sw.status, want.status ?? (js.status === 'blocked' ? 'blocked' : 'needs_approval'), `row ${i} switched`);
      }
    } else if (row.op === 2) {
      const js = bp.checkNavigationJs(...args);
      const sw = quietly(() => bp.checkNavigation(...args, WASM));
      if (!row.strict) assert.deepEqual(sw, js, `row ${i}`);
      else assert.ok(!sw.ok, `row ${i}`);
    } else if (row.op === 3) {
      const [text, pairs, origin] = args;
      const secrets = Object.fromEntries(pairs.map(([n, d]) => [n, { value: `v-${n}`, domains: d }]));
      assert.deepEqual(quietly(() => bp.substituteSecrets(text, secrets, origin, WASM)), bp.substituteSecretsJs(text, secrets, origin), `row ${i}`);
    }
  }
  assert.ok(strict > 300, `${strict} strict rows`);
});

/** Fold `texts` through the port in batches; every known one must equal this runtime's fold. */
function checkFolds(texts, label) {
  for (let k = 0; k < texts.length; k += 4096) {
    const part = texts.slice(k, k + 4096);
    const { folded } = davParseWasm.browserPolicyFold(part);
    for (const [j, t] of part.entries()) {
      const known = [...t].every((ch) => { const cp = ch.codePointAt(0); return !(cp >= 0xd800 && cp <= 0xdfff) && knownCp(cp); });
      if (known) assert.equal(folded[j], bp.fold(t), `${label} ${JSON.stringify(t)} (U+${t.codePointAt(0).toString(16)})`);
      else assert.equal(folded[j], null, `${label} unknown ${JSON.stringify(t)}`);
    }
  }
}

test('every code point of the fold table folds as this runtime does: alone, between letters, doubled, with marks', { skip: skipWasm }, () => {
  let checked = 0;
  const MARKS = ['́', '̣́', '̣́', 'ͅ', '゙', '҃'];
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
  const outside = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) if (!knownCp(cp) && !(cp >= 0xd800 && cp <= 0xdfff)) outside.push(String.fromCodePoint(cp));
  for (let u = 0xd800; u <= 0xdfff; u++) outside.push(String.fromCharCode(u), `a${String.fromCharCode(u)}`);
  checkFolds(outside, 'outside');
});

test('every UTF-16 code unit as a key, and in a method: the port equals the JS or (unknown) asks', { skip: skipWasm }, () => {
  const control = { tag: 'button', text: 'Home', inForm: true };
  const page = { origin: 'https://example.com', allowedDomains: ['example.com'] };
  let unknown = 0;
  for (let u = 0; u <= 0xffff; u++) {
    const c = String.fromCharCode(u);
    for (const key of [c, `${c}${c}`, `Shift+${c}`]) {
      const action = { type: 'press', key, element: control };
      const js = bp.classifyActionJs(action, page);
      const port = davParseWasm.browserPolicyClassify(bp.actionProjection(action, 'press'), bp.elementProjection(control), bp.pageProjection(page, 'press'));
      if (port.status === null) {
        unknown++;
        assert.notEqual(quietly(() => bp.classifyAction(action, page, WASM)).status, 'allow', `key U+${u.toString(16)}`);
      } else assert.deepEqual(port, js, `key ${JSON.stringify(key)} (U+${u.toString(16)})`);
    }
    const nav = { type: 'navigate', url: 'https://example.com/', method: `GE${c}` };
    const js = bp.classifyActionJs(nav, page);
    const port = davParseWasm.browserPolicyClassify(bp.actionProjection(nav, 'navigate'), bp.elementProjection(undefined), bp.pageProjection(page, 'navigate'));
    assert.deepEqual(port, js, `method GE+U+${u.toString(16)}`);
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

test('seeded live calls: the switched rules are never more permissive than the JS', { skip: skipWasm }, () => {
  const rand = mulberry32(0xb2055);
  const pick = (l) => l[Math.floor(rand() * l.length)];
  const pages = [{ origin: 'https://shop.example.com', allowedDomains: ['example.com', '93.184.216.34', '2606:2800:220:1::'] },
    { origin: '', allowedDomains: ['example.com', 'bücher.example.com', 'corp.internal'] }, { origin: 'https://example.com', allowedDomains: ['ｅｘａｍｐｌｅ.com'] }];
  const counts = { same: 0, stricter: 0 };
  for (let n = 0; n < 6000; n++) {
    const page = pick(pages);
    const type = pick(['click', 'click', 'press', 'press', 'navigate', 'navigate', 'type', 'upload', 'hover', 'evaluate']);
    const element = { tag: pick(TAGS), type: pick(TYPES), role: pick(ROLES), inForm: rand() < 0.5 };
    for (const k of ['name', 'text', 'value']) if (rand() < 0.5) element[k] = pick(LABELS);
    const url = `${pick(['https', 'http', 'HTTPS', 'ftp'])}://${pick(['', '', 'u@'])}${pick(HOSTS)}${pick(['', ':8443', ':443'])}/${pick(['', 'a', 'ä', '%2e%2e/x'])}`;
    const action = { type, element, url, method: pick([undefined, 'GET', 'POST', 'get']), key: pick(KEYS) };
    const js = bp.classifyActionJs(action, page);
    const sw = quietly(() => bp.classifyAction(action, page, WASM));
    assert.ok(RANK[sw.status] >= RANK[js.status], JSON.stringify([action, page, js, sw]));
    if (js.status === 'blocked') assert.equal(sw.status, 'blocked');
    counts[sw.status === js.status && sw.reason === js.reason ? 'same' : 'stricter']++;
    const navJs = bp.checkNavigationJs(url, page.allowedDomains);
    const navSw = quietly(() => bp.checkNavigation(url, page.allowedDomains, WASM));
    assert.ok(!navSw.ok || (navJs.ok && navSw.origin === navJs.origin), JSON.stringify([url, navJs, navSw]));
  }
  assert.ok(counts.same > 3000 && counts.stricter > 50, JSON.stringify(counts));
  // Secrets: a value is typed only where the JS would type it, and the same one.
  const secrets = { gh: { value: 'ghp_synthetic', domains: ['github.com'] }, 'b.c': { value: 'two', domains: ['bücher.example.com', 'example.com'] } };
  for (let n = 0; n < 2000; n++) {
    const text = Array.from({ length: Math.floor(rand() * 4) }, () => pick(['{{secret:gh}}', '{{secret:b.c}}', '{{secret:nope}}', '{{secret:', '}}', 'x'])).join('');
    const origin = `https://${pick(HOSTS)}`;
    const js = bp.substituteSecretsJs(text, secrets, origin);
    const sw = quietly(() => bp.substituteSecrets(text, secrets, origin, WASM));
    assert.ok(!sw.ok || (js.ok && sw.value === js.value), JSON.stringify([text, origin, js, sw]));
  }
});

test('large inputs are bounded in the port and through the switched paths (js and wasm)', { skip: skipWasm }, () => {
  const page = { origin: 'https://example.com', allowedDomains: Array.from({ length: 20_000 }, (_, i) => `d${i}.example.org`).concat('example.com') };
  const cases = [
    { type: 'click', element: { tag: 'a', text: 'check '.repeat(200_000) } },
    { type: 'click', element: { tag: 'a', name: 'Löschen '.repeat(100_000), text: 'Ｓ'.repeat(100_000) } },
    { type: 'press', key: '+'.repeat(1_000_000), element: { tag: 'a', text: 'Home' } },
    { type: 'press', key: 'enter'.repeat(200_000), element: { inForm: true } },
    { type: 'navigate', url: `https://${'a.'.repeat(30_000)}example.com/${'x'.repeat(500_000)}` },
    { type: 'navigate', url: `https://example.com${'.'.repeat(500_000)}/` },
  ];
  for (const opts of [{ impl: 'js' }, WASM]) {
    for (const [k, action] of cases.entries()) {
      const t = process.hrtime.bigint();
      const v = quietly(() => bp.classifyAction(action, page, opts));
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      assert.ok(RANK[v.status] >= RANK[bp.classifyActionJs(action, page).status], `case ${k}`);
      assert.ok(ms < 2000, `case ${k} ${opts.impl}: ${ms} ms`);
    }
    const t = process.hrtime.bigint();
    const text = '{{secret:'.repeat(200_000) + '{{secret:gh}}'.repeat(50_000);
    const r = quietly(() => bp.substituteSecrets(text, { gh: { value: 'v', domains: ['example.com'] } }, 'https://example.com', opts));
    assert.equal(r.ok, true);
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 2000);
  }
  // Over the module's cap: a refusal, so the switch asks (it never allows).
  const huge = { type: 'click', element: { tag: 'a', text: 'Home '.repeat(1_000_000) } };
  assert.equal(quietly(() => bp.classifyAction(huge, page, WASM)).status, 'needs_approval');
  assert.throws(() => davParseWasm.browserPolicyClassify(bp.actionProjection(huge, 'click'), bp.elementProjection(huge.element), bp.pageProjection(page, 'click')),
    (e) => e.reason === 'too_large');
});
