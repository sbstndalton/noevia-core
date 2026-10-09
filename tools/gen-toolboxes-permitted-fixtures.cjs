#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for TOOLBOXES_PERMITTED_IMPL: toolboxes-permitted.cjs's carried
// box ids and per-turn catalogue. The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/toolboxes-permitted/tests/fixtures/toolboxes-permitted.v1.json); noevia-core CI compares
// them.
//   node tools/gen-toolboxes-permitted-fixtures.cjs > tests/fixtures/toolboxes-permitted.v1.json
//
// Each row is { op, wire, want }: `wire` is the JSON the host sends after the op byte (the
// module's own projections; for the catalogue, of what a recorded JS run read from its callbacks),
// `want` the exact reply text the port must give, which is the JS's own answer. The port is never
// stricter here by design, so there are no strict rows. Nothing depends on ICU or the module: ids
// are compared, never folded. All accounts, projects and boxes are synthetic; the random
// combinations come from a seeded mulberry32.

const path = require('node:path');
const tp = require(path.join(__dirname, '..', 'server', 'toolboxes-permitted.cjs'));
const DOCS = require(path.join(__dirname, '..', 'server', 'project-docs-default.cjs')).BOX;

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x7b0c5e5);
const pick = (list) => list[Math.floor(rand() * list.length)];

