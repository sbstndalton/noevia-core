'use strict';
// tools/gen-model-manager-routes.cjs reads the native model manager's route table and models.ini cap
// out of Rust source for model-loader-contract.test.cjs. It must fail closed: a declaration that is
// commented out, quoted in a string, cfg-disabled, nested in a conditional module or declared twice
// can never stand in for the active one, or contract drift would pass unseen. The Rust snippets are in
// tests/fixtures/model-manager-routes-rs/; each negative case names the reason it must be refused.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const gen = require('../tools/gen-model-manager-routes.cjs');

const dir = path.join(__dirname, '..', 'tests', 'fixtures', 'model-manager-routes-rs');
const src = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const routes = (name) => gen.parseRoutes(src(name), { minRoutes: 1, file: name });
const cap = (name) => gen.parseModelsIniMaxBytes(src(name), { file: name });
const ENABLED = new Set(['native-routing', 'native-section-writes']);
const mod = (name, which = 'routing') => gen.checkModuleDeclaration(src(name), which, ENABLED, { file: name });

test('the active table is read, whatever else the file quotes or comments out', () => {
  assert.deepEqual(routes('routes-ok.rs'), [['GET', '/api/v1/overview'], ['GET', '/api/v1/models']]);
  // The old two-route table survives only inside comments; the active one dropped /api/v1/models.
  assert.deepEqual(routes('routes-ok-old-copy-commented.rs'), [['GET', '/api/v1/overview']]);
  // Fake tables inside a string and a raw string are inert.
  assert.deepEqual(routes('routes-ok-string-fake-beside-real.rs'), [['GET', '/api/v1/overview']]);
});

for (const [file, reason] of [
  ['routes-bad-cfg.rs', /2 `ROUTES` declarations|conditional compilation/],
  ['routes-bad-cfg-attr.rs', /cfg_attr.*conditional compilation/],
  ['routes-bad-cfg-module.rs', /nested inside another item/],
  ['routes-bad-inline-module.rs', /nested inside another item/],
  ['routes-bad-inner-cfg.rs', /inner attribute #!\[cfg/],
  ['routes-bad-commented.rs', /no active `ROUTES` declaration/],
  ['routes-bad-duplicate.rs', /2 `ROUTES` declarations/],
  ['routes-bad-string-only.rs', /no active `ROUTES` declaration/],
  ['routes-bad-entry-cfg.rs', /unreadable ROUTES entry/],
]) {
  test(`ROUTES is refused: ${file}`, () => assert.throws(() => routes(file), reason));
}

test('a cfg-disabled old table plus a cfg-enabled new one is refused, not resolved to either', () => {
  // The scenario that motivated the fail-closed rule: #[cfg(any())] old table, #[cfg(not(any()))] new one.
  assert.throws(() => routes('routes-bad-cfg.rs'), /ROUTES/);
});

test('the models.ini cap is read from the active declaration only', () => {
  assert.equal(cap('cap-ok.rs'), 1048576);
  assert.equal(cap('cap-ok-old-commented.rs'), 524288, 'a commented 1 MiB cap must not mask the active 512 KiB one');
});

for (const [file, reason] of [
  ['cap-bad-cfg.rs', /conditional compilation/],
  ['cap-bad-cfg-module.rs', /nested inside another item/],
  ['cap-bad-commented.rs', /no active `MODELS_INI_MAX_BYTES` declaration/],
  ['cap-bad-duplicate.rs', /2 `MODELS_INI_MAX_BYTES` declarations/],
  ['cap-bad-string-only.rs', /no active `MODELS_INI_MAX_BYTES` declaration/],
  ['cap-bad-expression.rs', /not a plain product of integers/],
]) {
  test(`MODELS_INI_MAX_BYTES is refused: ${file}`, () => assert.throws(() => cap(file), reason));
}

test('the module declaration is accepted only when gated by nothing but an enabled feature', () => {
  mod('lib-ok.rs', 'routing');
  mod('lib-ok.rs', 'section_writes');
});

for (const [file, reason] of [
  ['lib-bad-feature-not-enabled.rs', /gated on feature "off-feature"/],
  ['lib-bad-cfg-any.rs', /only #\[cfg\(feature/],
  ['lib-bad-cfg-compound.rs', /only #\[cfg\(feature/],
  ['lib-bad-cfg-attr.rs', /only #\[cfg\(feature/],
  ['lib-bad-path.rs', /only #\[cfg\(feature/],
  ['lib-bad-duplicate.rs', /2 `mod routing` declarations/],
  ['lib-bad-nested.rs', /nested inside another item/],
  ['lib-bad-commented.rs', /no `mod routing` declaration/],
  ['lib-bad-inline.rs', /not a plain `mod routing;`/],
]) {
  test(`mod routing is refused: ${file}`, () => assert.throws(() => mod(file), reason));
}

test('the lexer keeps literals opaque: lifetimes, chars, nested comments and raw strings', () => {
  const toks = gen.lex("fn f<'a>(x: &'a str) -> char { '\"' } /* /* x */ \"y\" */ const A: &str = r##\"a\"# b\"##; // \"c\"\n");
  assert.deepEqual(toks.filter((t) => t.t === 'str').map((t) => t.v), ['a"# b']);
  assert.ok(toks.some((t) => t.t === 'life' && t.v === "'a"));
  assert.throws(() => gen.lex('/* open'), /unterminated block comment/);
  assert.throws(() => gen.lex('const A: &str = "open;'), /unterminated string/);
  assert.throws(() => gen.lex('fn f( {'), /unbalanced|unclosed/);
});

test('the shipped features come from the final stage\'s copied build and the crate feature graph', () => {
  const dockerfile = [
    'FROM rust AS legacy-builder', 'RUN cargo build --release -p noevia-model-manager --features noevia-model-manager/native-legacy-only',
    'FROM rust AS gguf-meta', 'WORKDIR /src', 'RUN cargo build --release -p noevia-model-manager --features noevia-model-manager/native-routing,noevia-model-manager/native-section-writes',
    'FROM debian AS runtime', 'COPY --from=gguf-meta /src/target/release/noevia-model-manager /usr/local/bin/noevia-model-manager',
    'FROM runtime AS production',
  ].join('\n');
  const cargo = '[features]\ndefault = []\n# a comment\nnative-routing = ["native-a", "dep:x"]\nnative-a = []\nnative-section-writes = [\n  "native-a", # trailing\n]\nnative-legacy-only = []\n[lints]\n';
  const enabled = gen.enabledFeatures(dockerfile, cargo);
  assert.deepEqual([...enabled].sort(), ['native-a', 'native-routing', 'native-section-writes']);
  assert.throws(() => gen.enabledFeatures(dockerfile.replace('COPY --from=gguf-meta', 'COPY --from=other'), cargo), /does not name a stage/);
  assert.throws(() => gen.enabledFeatures(dockerfile, cargo.replace('native-a = []', '')), /not declared/);
  // The proof itself is exercised in dockerfile-model-manager-features.test.cjs.
});
