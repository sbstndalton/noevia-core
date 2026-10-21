'use strict';
// #1179/#1596: Laya is marked by an explicit role in models.roles.json beside models.ini, never by a key
// in models.ini (llama-server reads that file and throws on an option it does not know). The name/path
// rule is a deprecated, logged fallback for sections without a role. Synthetic sections only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const sys = require('./model-system.cjs');
const { createPresetStore } = require('./llamacpp-presets.cjs');

const ROLES = JSON.stringify({ 'routing-box': 'laya', 'laya-named-chat': 'chat', '*': 'laya' });

const warnings = [];
const realWarn = console.warn;
test.beforeEach(() => { warnings.length = 0; console.warn = (text) => warnings.push(String(text)); sys.useRolesBeside(null); sys.rememberSectionRoles(ROLES); });
test.afterEach(() => { console.warn = realWarn; sys.useRolesBeside(null); sys.rememberSectionRoles(''); });

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'model-system-1596-')); }

test('the roles of the sections are read, the defaults section is not a section', () => {
  const roles = sys.sectionRolesOf(ROLES);
  assert.equal(roles.get('routing-box'), 'laya');
  assert.equal(roles.get('laya-named-chat'), 'chat');
  assert.equal(roles.has('*'), false);
  assert.equal(sys.sectionRolesOf('{"x":"  LAYA  "}').get('x'), 'laya', 'case and spaces are tolerated');
  for (const bad of ['', 'not json', '[1]', '{"a":3,"b":""}', 'null']) assert.equal(sys.sectionRolesOf(bad).size, 0, JSON.stringify(bad));
});

test('an explicit role decides, whatever the section name or path says', () => {
  assert.equal(sys.isSystemModel('routing-box'), true, 'a laya role marks Laya even with an ordinary name');
  assert.equal(sys.isSystemModel('laya-named-chat'), false, 'an explicit non-Laya role beats the name');
  assert.equal(sys.isSystemModel('laya-named-chat', '/models/laya-x/chat.gguf'), false, 'and beats a laya path');
  assert.deepEqual(warnings, [], 'no deprecation log for sections that have a role');
});

test('a section with no role keeps the name rule, logged once, and the log names the roles file', () => {
  assert.equal(sys.isSystemModel('laya_legacy'), true);
  assert.equal(sys.isSystemModel('laya_legacy'), true);
  const own = warnings.filter((w) => w.includes('laya_legacy'));
  assert.equal(own.length, 1);
  assert.ok(own[0].includes('models.roles.json') && own[0].includes('{"laya_legacy": "laya"}'), own[0]);
  assert.ok(!own[0].includes('"role = laya"'), 'must not tell operators to put a key llama.cpp rejects into models.ini');
  assert.equal(sys.isSystemModel('plain-chat'), false);
  assert.equal(sys.isSystemModel('', ''), false);
});

test('the path rule still applies to a section with no role, and is logged', () => {
  assert.equal(sys.isSystemModel('unmarked', '/models/laya-small/synthetic.gguf'), true);
  assert.equal(sys.isSystemModel('unmarked', '/models/laya-small/synthetic.gguf'), true);
  assert.equal(warnings.filter((w) => w.includes('laya-small')).length, 1);
  assert.equal(sys.isSystemModel('unmarked', '/models/tiny/synthetic.gguf'), false);
});

