#!/usr/bin/env node
'use strict';
// The routes the native model manager serves, read from its Rust source, for
// server/model-loader-contract.test.cjs. The Python model-manager (services/model-manager/app/api.py,
// main.py) that this test used to scan was retired in noevia-services#216; the native
// `noevia-model-manager` in sbstndalton/noevia-rs registers the same API in one table, `ROUTES` in
// bins/noevia-model-manager/src/routing.rs (registration order), and caps models.ini writes with
// `MODELS_INI_MAX_BYTES` in src/section_writes/mod.rs.
//
//   NOEVIA_RS_REF=<sha> node tools/gen-model-manager-routes.cjs --image-dockerfile <services>/model-manager/Dockerfile \
//       <noevia-rs checkout> > tests/fixtures/model-manager-routes.v1.json
//   node tools/gen-model-manager-routes.cjs --check --image-dockerfile ../../services/model-manager/Dockerfile <noevia-rs checkout>
//
// The fixture is a transcript of those two Rust items, not a second source of truth: CI runs --check
// against the noevia-rs tarball it already fetches for dav-parse.wasm, so moving that pin onto a
// routing.rs with different routes fails until the fixture is regenerated (and the contract doc
// updated). `source.ref` is informational: it names the noevia-rs commit the fixture was read from.
//
// FAIL CLOSED. A declaration is accepted only when it is provably the one the compiler uses, so a
// copy that is commented out, quoted in a string, cfg-disabled, nested in a conditional module or
// declared twice can never stand in for the real one. The source is lexed first (comments, nested
// block comments, string/raw-string/char literals and lifetimes are removed or made opaque), then:
//   - exactly one `const|static NAME` exists in the file, at the top level (not inside any `{}`,
//     `()` or `[]`: no enclosing module, fn, impl or macro), at an item boundary;
//   - the declaration carries no attribute other than `allow`, and the file no inner attribute other
//     than lint levels: `#[cfg]`, `#[cfg_attr]`, `#[path]` and the rest are errors;
//   - the file's own `mod` declaration in lib.rs is unique, top level, and gated by nothing but
//     `#[cfg(feature = "F")]` where F is a feature the shipped image enables (see below);
//   - the table rows are plain `("METHOD", "/api/v1/...")` tuples; anything else is an error.
// Every refusal names the reason. Unsupported syntax is rejected, never guessed at.
//
// Cargo features: lib.rs gates `routing` and `section_writes` on `native-routing` and
// `native-section-writes`. The generator proves those are on from the image's own build command
// (the one `cargo build ... -p noevia-model-manager --features noevia-model-manager/...` line of
// services/model-manager/Dockerfile) plus the feature graph in the crate's Cargo.toml; a feature it
// cannot show enabled is an error. `--image-dockerfile` is therefore required.

const fs = require('node:fs');
const path = require('node:path');

const CRATE = 'bins/noevia-model-manager';
const FILES = {
  routing: `${CRATE}/src/routing.rs`,
  sectionWrites: `${CRATE}/src/section_writes/mod.rs`,
  lib: `${CRATE}/src/lib.rs`,
  cargo: `${CRATE}/Cargo.toml`,
};
const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'model-manager-routes.v1.json');
const ALLOWED_ATTRS = new Set(['allow']);
const ALLOWED_INNER_ATTRS = new Set(['allow', 'warn', 'deny', 'forbid', 'doc']);

// ---- lexer -------------------------------------------------------------------------------------

