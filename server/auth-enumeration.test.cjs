'use strict';
// Bug hunt (area b): sign-in must not reveal which usernames exist through response time, and one
// address must not be able to spray passwords across many usernames.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth } = require('./auth.cjs');

const request = (ip = '127.0.0.1') => ({ headers: { origin: 'https://cowork.example.test', 'user-agent': 'test' }, socket: { remoteAddress: ip } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-enum-'));
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://cowork.example.test' });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await auth.setup(request(), response(), { setupCode: fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: 'https://cowork.example.test', username: 'realuser', password: 'synthetic enumeration password' });
  return auth;
}
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('a wrong password for an unknown username costs the same password hashing as for a real one', async (t) => {
  const auth = await fixture(t);
  const time = async (username, i) => {
    const started = process.hrtime.bigint();
    const out = await auth.passwordLogin(request(`10.1.${i}.${username.length}`), response(), { username, password: 'wrong synthetic password' });
    assert.equal(out.status, 401);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  const known = [], unknown = [];
  for (let i = 0; i < 5; i++) { known.push(await time('realuser', i)); unknown.push(await time(`ghost${i}`, i)); }
  assert.ok(median(unknown) > median(known) * 0.4, `unknown ${median(unknown).toFixed(2)} ms vs known ${median(known).toFixed(2)} ms reveals which usernames exist`);
});

test('one address cannot spray passwords across many usernames', async (t) => {
  const auth = await fixture(t);
  const statuses = [];
  for (let i = 0; i < 40; i++) statuses.push((await auth.passwordLogin(request('203.0.113.9'), response(), { username: `ghost${i}`, password: 'x' })).status);
  assert.ok(statuses.includes(429), 'an address trying 40 different usernames is never throttled');
  const other = await auth.passwordLogin(request('203.0.113.10'), response(), { username: 'realuser', password: 'synthetic enumeration password' });
  assert.equal(other.status, 200, 'another address is unaffected');
});
