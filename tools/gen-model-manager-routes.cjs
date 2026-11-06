#!/usr/bin/env node
'use strict';
// The routes the native model manager serves, read from its Rust source, for
// server/model-loader-contract.test.cjs. The Python model-manager (services/model-manager/app/api.py,
// main.py) that this test used to scan was retired in noevia-services#216; the native
// `noevia-model-manager` in sbstndalton/noevia-rs registers the same API in one table, `ROUTES` in
// bins/noevia-model-manager/src/routing.rs (registration order), and caps models.ini writes with
// `MODELS_INI_MAX_BYTES` in src/section_writes/mod.rs.
//
//   NOEVIA_RS_REF=<sha> node tools/gen-model-manager-routes.cjs <noevia-rs checkout> > tests/fixtures/model-manager-routes.v1.json
//   node tools/gen-model-manager-routes.cjs --check <noevia-rs checkout>   # CI: the committed fixture is current
//
// The fixture is a transcript of those two Rust items, not a second source of truth: CI runs --check
// against the noevia-rs tarball it already fetches for dav-parse.wasm, so moving that pin onto a
// routing.rs with different routes fails until the fixture is regenerated (and the contract doc
// updated). `source.ref` is informational: it names the noevia-rs commit the fixture was read from.

const fs = require('node:fs');
const path = require('node:path');

const ROUTING = 'bins/noevia-model-manager/src/routing.rs';
const SECTION_WRITES = 'bins/noevia-model-manager/src/section_writes/mod.rs';
const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'model-manager-routes.v1.json');

function parseRoutes(src) {
  const table = /^const ROUTES: &\[\(&str, &str\)\] = &\[\n([\s\S]*?)^\];/m.exec(src);
  if (!table) throw new Error('routing.rs: the ROUTES table is not where it was');
  const routes = [];
  for (const line of table[1].split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('//')) continue;
    const m = /^\("(GET|POST|PUT|DELETE|PATCH)",\s*"(\/api\/v1\/[^"]*)"\),$/.exec(text);
    if (!m) throw new Error(`routing.rs: unreadable ROUTES row: ${text}`);
    routes.push([m[1], m[2]]);
  }
  if (routes.length < 30) throw new Error(`routing.rs: only ${routes.length} routes read`);
  return routes;
}

function parseModelsIniMaxBytes(src) {
  const m = /^pub const MODELS_INI_MAX_BYTES: usize = (\d+(?: \* \d+)*);$/m.exec(src);
  if (!m) throw new Error('section_writes/mod.rs: MODELS_INI_MAX_BYTES is not a plain product of integers');
  return m[1].split(' * ').reduce((a, b) => a * Number(b), 1);
}

function read(rsDir) {
  const at = (f) => fs.readFileSync(path.join(rsDir, f), 'utf8');
  return {
    version: 1,
    source: { repo: 'sbstndalton/noevia-rs', ref: process.env.NOEVIA_RS_REF || null, files: [ROUTING, SECTION_WRITES] },
    routes: parseRoutes(at(ROUTING)),
    modelsIniMaxBytes: parseModelsIniMaxBytes(at(SECTION_WRITES)),
  };
}

function render(fixture) {
  // One route per line keeps diffs reviewable.
  const rows = fixture.routes.map((r) => `    ${JSON.stringify(r)}`).join(',\n');
  return `{\n  "version": 1,\n  "source": ${JSON.stringify(fixture.source)},\n  "routes": [\n${rows}\n  ],\n  "modelsIniMaxBytes": ${fixture.modelsIniMaxBytes}\n}\n`;
}

module.exports = { parseRoutes, parseModelsIniMaxBytes, read, render, FIXTURE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  const rsDir = check ? args[1] : args[0];
  if (!rsDir) { console.error('usage: gen-model-manager-routes.cjs [--check] <noevia-rs checkout>'); process.exit(2); }
  const fresh = read(rsDir);
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
