'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const server = path.resolve(__dirname, '../server');
const fixturePath = path.resolve(__dirname, '../tests/fixtures/llamacpp-autoconfig.v1.json');
const oraclePath = path.resolve(__dirname, '../tests/reference/llamacpp-autoconfig-js.cjs');
const wasmPath = process.env.DAV_PARSE_WASM;
if (!wasmPath || !fs.existsSync(wasmPath)) throw new Error('DAV_PARSE_WASM must name the checksum-bound qualification module');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const oracle = require(oraclePath);
const wasm = require(path.join(server, 'dav-parse-wasm.cjs'));
const loader = () => wasm;
const quiet = console.warn;
console.warn = () => {};
const GIB = 1024 ** 3;
const meta = { arch: 'llama', contextLength: 131072, embeddingLength: 4096, blockCount: 32, headCount: 32, headCountKv: 8, hasChatTemplate: true };
const rawNumberCases = [
  ['suggest-budget-nan', 1, { meta, modelBytes: GIB, budgetGib: NaN, current: { 'ctx-size': NaN } }],
  ['inputs-modelbytes-nan', 2, { meta, modelBytes: NaN, current: { 'ctx-size': Infinity, 'ubatch-size': -Infinity } }],
  ['footprint-context-infinity', 3, { meta, modelBytes: GIB, options: { 'ctx-size': Infinity, 'cache-ram': '1024' } }],
  ['footprint-cache-unbounded-nan-context', 3, { meta, modelBytes: GIB, options: { 'cache-ram': -1, 'ctx-size': NaN } }],
  ['footprint-nan-cache-scale', 3, { meta, modelBytes: GIB, options: { 'cache-type-k': 'constructor' } }],
  ['footprint-context-negative-infinity', 3, { meta, modelBytes: GIB, options: { 'ctx-size': -Infinity, 'cache-ram': '1024' } }],
];
function typedNumbers(value, path = [], out = []) {
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
    const kind = Number.isNaN(value) ? 'nan' : value === Infinity ? 'positive-infinity' : value === -Infinity ? 'negative-infinity' : 'negative-zero';
    out.push({ path, kind });
  } else if (Array.isArray(value)) value.forEach((item, i) => typedNumbers(item, [...path, i], out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) typedNumbers(item, [...path, key], out);
  return out;
}
function serializedOutcome(fn, args) {
  try { return { kind: 'return', json: JSON.stringify(fn(args, { wasmLoader: loader })) }; }
  catch (err) { return { kind: 'throw', name: err?.name, code: err?.code, status: err?.status, message: err?.message }; }
}
const rawRows = rawNumberCases.map(([name, op, args]) => ({
  name, op, wire: JSON.stringify(args), numbers: typedNumbers(args),
  result: serializedOutcome(({ 1: oracle.suggest, 2: oracle.estimateInputs, 3: oracle.estimateFootprint })[op], args),
}));

const rows = fixtures.strict.map((row, index) => {
  const args = JSON.parse(row.wire);
  const fn = ({ 1: oracle.suggest, 2: oracle.estimateInputs, 3: oracle.estimateFootprint })[row.op];
  let result;
  try { result = { kind: 'return', value: fn(args, { wasmLoader: loader }) }; }
  catch (err) { result = { kind: 'throw', name: err?.name, code: err?.code, status: err?.status, message: err?.message }; }
  return { index, op: row.op, wire: row.wire, result };
});
console.warn = quiet;
process.stdout.write(JSON.stringify({
  version: 1,
  sourceOracleSha256: hash(oraclePath),
  fixtureSha256: hash(fixturePath),
  wasmSha256: hash(wasmPath),
  strictCount: rows.length,
  rows,
  rawNumberCount: rawRows.length,
  rawNumberRows: rawRows,
}, null, 2) + '\n');
