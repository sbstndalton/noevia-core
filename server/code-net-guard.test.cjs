'use strict';
// #853: web's UI and file-sharing listeners refuse requests that arrive over the internal code
// network. Fake sockets for the address logic; one real loopback server for the wiring. No DNS.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { createCodeNetGuard } = require('./code-net-guard.cjs');

const CODE_ADDR = '172.30.0.2';      // web's address on the code network (synthetic)
const DEFAULT_ADDR = '172.18.0.5';   // web's address on its default network (synthetic)

function fakeRes() {
  return { status: null, headers: null, body: '', ended: false, destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk) this.body += chunk; this.ended = true; },
    destroy() { this.destroyed = true; } };
}
const req = (localAddress) => ({ socket: { localAddress }, headers: {} });

test('unset: no check, and the handler is used as is', async () => {
  const guard = createCodeNetGuard({ spec: '' });
  assert.equal(guard.enabled, false);
  const handler = () => {};
  assert.equal(guard.wrap(handler), handler);
  assert.equal(await guard.refuses(CODE_ADDR), false);
});

test('a request arriving on the code-network address gets a bare 403; others reach the handler', async () => {
  const guard = createCodeNetGuard({ spec: CODE_ADDR });
  const seen = [];
  const wrapped = guard.wrap((r, res) => { seen.push(r.socket.localAddress); res.writeHead(200, {}); res.end('ok'); }, 'ui');
  const refused = fakeRes();
  await wrapped(req(CODE_ADDR), refused);
  assert.equal(refused.status, 403);
  assert.equal(refused.body, '', 'no body detail');
  assert.equal(refused.headers['content-length'], '0');
  assert.equal(refused.headers.connection, 'close');
  // The same address as an IPv4-mapped IPv6 local address (a dual-stack `::` bind).
  const mapped = fakeRes();
  await wrapped(req(`::ffff:${CODE_ADDR}`), mapped);
  assert.equal(mapped.status, 403);
  for (const ok of [DEFAULT_ADDR, '127.0.0.1', '::1', undefined]) {
    const res = fakeRes();
    await wrapped(req(ok), res);
    assert.equal(res.status, 200, String(ok));
    assert.equal(res.body, 'ok');
  }
  assert.deepEqual(seen, [DEFAULT_ADDR, '127.0.0.1', '::1', undefined], 'the refused requests never reached the handler');
});

test('a host name (the `egress` alias) resolves to the address to refuse, and startup requests wait for it', async () => {
  let release;
  const lookups = [];
  const logs = [];
  const guard = createCodeNetGuard({ spec: 'egress', log: (e) => logs.push(e),
    lookup: (host) => { lookups.push(host); return new Promise((r) => { release = () => r([{ address: CODE_ADDR, family: 4 }]); }); } });
  const handler = () => assert.fail('a code-network request reached the handler before the name resolved');
  const res = fakeRes();
  const pending = guard.wrap(handler, 'file-sharing')(req(CODE_ADDR), res);
  await new Promise((r) => setImmediate(r));
  assert.equal(res.status, null, 'held until the first resolution finishes');
  release();
  await pending;
  assert.equal(res.status, 403);
  assert.deepEqual(lookups, ['egress'], 'resolved once');
  assert.equal(await guard.refuses(DEFAULT_ADDR), false);
  assert.ok(logs.some((e) => e.event === 'codenet.guarding' && e.addresses.includes(CODE_ADDR)));
  assert.ok(logs.some((e) => e.event === 'codenet.refused' && e.listener === 'file-sharing'));
});

test('a name that does not resolve fails open, is logged, and is retried until it does', async () => {
  let calls = 0;
  const logs = [];
  const guard = createCodeNetGuard({ spec: 'egress', retryMs: 5, log: (e) => logs.push(e),
    lookup: async () => { calls++; if (calls < 3) throw Error('getaddrinfo ENOTFOUND egress'); return [CODE_ADDR]; } });
  assert.equal(await guard.refuses(CODE_ADDR), false, 'unknown address: the UI is not taken down');
  assert.ok(logs.some((e) => e.event === 'codenet.resolve_failed' && e.host === 'egress'));
  for (let i = 0; i < 50 && !(await guard.refuses(CODE_ADDR)); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await guard.refuses(CODE_ADDR), true, 'refused once the retry resolved it');
  assert.ok(calls >= 3);
  guard.stop();
});