const isIdStart = (c) => c !== undefined && (/[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127);
const isIdPart = (c) => c !== undefined && (/[A-Za-z0-9_]/.test(c) || c.charCodeAt(0) > 127);

// Tokens: { t: 'id'|'str'|'num'|'p'|'life'|'chr', v, d } where d is the bracket depth the token sits at.
// Comments vanish; every kind of literal is one opaque token, so nothing inside a string or comment
// can be mistaken for code.
function lex(src) {
  const toks = [];
  const stack = [];
  const n = src.length;
  let i = 0;
  const fail = (what) => { throw new Error(`rust source not readable: ${what} (offset ${i})`); };
  const push = (t, v, extra) => toks.push({ t, v, d: stack.length, ...extra });
  function string(open, pre) { // `open` is the index of the opening quote
    let j = open + 1, esc = false;
    for (;;) {
      if (j >= n) { i = open; fail('unterminated string literal'); }
      if (src[j] === '\\') { esc = true; j += 2; continue; }
      if (src[j] === '"') break;
      j++;
    }
    push('str', src.slice(open + 1, j), { pre, esc, raw: false });
    i = j + 1;
  }
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      let level = 1; const start = i; i += 2;
      while (level) {
        if (i >= n) { i = start; fail('unterminated block comment'); }
        if (src.startsWith('/*', i)) { level++; i += 2; } else if (src.startsWith('*/', i)) { level--; i += 2; } else i++;
      }
      continue;
    }
    if (c === '"') { string(i, ''); continue; }
    if (isIdStart(c)) {
      let j = i; while (isIdPart(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 'r' || word === 'br' || word === 'cr') {
        let k = j, hashes = 0; while (src[k] === '#') { k++; hashes++; }
        if (src[k] === '"') {
          const marker = '"' + '#'.repeat(hashes), end = src.indexOf(marker, k + 1);
          if (end < 0) fail('unterminated raw string literal');
          push('str', src.slice(k + 1, end), { pre: word, esc: false, raw: true });
          i = end + marker.length; continue;
        }
        if (word === 'r' && hashes === 1 && isIdStart(src[k])) { // r#ident
          let e = k; while (isIdPart(src[e])) e++;
          push('id', src.slice(k, e), { rawIdent: true }); i = e; continue;
        }
      }
      if ((word === 'b' || word === 'c') && src[j] === '"') { string(j, word); continue; }
      if (word === 'b' && src[j] === "'") { i = j; /* byte char: fall into the char branch below */ } else { push('id', word); i = j; continue; }
    }
    if (src[i] === "'") {
      if (src[i + 1] === '\\') {
        const e = src.indexOf("'", i + 3); if (e < 0) fail('unterminated char literal');
        push('chr', src.slice(i, e + 1)); i = e + 1; continue;
      }
      const cp = src.codePointAt(i + 1), len = cp > 0xffff ? 2 : 1;
      if (cp !== undefined && src[i + 1 + len] === "'") { push('chr', src.slice(i, i + 2 + len)); i += 2 + len; continue; }
      let j = i + 1; while (isIdPart(src[j])) j++;
      push('life', src.slice(i, j)); i = j; continue;
    }
    if (/[0-9]/.test(c)) { let j = i; while (/[0-9A-Za-z_]/.test(src[j] || '')) j++; push('num', src.slice(i, j)); i = j; continue; }
    if ('([{'.includes(c)) { push('p', c); stack.push(c); i++; continue; }
    if (')]}'.includes(c)) {
      const want = { ')': '(', ']': '[', '}': '{' }[c];
      if (stack.pop() !== want) fail(`unbalanced '${c}'`);
      push('p', c); i++; continue;
    }
    push('p', c); i++;
  }
  if (stack.length) fail('unclosed bracket at end of file');
  return toks;
}

const is = (tok, t, v) => tok !== undefined && tok.t === t && (v === undefined || tok.v === v);
const text = (toks) => toks.map((x) => (x.t === 'str' ? JSON.stringify(x.v) : x.v)).join(' ');

function matchBack(toks, close, open, from) { // index of the opener matching toks[from] === close
  let level = 0;
  for (let q = from; q >= 0; q--) {
    if (is(toks[q], 'p', close)) level++;
    else if (is(toks[q], 'p', open) && --level === 0) return q;
  }
  throw new Error('rust source not readable: unbalanced attribute');
}

// Inner attributes (`#![...]`) at the top level of a file.
function checkInnerAttributes(toks, file) {
  for (let k = 0; k + 2 < toks.length; k++) {
    if (!(is(toks[k], 'p', '#') && is(toks[k + 1], 'p', '!') && is(toks[k + 2], 'p', '[') && toks[k].d === 0)) continue;
    const name = toks[k + 3] && toks[k + 3].v;
    if (!ALLOWED_INNER_ATTRS.has(name)) throw new Error(`${file}: inner attribute #![${name}...] at the top of the file could disable its items (only lint-level attributes are accepted)`);
  }
}

