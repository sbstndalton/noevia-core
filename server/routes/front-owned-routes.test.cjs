'use strict';
// sbstndalton/noevia#1071: the front read routes are the Rust front's permanently. Node refuses
// them whatever the environment says (a leftover retired switch value included), before touching
// any collaborator, and no server source reads the retired switches any more.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RETIRED = ['NOEVIA_RUST_USAGE', 'NOEVIA_RUST_SAMPLING_SETTINGS', 'NOEVIA_RUST_REASONING_SETTINGS', 'NOEVIA_RUST_ROUTING_MODE',
  'NOEVIA_RUST_ROUTING_DEFAULT', 'NOEVIA_RUST_STATS', 'NOEVIA_RUST_EXPORT', 'NOEVIA_RUST_CHATGPT_STATUS', 'NOEVIA_RUST_STORAGE_READS',
  'NOEVIA_RUST_STORAGE_BROWSE'];
const LEFTOVERS = [{}, Object.fromEntries(RETIRED.map((k) => [k, '0'])), Object.fromEntries(RETIRED.flatMap((k) => [[k, '1'], [`${k}_CONFIRMED`, '1']]))];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

function capture() {
  const sent = [];
  return { sent, json: (_res, status, body) => { sent.push({ status, body }); } };
}
const member = { user: { id: 'synthetic-member', role: 'member' } };
const admin = { user: { id: 'synthetic-admin', role: 'admin' } };

test('usage reporting: every method of both paths is refused, nothing else is handled', async () => {
  const { createUsageRoutes, REFUSAL } = require('./usage.cjs');
  for (const env of LEFTOVERS) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const c = capture();
      const routes = createUsageRoutes({ json: c.json });
      for (const p of ['/api/usage', '/api/usage/aggregate']) {
        for (const method of METHODS) {
          for (const authn of [member, admin]) {
            assert.equal(await routes({ method }, {}, { path: p, authn }), true);
            assert.deepEqual(c.sent.pop(), { status: 503, body: REFUSAL }, `${method} ${p}`);
          }
        }
      }
      for (const p of ['/api/usage/', '/api/usage/other', '/api/usages']) assert.equal(await routes({ method: 'GET' }, {}, { path: p, authn: member }), false, p);
    } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  }
  assert.deepEqual(require('./usage.cjs').REFUSAL, { error: 'Usage reporting is owned by the Rust front.' });
});

test('sampling settings: every method is refused, nothing else is handled', async () => {
  const { createSamplingSettingsRoutes, REFUSAL } = require('./sampling-settings.cjs');
  const c = capture();
  const routes = createSamplingSettingsRoutes({ json: c.json });
  for (const method of METHODS) {
    for (const authn of [member, admin]) {
      assert.equal(await routes({ method }, {}, { path: '/api/sampling-settings', authn }), true);
      assert.deepEqual(c.sent.pop(), { status: 503, body: REFUSAL }, method);
    }
  }
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/sampling-settingsx', authn: member }), false);
  assert.deepEqual(REFUSAL, { error: 'Sampling settings are owned by the Rust front.' });
});

test('conversation export: a signed-in GET is refused; signed out 401 and other methods 405 as before', async () => {
  const { createExportRoutes, REFUSAL } = require('./export.cjs');
  const c = capture();
  const routes = createExportRoutes({ json: c.json });
  for (const authn of [member, admin]) {
    assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/export/conversations', authn }), true);
    assert.deepEqual(c.sent.pop(), { status: 503, body: REFUSAL });
  }
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/export/conversations', authn: null }), true);
  assert.deepEqual(c.sent.pop(), { status: 401, body: { error: 'Sign in first' } });
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    await routes({ method }, {}, { path: '/api/export/conversations', authn: member });
    assert.deepEqual(c.sent.pop(), { status: 405, body: { error: 'method not allowed' } }, method);
  }
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/export', authn: member }), false);
  assert.deepEqual(REFUSAL, { error: 'Conversation export is owned by the Rust front.' });
});

test('no server source reads a retired front switch', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'wasm') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.cjs') && !entry.name.endsWith('.test.cjs')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const name of RETIRED) if (new RegExp(`\\b${name}(?:_CONFIRMED)?\\b`).test(text)) offenders.push(`${path.relative(root, full)}: ${name}`);
      }
    }
  };
  visit(root);
  assert.deepEqual(offenders, []);
});
