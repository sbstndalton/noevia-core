'use strict';
// #1179: Laya is marked by an explicit `role = laya` in its models.ini section. The name/path rule is
// a deprecated, logged fallback for sections without a role key. Synthetic sections only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const sys = require('./model-system.cjs');
const { createPresetStore } = require('./llamacpp-presets.cjs');

const INI = [
  '[*]', 'cache-ram = 1024', '',
  '[routing-box]', 'model = /models/routing-box/synthetic.gguf', 'role = laya', '',
  '[laya-named-chat]', 'model = /models/laya-named-chat/synthetic.gguf', 'role = chat', '',
  '[plain-chat]', 'model = /models/plain-chat/synthetic.gguf', '',
  '[laya_legacy]', 'model = /models/laya_legacy/synthetic.gguf', '',
].join('\n');

const warnings = [];
const realWarn = console.warn;
test.beforeEach(() => { warnings.length = 0; console.warn = (text) => warnings.push(String(text)); sys.rememberSectionRoles(INI); });
test.afterEach(() => { console.warn = realWarn; sys.rememberSectionRoles(''); });

test('the roles of the sections are read, the defaults section is not a section', () => {
  const roles = sys.sectionRolesOf(INI);
  assert.equal(roles.get('routing-box'), 'laya');
  assert.equal(roles.get('laya-named-chat'), 'chat');
  assert.equal(roles.has('plain-chat'), false);
  assert.equal(roles.has('*'), false);
  assert.equal(sys.sectionRolesOf('[x]\nrole =   LAYA  \n').get('x'), 'laya', 'case and spaces are tolerated');
});

test('an explicit role decides, whatever the section name or path says', () => {
  assert.equal(sys.isSystemModel('routing-box'), true, 'role = laya marks Laya even with an ordinary name');
  assert.equal(sys.isSystemModel('laya-named-chat'), false, 'an explicit non-Laya role beats the name');
  assert.equal(sys.isSystemModel('laya-named-chat', '/models/laya-x/chat.gguf'), false, 'and beats a laya path');
  assert.deepEqual(warnings, [], 'no deprecation log for sections that have a role');
});

test('a section with no role keeps the name rule, logged once', () => {
  assert.equal(sys.isSystemModel('laya_legacy'), true);
  assert.equal(sys.isSystemModel('laya_legacy'), true);
  assert.equal(warnings.filter((w) => w.includes('laya_legacy') && w.includes('role = laya')).length, 1);
  assert.equal(sys.isSystemModel('plain-chat'), false);
  assert.equal(sys.isSystemModel('', ''), false);
});

test('the path rule still applies to a section with no role, and is logged', () => {
  assert.equal(sys.isSystemModel('unmarked', '/models/laya-small/synthetic.gguf'), true);
  assert.equal(sys.isSystemModel('unmarked', '/models/laya-small/synthetic.gguf'), true);
  assert.equal(warnings.filter((w) => w.includes('laya-small')).length, 1);
  assert.equal(sys.isSystemModel('unmarked', '/models/tiny/synthetic.gguf'), false);
});

test('reading a models.ini through the preset store refreshes the explicit roles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-system-1179-'));
  try {
    const file = path.join(dir, 'models.ini');
    fs.writeFileSync(file, '[box]\nmodel = /models/box/synthetic.gguf\nrole = laya\n');
    sys.rememberSectionRoles('');
    assert.equal(sys.isSystemModel('box'), false, 'nothing read yet: an ordinary name is not Laya');
    createPresetStore(file).get('box');
    assert.equal(sys.isSystemModel('box'), true, 'the store read the role key');
    fs.writeFileSync(file, '[box]\nmodel = /models/box/synthetic.gguf\n');
    createPresetStore(file).get('box');
    assert.equal(sys.isSystemModel('box'), false, 'removing the key removes the marker on the next read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
