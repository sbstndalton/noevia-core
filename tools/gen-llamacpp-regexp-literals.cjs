'use strict';
// Offline compiler artifact: parse frozen syntax, never execute business source.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Module = require('node:module');
const parserModule = new Module('regexp-catalog-acorn');
parserModule._compile(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'], 'regexp-catalog-acorn.cjs');
const acorn = parserModule.exports;
const SOURCE_SHA = '66b436f5e2fda9719470fbc18bd92d7b1b52eb6e881885167cdbbebd02eaa040';
const PROGRAM_SHA = 'd7fd2370bb3ea66902518b126d2948b4c02bfd4cb855def2a226a849b263cd52';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const args = process.argv.slice(2), programFlag = args.indexOf('--program');
if (programFlag < 0 || !args[programFlag + 1]) throw Error('pass --program with the pinned Rust evaluator_program.rs');
const programFile = args[programFlag + 1];
const source = fs.readFileSync(path.join(__dirname, '../tests/reference/llamacpp-autoconfig-js.cjs'), 'utf8');
const program = fs.readFileSync(programFile, 'utf8');
if (hash(source) !== SOURCE_SHA) throw Error('frozen source checksum');
if (hash(program) !== PROGRAM_SHA) throw Error('Rust evaluator program checksum');
const sites = [];
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Literal' && node.regex) sites.push({ ...node.regex, literal: source.slice(node.start, node.end) });
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach(walk);
    else if (child && typeof child === 'object') walk(child);
  }
}
walk(acorn.parse(source, { ecmaVersion: 2022 }));
const quoteRust = value => JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => '\\u{' + h + '}');
const expected = sites.map(({ pattern, flags }) => 'Instruction::Host(0,' + quoteRust(JSON.stringify({ op: 'regexp', data: { pattern, flags } })) + '),');
const actual = program.split('\n').filter(line => line.startsWith('Instruction::Host(') && line.includes('\\"op\\":\\"regexp\\"'));
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Rust regexp metadata differs from frozen literal sites');
const unique = new Map();
for (const site of sites) {
  const key = JSON.stringify([site.pattern, site.flags]);
  if (!unique.has(key)) unique.set(key, site);
}
if (sites.length !== 4 || unique.size !== 3) throw Error('reviewed regexp literal count changed');
const patterns = new Map();
for (const site of unique.values()) {
  if (!patterns.has(site.pattern)) patterns.set(site.pattern, []);
  patterns.get(site.pattern).push(site);
}
let output = "'use strict';\n// Generated mechanical literal materializers; Rust selects every use and applies every operation.\n"
  + '// Frozen source SHA-256 ' + SOURCE_SHA + '\n// Rust program SHA-256 ' + PROGRAM_SHA + '\n'
  + '// Three unique literals at four Rust-selected sites. No business functions or decisions.\nconst catalog = {\n  __proto__: null,\n';
for (const [pattern, variants] of patterns) {
  output += '  [' + JSON.stringify(pattern) + ']: { __proto__: null,\n';
  for (const site of variants) output += '    [' + JSON.stringify(site.flags) + ']: () => ' + site.literal + ',\n';
  output += '  },\n';
}
output += "};\nfunction create(pattern, flags) {\n"
  + "  if (typeof pattern !== 'string' || typeof flags !== 'string') return undefined;\n"
  + "  const variants = catalog[pattern];\n"
  + "  const factory = variants === undefined ? undefined : variants[flags];\n"
  + "  return factory === undefined ? undefined : factory();\n}\nmodule.exports = { create };\n";
const out = path.join(__dirname, '../server/llamacpp-autoconfig-regexp-literals.cjs');
if (args.includes('--check')) {
  if (fs.readFileSync(out, 'utf8') !== output) throw Error('generated regexp literal catalog is stale');
} else fs.writeFileSync(out, output);
console.log(JSON.stringify({ sites: sites.length, unique: unique.size, sourceSHA256: SOURCE_SHA, programSHA256: PROGRAM_SHA, outputSHA256: hash(output), check: args.includes('--check') }));
