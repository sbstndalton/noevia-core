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