test('a preset store follows the roles file beside its models.ini, and edits to it are picked up', () => {
  const dir = tmp();
  try {
    const ini = path.join(dir, 'models.ini'), roles = path.join(dir, 'models.roles.json');
    assert.equal(sys.rolesFileFor(ini), roles);
    fs.writeFileSync(ini, '[box]\nmodel = /models/box/synthetic.gguf\n');
    createPresetStore(ini);
    assert.equal(sys.isSystemModel('box'), false, 'no roles file: an ordinary name is not Laya');
    fs.writeFileSync(roles, '{"box":"laya"}');
    assert.equal(sys.isSystemModel('box'), true, 'the roles file was read without any preset read');
    fs.writeFileSync(roles, '{"box":"chat","other":"laya"}');
    assert.equal(sys.isSystemModel('box'), false, 'a changed file is re-read');
    assert.equal(sys.isSystemModel('other'), true);
    fs.rmSync(roles);
    assert.equal(sys.isSystemModel('other'), false, 'removing the file removes the markers');
    fs.writeFileSync(roles, 'not json');
    assert.equal(sys.isSystemModel('other'), false, 'an unusable file is no roles');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a role key inside models.ini is not a marker and is not what the preset parser accepts', () => {
  const dir = tmp();
  try {
    const ini = path.join(dir, 'models.ini');
    fs.writeFileSync(ini, '[box]\nmodel = /models/box/synthetic.gguf\nrole = laya\n');
    const store = createPresetStore(ini);
    store.get('box');
    assert.equal(sys.isSystemModel('box'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// noevia#2093 phase 1: a roles file may name the role ("system-routing") instead of the legacy role key.
// Readers accept both until phase 3; nothing that writes the file changes in this phase.
const NEW_ROLE = sys.SYSTEM_ROUTING_ROLE;
const LEGACY_ROLE = sys.LEGACY_SYSTEM_ROUTING_ROLES[0];

test('the role name and the legacy key are both the system routing role, and nothing else is', () => {
  assert.equal(NEW_ROLE, 'system-routing');
  assert.deepEqual([...sys.LEGACY_SYSTEM_ROUTING_ROLES], ['laya']);
  assert.equal(sys.LAYA_ROLE, LEGACY_ROLE, 'the old export still names the legacy key');
  assert.equal(sys.isSystemRoutingRole(NEW_ROLE), true);
  for (const legacy of sys.LEGACY_SYSTEM_ROUTING_ROLES) assert.equal(sys.isSystemRoutingRole(legacy), true, legacy);
  for (const other of ['', 'chat', 'embedding', 'routing', 'system', 'system_routing', 'system-routing-x', 'x-system-routing', 'layas', undefined, null]) {
    assert.equal(sys.isSystemRoutingRole(other), false, String(other));
  }
});

test('the role name is read like the legacy key: case and spaces are tolerated', () => {
  const roles = sys.sectionRolesOf(`{"a":"  System-Routing  ","b":"${NEW_ROLE}","c":"chat"}`);
  assert.equal(roles.get('a'), NEW_ROLE);
  assert.equal(roles.get('b'), NEW_ROLE);
  assert.equal(roles.get('c'), 'chat');
});

test('a section with the role name is a system model; the legacy key still is; an unrelated role is not', () => {
  sys.rememberSectionRoles(JSON.stringify({
    'new-box': NEW_ROLE, 'old-box': LEGACY_ROLE, 'plain-chat': 'chat', 'near-miss': 'system-routing-x',
    [`${LEGACY_ROLE}-named-chat`]: 'chat', [`${LEGACY_ROLE}-named-new`]: NEW_ROLE, '*': NEW_ROLE,
  }));
  assert.equal(sys.isSystemModel('new-box'), true, 'the role name marks the section whatever its name');
  assert.equal(sys.isSystemModel('old-box'), true, 'the legacy key is unchanged');
  assert.equal(sys.isSystemModel('plain-chat'), false);
  assert.equal(sys.isSystemModel('near-miss'), false, 'a role that only starts with the role name is another role');
  assert.equal(sys.isSystemModel('not-in-the-file'), false);
  assert.equal(sys.isSystemModel(`${LEGACY_ROLE}-named-chat`, `/models/${LEGACY_ROLE}-x/chat.gguf`), false, 'an unrelated role still beats the name and path rule');
  assert.equal(sys.isSystemModel(`${LEGACY_ROLE}-named-new`), true);
  assert.equal(sys.isSystemModel('*'), false, 'the defaults section is not a section');
  assert.deepEqual(warnings, [], 'no deprecation log for sections that have a role');
});

test('a section without a role keeps the name rule when the file only uses the role name for others', () => {
  sys.rememberSectionRoles(JSON.stringify({ 'new-box': NEW_ROLE }));
  assert.equal(sys.isSystemModel(`${LEGACY_ROLE}_fallback`), true);
  assert.equal(warnings.filter((w) => w.includes(`${LEGACY_ROLE}_fallback`)).length, 1, 'the fallback is still logged');
});

test('a roles file with the role name is followed beside models.ini, and switches between the two spellings', () => {
  const dir = tmp();
  try {
    const ini = path.join(dir, 'models.ini'), roles = path.join(dir, 'models.roles.json');
    fs.writeFileSync(ini, '[box]\nmodel = /models/box/synthetic.gguf\n');
    createPresetStore(ini);
    fs.writeFileSync(roles, JSON.stringify({ box: NEW_ROLE }));
    assert.equal(sys.isSystemModel('box'), true);
    fs.writeFileSync(roles, JSON.stringify({ box: LEGACY_ROLE, other: NEW_ROLE }));
    assert.equal(sys.isSystemModel('box'), true, 'the legacy key in the same file still works');
    assert.equal(sys.isSystemModel('other'), true);
    fs.writeFileSync(roles, JSON.stringify({ box: 'chat', other: NEW_ROLE, third: NEW_ROLE }));
    assert.equal(sys.isSystemModel('box'), false);
    assert.equal(sys.isSystemModel('third'), true);
    fs.rmSync(roles);
    assert.equal(sys.isSystemModel('other'), false, 'removing the file removes the markers');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the callers that keep a system model out of chat and tuning follow the role name too', async (t) => {
  const { isChatGenerationModel } = require('./chat-model-kind.cjs');
  const { isNonChatRow } = require('./role-engine.cjs');
  const { createModelManager } = require('./model-manager.cjs');
  for (const role of [NEW_ROLE, LEGACY_ROLE, 'chat']) {
    const dir = tmp();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ini = path.join(dir, 'models.ini');
    fs.writeFileSync(ini, '[box]\nmodel = /models/box.gguf\nctx-size = 8192\n');
    fs.writeFileSync(path.join(dir, 'models.roles.json'), JSON.stringify({ box: role }));
    const system = role !== 'chat';
    let unloads = 0;
    const fetchJson = async (url, opts = {}) => {
      const u = new URL(url);
      if (u.pathname === '/models' && (!opts.method || opts.method === 'GET')) return { ok: true, status: 200, body: { data: [{ id: 'box', status: { value: 'unloaded', args: [] }, meta: {} }] } };
      if (u.pathname === '/models/unload') unloads++;
      return { ok: true, status: 200, body: {} };
    };
    const manager = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, fetchJson, calibrationStatePath: path.join(dir, 'state.json'), autoconfig: {}, calibrationOptions: { sleep: async () => {}, readMemory: () => 20 } });
    assert.equal(isChatGenerationModel('box'), !system, `chat: ${role}`);
    assert.equal(isNonChatRow({ id: 'box', status: { args: [] } }), system, `role engine: ${role}`);
    const started = await manager.calibration.start('box', { promptBudgetSeconds: 60, confirmPause: true });
    if (system) {
      assert.equal(started.status, 400, `tuning: ${role}`);
      assert.equal(started.body.error, sys.SYSTEM_MODEL_REASON);
      assert.equal(unloads, 0);
    } else {
      assert.notEqual(started.body?.error, sys.SYSTEM_MODEL_REASON, 'an unrelated role is tuned like any chat model');
    }
  }
});