const rows = [];
const seen = new Set();
function push(op, args, want) {
  const wire = JSON.stringify(args);
  const key = `${op}:${wire}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({ op, wire, want: JSON.stringify(want) });
}
const idOf = (x) => (typeof x === 'string' ? x : null);
const ids = (list) => ({ ids: Array.from(list, idOf) });

const DEFAULTS = [['core'], ['core', 'web'], [], ['core', DOCS], ['web', 'diary', 'gmail']];
const PROJECTS = [null, undefined, 0, '', 'string project', {}, { toolboxes: [] }, { toolboxes: ['core', 'web'] }, { toolboxes: ['web', 'gmail', 'diary'] },
  { toolboxes: 'core' }, { toolboxes: ['core', 7, null, undefined, { id: 'x' }] }, { toolsMode: 'auto' }, { toolsMode: 'auto', toolboxes: [DOCS] },
  { toolsMode: 'auto', docsToolboxDefaulted: true, toolboxes: [DOCS, 'web'] }, { toolsMode: 'auto', docsToolboxDefaulted: 'yes', toolboxes: [DOCS] },
  { toolsMode: 'auto', docsToolboxDefaulted: true, toolboxes: 'project-docs' }, { toolsMode: 'manual', toolboxes: [DOCS] }, { toolsMode: 'AUTO', toolboxes: ['x'] },
  { toolsMode: 'auto', docsToolboxDefaulted: true, toolboxes: ['web'] }, { toolboxes: ['core', 'core', 'gmail', 'notion'] }];
const CONNECTORS = [new Set(), new Set(['gmail', 'notion']), new Set(['gmail', 'core'])];
const CONNECTED = [[], ['gmail'], ['notion', 'gmail'], ['gmail', 'gmail']];

const projectFor = (p) => tp.projectProjection(p);
// ops 1 and 2.
for (const project of PROJECTS) for (const defaults of DEFAULTS) {
  push(1, [projectFor(project), tp.idsProjection(defaults), DOCS], ids(tp.projectToolboxIdsJs(project, defaults)));
  for (const connectorBoxes of CONNECTORS) for (const connected of CONNECTED) {
    push(2, [projectFor(project), tp.idsProjection(defaults), DOCS, [...connectorBoxes], tp.idsProjection(connected)],
      ids(tp.selectedToolboxIdsJs({ project, defaultToolboxes: defaults, connectorBoxes, connected })));
  }
}

// op 3: the catalogue.
const fn = (name, description) => ({ type: 'function', function: { name, ...(description === undefined ? {} : { description }) } });
const TOOL_NAMES = ['read_file', 'write_file', 'web_search', 'send_email', 'diary_read_month', 'diary_write', 'list', 'delete_item', 'calc', 'notion_search'];
const WRITES = new Set(['write_file', 'send_email', 'diary_write', 'delete_item']);
const BOX_IDS = ['core', 'web', 'diary', 'gmail', 'notion', 'sso-mcp', 'files', DOCS, 'other'];
function makeBox(id) {
  const tools = [];
  const n = Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) tools.push(fn(pick(TOOL_NAMES), pick([undefined, '', 'Does a thing.', 'd'.repeat(300)])));
  if (rand() < 0.1) tools.push(null, { function: {} }, fn(''));
  return { id, label: `${id} box`, description: 'synthetic', source: pick(['builtin', 'mcp']), tools };
}
const MANIFESTS = [[], [{ id: 'sso-mcp', label: 'SSO' }], [{ id: 'down-mcp' }, null, { id: 'diary' }, { id: 'core' }], [{ id: 7 }, { label: 'no id' }, { id: 'down-mcp' }, { id: 'down-mcp' }]];
const POLICIES = ['allow', 'ask', 'block', undefined, 'ASK', ''];
for (let i = 0; i < 700; i++) {
  const boxes = BOX_IDS.filter(() => rand() < 0.5).map(makeBox);
  const policyOf = new Map();
  const input = {
    user: { id: 'u-synthetic', role: pick(['admin', 'member', 'Admin']) },
    project: pick(PROJECTS), mode: pick(['chat', 'cowork', 'Cowork', undefined]), boxes, manifest: pick(MANIFESTS), defaultToolboxes: pick(DEFAULTS),
    connectorBoxes: pick(CONNECTORS), connected: pick(CONNECTED), oauthServerIds: pick([new Set(), new Set(['sso-mcp']), new Set(['sso-mcp', 'web'])]),
    accountReady: ((ready) => () => ready)(rand() < 0.5), policyMode: (_u, t) => { if (!policyOf.has(t)) policyOf.set(t, pick(POLICIES)); return policyOf.get(t); },
    isWriteTool: (name) => (WRITES.has(name) ? pick([true, 1]) : pick([false, 0, ''])), diaryEnabled: pick([true, false, 1, 0]),
    harnessEnabled: pick([true, false]), repositories: pick([[], ['repo-a'], undefined]),
  };
  const calls = { ready: [], write: [], policy: [] };
  const record = (list, f) => (...args) => { const v = f(...args); list.push(v); return v; };
  const js = tp.computePermittedToolsJs({ ...input, accountReady: record(calls.ready, input.accountReady),
    isWriteTool: record(calls.write, input.isWriteTool), policyMode: record(calls.policy, input.policyMode) });
  const want = { boxes: js.map((b) => ({ id: idOf(b.id), state: b.state, reasonCode: b.reasonCode, active: b.active,
    tools: b.tools.map((t) => ({ permission: t.permission, reasonCode: t.reasonCode })) })) };
  push(3, [tp.permittedProjection(input, calls)], want);
}

const counts = rows.reduce((m, r) => { m[r.op] = (m[r.op] || 0) + 1; return m; }, {});
for (const k of ['1', '2', '3']) if (!counts[k]) throw Error(`no ${k} rows`);
const states = new Set(rows.filter((r) => r.op === 3).flatMap((r) => JSON.parse(r.want).boxes.flatMap((b) => [b.reasonCode, ...b.tools.map((t) => t.permission)])));
for (const s of ['connect', 'signIn', 'diaryOff', 'notConnected', 'codeNeedsCowork', 'codeAdminOnly', 'codeOff', 'codeNeedsProject', 'codeNoRepository', null,
  'allowed', 'needs-approval', 'unavailable']) if (!states.has(s)) throw Error(`no ${s} in the catalogue rows`);
process.stderr.write(`${JSON.stringify(counts)}\n`);
process.stdout.write(`${JSON.stringify({ version: 1, rows })}\n`);
