'use strict';

// #1071: the JS references of the Rust ports live in tests/server/oracle/ as test oracles (fixture
// generators and differential tests only). Production code must never load one, or a "Rust only"
// path could quietly fall back to JS. This reads every production source file under server/ and
// fails if any of them mentions an oracle module in a require, import or path.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SERVER = __dirname;
const ORACLE = path.join(__dirname, '..', 'tests', 'server', 'oracle');

function productionFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'wasm') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(full));
    else if (/\.(cjs|js|mjs)$/.test(entry.name) && !/\.test\.(cjs|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const TOOLS = path.join(__dirname, '..', 'tools');

test('the oracle modules exist', { skip: !fs.existsSync(ORACLE) && 'no tests/server/oracle here' }, () => {
  const names = fs.readdirSync(ORACLE).filter((n) => n.endsWith('.cjs')).sort();
  assert.deepEqual(names, ['auth-tokens.cjs', 'chat-context.cjs', 'code-review-verdict.cjs', 'dav-listing.cjs', 'decision.cjs', 'mcp-servers.cjs', 'mcp.cjs', 'prompt-framing.cjs', 'provenance-policy.cjs', 'public-fetch.cjs', 's3-listing.cjs', 's3-sign.cjs', 'ssrf.cjs', 'task-packet.cjs', 'tool-exchange.cjs', 'tool-policy.cjs', 'upload-sniff.cjs']);
});

// The shipped web image has no tools/ (like the differential tests' "no generator here").
test('the oracle modules are the ones the fixture generators use', { skip: !fs.existsSync(TOOLS) && 'no tools/ here (no generators)' }, () => {
  for (const [tool, oracle] of [['gen-dav-listing-fixtures.cjs', 'dav-listing.cjs'], ['gen-storage-fixtures.cjs', 's3-listing.cjs'], ['gen-chat-template-caps-fixtures.cjs', 'chat-context.cjs'],
    ['gen-mcp-fixtures.cjs', 'mcp.cjs'], ['gen-upload-fixtures.cjs', 'upload-sniff.cjs'], ['gen-s3-sign-fixtures.cjs', 's3-sign.cjs'], ['gen-ssrf-fixtures.cjs', 'ssrf.cjs'], ['gen-ssrf-fixtures.cjs', 'public-fetch.cjs'],
    ['gen-prompt-framing-fixtures.cjs', 'prompt-framing.cjs'], ['gen-prompt-framing-fixtures.cjs', 'provenance-policy.cjs'], ['gen-prompt-framing-fixtures.cjs', 'task-packet.cjs'],
    ['gen-policy-leaves-fixtures.cjs', 'auth-tokens.cjs'], ['gen-policy-leaves-fixtures.cjs', 'tool-policy.cjs'], ['gen-code-review-verdict-fixtures.cjs', 'code-review-verdict.cjs'], ['gen-tool-exchange-fixtures.cjs', 'tool-exchange.cjs'],
    ['gen-decision-fixtures.cjs', 'decision.cjs'], ['gen-mcp-servers-fixtures.cjs', 'mcp-servers.cjs']]) {
    assert.match(fs.readFileSync(path.join(TOOLS, tool), 'utf8'), new RegExp(`tests/server/oracle/${oracle.replace('.', '\\.')}`));
  }
});

// A load of anything under an oracle directory: require('…oracle…'), import … from '…oracle…',
// import('…oracle…'), or a path built from an 'oracle' segment. Comments are stripped first, so the
// headers that say where the JS reference moved to are fine; the word alone is too (padding oracle).
const LOADS_ORACLE = [/require\s*\([^)]*oracle/i, /\bfrom\s*['"][^'"]*oracle/i, /\bimport\s*\([^)]*oracle/i, /path\.(?:join|resolve)\([^)]*['"]oracle['"]/i, /['"][^'"]*\/oracle\/[^'"]*['"]/i];
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

test('the comment stripper and the patterns catch what they should', () => {
  for (const bad of ["require('../tests/server/oracle/dav-listing.cjs')", 'require(`./oracle/x.cjs`)', "const { a } = await import('./oracle/x.cjs')", "import x from '../oracle/y.js'", "path.join(__dirname, 'oracle', 'x.cjs')"]) {
    assert.ok(LOADS_ORACLE.some((re) => re.test(withoutComments(bad))), bad);
  }
  for (const fine of ["// tests/server/oracle/dav-listing.cjs is the reference", "/* require('./oracle/x.cjs') */", "const padding = 'a padding oracle is avoided';", "require('./dav-listing.cjs')"]) {
    assert.ok(!LOADS_ORACLE.some((re) => re.test(withoutComments(fine))), fine);
  }
});

test('no production module under server/ requires an oracle module', () => {
  const files = productionFiles(SERVER);
  assert.ok(files.length > 50, 'the scan found the server sources');
  const offenders = files.filter((f) => LOADS_ORACLE.some((re) => re.test(withoutComments(fs.readFileSync(f, 'utf8'))))).map((f) => path.relative(SERVER, f));
  assert.deepEqual(offenders, []);
});

test('requiring the production modules does not load any oracle file', () => {
  for (const m of ['dav-listing', 's3-listing', 'chat-context', 'chat-template-caps', 'preset-reload', 'load-advisor', 'dav-parse-wasm', 'storage-client', 'upload-sniff', 's3-sign', 's3-region', 'mcp', 'ssrf', 'public-fetch', 'prompt-framing', 'provenance-policy', 'task-packet',
    'auth-tokens', 'tool-policy', 'code-review-verdict', 'tool-exchange', 'decision/index', 'mcp-servers', 'task-lifecycle', 'completeness-report', 'code-net-guard', 'llamacpp-autoconfig', 'jobs']) require(`./${m}.cjs`);
  const loaded = Object.keys(require.cache).filter((f) => f.startsWith(ORACLE + path.sep));
  assert.deepEqual(loaded, []);
});