// The item whose keyword (`const`, `static`, `mod`) is toks[k]: its visibility and outer attributes.
// Returns the attributes as token slices. Fails unless the item is top level and starts at an item boundary.
function itemContext(toks, k, what, file) {
  if (toks[k].d !== 0) throw new Error(`${file}: ${what} is nested inside another item or macro, so it is not provably the one compiled`);
  let p = k - 1;
  if (is(toks[p], 'p', ')')) { const q = matchBack(toks, ')', '(', p); if (!is(toks[q - 1], 'id', 'pub')) throw new Error(`${file}: ${what} is preceded by unreadable tokens`); p = q - 2; }
  else if (is(toks[p], 'id', 'pub')) p--;
  const attrs = [];
  while (p >= 0 && is(toks[p], 'p', ']')) {
    const q = matchBack(toks, ']', '[', p);
    if (is(toks[q - 1], 'p', '#')) { attrs.push(toks.slice(q + 1, p)); p = q - 2; continue; }
    if (is(toks[q - 1], 'p', '!') && is(toks[q - 2], 'p', '#')) break; // an inner attribute (#![...]) ends the previous "item"
    throw new Error(`${file}: ${what} is preceded by an unreadable bracketed expression`);
  }
  if (p >= 0 && !(is(toks[p], 'p', ';') || is(toks[p], 'p', '}') || is(toks[p], 'p', ']'))) throw new Error(`${file}: ${what} is not at the start of an item`);
  return { attrs };
}

function declarations(toks, name) { // every `const|static NAME` at any depth
  const out = [];
  for (let k = 0; k + 1 < toks.length; k++) if ((is(toks[k], 'id', 'const') || is(toks[k], 'id', 'static')) && is(toks[k + 1], 'id', name)) out.push(k);
  return out;
}

function onlyDeclaration(toks, name, file) {
  const found = declarations(toks, name);
  if (found.length === 0) throw new Error(`${file}: no active \`${name}\` declaration (commented out, inside a string, or missing)`);
  if (found.length > 1) throw new Error(`${file}: ${found.length} \`${name}\` declarations; refusing to pick one`);
  return found[0];
}

function checkPlainAttributes(ctx, what, file) {
  for (const attr of ctx.attrs) {
    const head = attr[0] && attr[0].v;
    if (!ALLOWED_ATTRS.has(head)) throw new Error(`${file}: ${what} carries #[${text(attr)}]${head === 'cfg' || head === 'cfg_attr' ? ' (conditional compilation)' : ''}; only #[allow] is accepted, so it cannot be shown active`);
  }
}

function expect(toks, p, parts, file, what) { // parts: [type, value?] pairs
  for (const [t, v] of parts) {
    if (!is(toks[p], t, v)) throw new Error(`${file}: ${what} is not in the expected form (wanted ${v || t}, found ${toks[p] ? toks[p].v : 'end of file'})`);
    p++;
  }
  return p;
}

// ---- the two items -----------------------------------------------------------------------------