test('the setting is validated: IPs and host names only', async () => {
  const looked = [];
  const guard = createCodeNetGuard({ spec: `${CODE_ADDR}, egress fd00::2`, lookup: async (host) => { looked.push(host); return []; }, retryMs: 3_600_000 });
  await guard.ready;
  assert.deepEqual(looked, ['egress'], 'the one name is looked up; the two addresses are guarded as they are');
  assert.equal(await guard.refuses(CODE_ADDR), true);
  assert.equal(await guard.refuses('FD00::2'), true, 'case does not matter');
  assert.equal(await guard.refuses(DEFAULT_ADDR), false);
  guard.stop();
  for (const bad of ['http://egress', 'egress:8021', '172.30.0.0/16', 'a_b']) {
    assert.throws(() => createCodeNetGuard({ spec: bad }), { message: `COWORK_CODE_NET_ADDR should list IP addresses or host names, not "${bad}"` }, bad);
  }
  // An IPv4-mapped IPv6 address is the IPv4 address either way round.
  const mapped = createCodeNetGuard({ spec: '10.0.0.1' });
  assert.equal(await mapped.refuses('::FFFF:10.0.0.1'), true);
  const literalMapped = createCodeNetGuard({ spec: '::FFFF:10.0.0.1' });
  assert.equal(await literalMapped.refuses('10.0.0.1'), true);
});

test('on a real listener, the connection\'s own local address is what decides', async () => {
  const serve = (spec) => new Promise((resolve) => {
    const guard = createCodeNetGuard({ spec });
    const server = http.createServer(guard.wrap((r, res) => { res.writeHead(200); res.end('ui'); }));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const get = (port) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/auth/status' }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  // Loopback stands in for the code-network address here: same check, real socket.
  const guarded = await serve('127.0.0.1');
  const open = await serve('10.255.255.1');
  try {
    assert.deepEqual(await get(guarded.address().port), { status: 403, body: '' });
    assert.deepEqual(await get(open.address().port), { status: 200, body: 'ui' });
  } finally {
    await new Promise((r) => guarded.close(r));
    await new Promise((r) => open.close(r));
  }
});

// The override is in the monorepo's deploy/. CI lays the monorepo out as ws/ with this checkout at
// ws/apps/web, so the path below resolves there. A standalone noevia-core checkout has no deploy/: the
// test is skipped with that reason. In CI it never skips: a missing file fails the run.
const OVERRIDE = path.join(__dirname, '../../../deploy/examples/code-sandbox.override.yml');
const overrideSkip = fs.existsSync(OVERRIDE) || process.env.CI ? false
  : 'deploy/examples is not beside this checkout (standalone noevia-core); CI runs it against the monorepo layout';

test('the override names web\'s code-network address and no longer claims the sandbox cannot reach web', { skip: overrideSkip }, () => {
  const yaml = fs.readFileSync(OVERRIDE, 'utf8');
  assert.match(yaml, /^\s+COWORK_CODE_NET_ADDR: \$\{COWORK_CODE_NET_ADDR:-egress\}$/m);
  assert.doesNotMatch(yaml, /cannot resolve, let alone reach, web/);
  assert.match(yaml, /aliases: \[egress\]/, 'the alias the default resolves');
});

// #213: nothing in production awaits `ready`, so a logger that throws must not leave an unhandled rejection.
async function unhandledDuring(fn) {
  const seen = [];
  const onUnhandled = (err) => seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 30)); // unhandledRejection is raised after the microtask queue drains
  } finally { process.off('unhandledRejection', onUnhandled); }
  return seen;
}

test('a logger that throws on the first resolution leaves no unhandled rejection; ready still rejects for a caller that awaits it', async () => {
  let guard;
  const seen = await unhandledDuring(async () => {
    guard = createCodeNetGuard({ spec: 'egress', retryMs: 3_600_000, log: () => { throw Error('log sink is gone'); },
      lookup: async () => { throw Error('getaddrinfo ENOTFOUND egress'); } });
    await new Promise((r) => setTimeout(r, 10));
  });
  assert.deepEqual(seen, []);
  await assert.rejects(guard.ready, /log sink is gone/);
  const res = fakeRes();
  await guard.wrap(() => assert.fail('handler must not run'), 'ui')(req(CODE_ADDR), res);
  assert.equal(res.destroyed, true, 'a request is still destroyed, not served');
  guard.stop();
});

test('a logger that throws during a retry leaves no unhandled rejection', async () => {
  let logged = 0, guard;
  const seen = await unhandledDuring(async () => {
    guard = createCodeNetGuard({ spec: 'egress', retryMs: 5, log: () => { if (++logged > 1) throw Error('log sink is gone'); },
      lookup: async () => { throw Error('getaddrinfo ENOTFOUND egress'); } });
    await guard.ready;
    for (let i = 0; i < 100 && logged < 2; i++) await new Promise((r) => setTimeout(r, 10));
  });
  assert.ok(logged >= 2, 'the retry ran and its log threw');
  assert.deepEqual(seen, []);
  // The retry died before it could schedule another, so the address set may be incomplete: refuse.
  assert.equal(await guard.refuses(CODE_ADDR), true, 'a code-network address is refused, not served');
  assert.equal(await guard.refuses(DEFAULT_ADDR), true, 'and so is every other request (fails closed)');
  guard.stop();
});