function parseRoutes(src, { minRoutes = 30, file = 'routing.rs' } = {}) {
  const toks = lex(src);
  checkInnerAttributes(toks, file);
  const k = onlyDeclaration(toks, 'ROUTES', file);
  checkPlainAttributes(itemContext(toks, k, 'ROUTES', file), 'ROUTES', file);
  let p = expect(toks, k + 2, [['p', ':'], ['p', '&'], ['p', '['], ['p', '('], ['p', '&'], ['id', 'str'], ['p', ','], ['p', '&'], ['id', 'str'], ['p', ')'], ['p', ']'], ['p', '='], ['p', '&'], ['p', '[']], file, 'the ROUTES type');
  const routes = [];
  while (is(toks[p], 'p', '(')) {
    const row = toks.slice(p, p + 5);
    if (!(is(row[1], 'str') && is(row[2], 'p', ',') && is(row[3], 'str') && is(row[4], 'p', ')'))) throw new Error(`${file}: unreadable ROUTES entry near token ${p}`);
    for (const s of [row[1], row[3]]) if (s.pre || s.esc || s.raw) throw new Error(`${file}: ROUTES entry uses an escaped, raw or prefixed string`);
    if (!/^(GET|POST|PUT|DELETE|PATCH)$/.test(row[1].v) || !/^\/api\/v1\/[^"]*$/.test(row[3].v)) throw new Error(`${file}: ROUTES entry ${JSON.stringify([row[1].v, row[3].v])} is not a method and an /api/v1 path`);
    routes.push([row[1].v, row[3].v]);
    p += 5;
    if (is(toks[p], 'p', ',')) p++;
    else if (!is(toks[p], 'p', ']')) throw new Error(`${file}: ROUTES entries are not comma-separated`);
  }
  if (!is(toks[p], 'p', ']')) throw new Error(`${file}: unreadable ROUTES entry near token ${p}`);
  expect(toks, p, [['p', ']'], ['p', ';']], file, 'the end of the ROUTES table');
  if (routes.length < minRoutes) throw new Error(`${file}: only ${routes.length} routes read from ROUTES`);
  return routes;
}

function parseModelsIniMaxBytes(src, { file = 'section_writes/mod.rs' } = {}) {
  const toks = lex(src);
  checkInnerAttributes(toks, file);
  const k = onlyDeclaration(toks, 'MODELS_INI_MAX_BYTES', file);
  checkPlainAttributes(itemContext(toks, k, 'MODELS_INI_MAX_BYTES', file), 'MODELS_INI_MAX_BYTES', file);
  let p = expect(toks, k + 2, [['p', ':'], ['id', 'usize'], ['p', '=']], file, 'the MODELS_INI_MAX_BYTES type');
  let value = 1;
  for (;;) {
    if (!is(toks[p], 'num') || !/^\d+(_\d+)*$/.test(toks[p].v)) throw new Error(`${file}: MODELS_INI_MAX_BYTES is not a plain product of integers`);
    value *= Number(toks[p].v.replace(/_/g, '')); p++;
    if (is(toks[p], 'p', '*')) { p++; continue; }
    break;
  }
  if (!is(toks[p], 'p', ';')) throw new Error(`${file}: MODELS_INI_MAX_BYTES is not a plain product of integers`);
  p++;
  if (!Number.isSafeInteger(value)) throw new Error(`${file}: MODELS_INI_MAX_BYTES overflows`);
  return value;
}

// ---- the enclosing module ----------------------------------------------------------------------

// `mod NAME;` must exist once at the top of lib.rs and be gated by nothing except
// #[cfg(feature = "F")] with F in `enabled` (the features the shipped image builds with).
function checkModuleDeclaration(libSrc, name, enabled, { file = 'lib.rs' } = {}) {
  const toks = lex(libSrc);
  checkInnerAttributes(toks, file);
  const found = [];
  for (let k = 0; k + 1 < toks.length; k++) if (is(toks[k], 'id', 'mod') && is(toks[k + 1], 'id', name)) found.push(k);
  if (found.length === 0) throw new Error(`${file}: no \`mod ${name}\` declaration`);
  if (found.length > 1) throw new Error(`${file}: ${found.length} \`mod ${name}\` declarations; refusing to pick one`);
  const k = found[0], what = `mod ${name}`;
  if (!is(toks[k + 2], 'p', ';')) throw new Error(`${file}: \`mod ${name}\` is not a plain \`mod ${name};\` file module`);
  const ctx = itemContext(toks, k, what, file);
  for (const attr of ctx.attrs) {
    const head = attr[0] && attr[0].v;
    if (head === 'allow') continue;
    const shape = attr.length === 6 && is(attr[0], 'id', 'cfg') && is(attr[1], 'p', '(') && is(attr[2], 'id', 'feature') && is(attr[3], 'p', '=') && is(attr[4], 'str') && is(attr[5], 'p', ')');
    if (!shape || attr[4].pre || attr[4].esc) throw new Error(`${file}: ${what} carries #[${text(attr)}]; only #[cfg(feature = "...")] on an enabled feature is accepted`);
    if (!enabled.has(attr[4].v)) throw new Error(`${file}: ${what} is gated on feature "${attr[4].v}", which the shipped image build does not enable`);
  }
}

// ---- features the image enables ----------------------------------------------------------------

// The production binary is the one the `gguf-meta` build stage compiles (the `runtime` stage, and so
// `production`, copies it from there); the legacy and qualification stages build other configurations.
function imageFeatures(dockerfileText) {
  if (!/^COPY --from=gguf-meta \/src\/target\/release\/noevia-model-manager /m.test(dockerfileText)) throw new Error('Dockerfile: the image no longer copies noevia-model-manager from the gguf-meta stage');
  const stage = /^FROM [^\n]* AS gguf-meta\s*$([\s\S]*?)(?=^FROM |(?![\s\S]))/m.exec(dockerfileText);
  if (!stage) throw new Error('Dockerfile: no gguf-meta build stage');
  const lines = stage[1].split('\n').filter((l) => /\bcargo build\b/.test(l) && /(^|\s)-p noevia-model-manager(\s|$)/.test(l) && /--features\s/.test(l));
  if (lines.length !== 1) throw new Error(`Dockerfile: expected exactly one \`cargo build -p noevia-model-manager --features ...\` line in the gguf-meta stage, found ${lines.length}`);
  const list = /--features\s+([^\s\\]+)/.exec(lines[0])[1];
  const mine = list.split(',').filter((f) => f.startsWith('noevia-model-manager/')).map((f) => f.slice('noevia-model-manager/'.length));
  if (mine.length === 0) throw new Error('Dockerfile: the model-manager build enables no noevia-model-manager features');
  return mine;
}

function featureGraph(cargoText) {
  const section = /^\[features\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargoText);
  if (!section) throw new Error('Cargo.toml: no [features] table');
  const body = section[1].split('\n').map((l) => l.replace(/\s#.*$|^\s*#.*$/, '')).join('\n');
  const graph = new Map();
  for (const m of body.matchAll(/(?:^|\n)\s*([\w-]+)\s*=\s*\[([^\]]*)\]/g)) {
    graph.set(m[1], [...m[2].matchAll(/"([^"]*)"/g)].map((s) => s[1]).filter((s) => !s.startsWith('dep:') && !s.includes('/')));
  }
  return graph;
}

function enabledFeatures(dockerfileText, cargoText) {
  const graph = featureGraph(cargoText);
  const out = new Set();
  const todo = [...imageFeatures(dockerfileText), ...(graph.get('default') || [])];
  while (todo.length) {
    const f = todo.pop();
    if (out.has(f)) continue;
    if (!graph.has(f)) throw new Error(`Cargo.toml: the image enables feature "${f}", which is not declared`);
    out.add(f); todo.push(...graph.get(f));
  }
  return out;
}

// ---- fixture -----------------------------------------------------------------------------------

function read(rsDir, dockerfile) {
  const at = (f) => fs.readFileSync(path.join(rsDir, f), 'utf8');
  if (!dockerfile) throw new Error('--image-dockerfile is required: the cargo features that gate routing and section_writes must be proven enabled');
  const enabled = enabledFeatures(fs.readFileSync(dockerfile, 'utf8'), at(FILES.cargo));
  for (const m of ['routing', 'section_writes']) checkModuleDeclaration(at(FILES.lib), m, enabled, { file: FILES.lib });
  return {
    version: 1,
    source: { repo: 'sbstndalton/noevia-rs', ref: process.env.NOEVIA_RS_REF || null, files: [FILES.routing, FILES.sectionWrites, FILES.lib, FILES.cargo] },
    routes: parseRoutes(at(FILES.routing), { file: FILES.routing }),
    modelsIniMaxBytes: parseModelsIniMaxBytes(at(FILES.sectionWrites), { file: FILES.sectionWrites }),
  };
}

function render(fixture) {
  // One route per line keeps diffs reviewable.
  const rows = fixture.routes.map((r) => `    ${JSON.stringify(r)}`).join(',\n');
  return `{\n  "version": 1,\n  "source": ${JSON.stringify(fixture.source)},\n  "routes": [\n${rows}\n  ],\n  "modelsIniMaxBytes": ${fixture.modelsIniMaxBytes}\n}\n`;
}

module.exports = { lex, parseRoutes, parseModelsIniMaxBytes, checkModuleDeclaration, imageFeatures, featureGraph, enabledFeatures, read, render, FIXTURE };

if (require.main === module) {
  const args = process.argv.slice(2);
  let check = false, dockerfile = null, rsDir = null;
  for (let a = 0; a < args.length; a++) {
    if (args[a] === '--check') check = true;
    else if (args[a] === '--image-dockerfile') dockerfile = args[++a];
    else rsDir = args[a];
  }
  if (!rsDir) { console.error('usage: gen-model-manager-routes.cjs [--check] --image-dockerfile <Dockerfile> <noevia-rs checkout>'); process.exit(2); }
  let fresh;
  try { fresh = read(rsDir, dockerfile); } catch (e) { console.error(`gen-model-manager-routes: ${e.message}`); process.exit(1); }
  if (!check) { process.stdout.write(render(fresh)); process.exit(0); }
  const committed = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  // `source` is informational; the routes (order included) and the cap must match the Rust source.
  const same = JSON.stringify(committed.routes) === JSON.stringify(fresh.routes) && committed.modelsIniMaxBytes === fresh.modelsIniMaxBytes;
  if (!same) {
    console.error('tests/fixtures/model-manager-routes.v1.json differs from the noevia-rs model manager source; regenerate it with tools/gen-model-manager-routes.cjs and update docs/spec-model-loader-api-v1.md');
    process.exit(1);
  }
  console.log(`model-manager-routes fixture current (${fresh.routes.length} routes)`);
}
