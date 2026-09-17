const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), net = require('node:net');
const { createEgressProxy, hostAllowed, parseTarget } = require('./code-egress.cjs');

const basic = (token) => 'Basic ' + Buffer.from('task:' + token).toString('base64');
// Tests run against loopback, which the real guard rightly calls private.
const publicEverywhere = () => true;

function proxy(extra = {}) {
  const log = [];
  const p = createEgressProxy({ log: (e) => log.push(e), isPublicAddress: publicEverywhere,
    lookup: async (host) => (host === 'nowhere.test' ? [] : ['127.0.0.1']), ...extra });
  return { p, log };
}

test('domain matching covers subdomains but not lookalike suffixes', () => {
  assert.equal(hostAllowed('example.com', ['example.com']), true);
  assert.equal(hostAllowed('a.b.example.com', ['example.com']), true);
  assert.equal(hostAllowed('notexample.com', ['example.com']), false);
  assert.equal(hostAllowed('example.com.evil.test', ['example.com']), false);
  assert.equal(hostAllowed('EXAMPLE.com.', ['example.com']), true, 'case and a trailing dot are the same host');
  assert.equal(hostAllowed('example.com', []), false);
});

test('targets are parsed with their port, including IPv6 literals', () => {
  assert.deepEqual(parseTarget('example.com:443', 80), { host: 'example.com', port: 443 });
  assert.deepEqual(parseTarget('example.com', 80), { host: 'example.com', port: 80 });
  assert.deepEqual(parseTarget('[::1]:443', 80), { host: '::1', port: 443 });
  assert.equal(parseTarget('example.com:notaport', 80), null);
  assert.equal(parseTarget('', 80), null);
});

test('no token, an unknown token or a revoked one gets nothing', async () => {
  const { p } = proxy();
  const { token } = p.grant({ taskId: 't1', domains: ['example.com'] });
  assert.equal((await p.check({ header: undefined, target: 'example.com:443', defaultPort: 443 })).status, 407);
  assert.equal((await p.check({ header: basic('wrong'), target: 'example.com:443', defaultPort: 443 })).status, 407);
  assert.equal((await p.check({ header: basic(token), target: 'example.com:443', defaultPort: 443 })).ok, true);
  p.revoke('t1');
  assert.equal((await p.check({ header: basic(token), target: 'example.com:443', defaultPort: 443 })).status, 407);
});

test('a task is refused everything it was not granted, and only on web ports', async () => {
  const { p } = proxy();
  const { token } = p.grant({ taskId: 't1', domains: ['example.com'] });
  const check = (target, defaultPort = 443) => p.check({ header: basic(token), target, defaultPort });
  assert.equal((await check('evil.test:443')).status, 403);
  assert.equal((await check('example.com:22')).status, 403, 'SSH is not a web port');
  assert.match((await check('example.com:22')).reason, /port 22/);
  assert.equal((await check('nowhere.test:443')).status, 403, 'not granted at all');
  assert.equal((await check('example.com:443')).ok, true);
});

test('a granted host that does not resolve fails rather than guessing', async () => {
  const { p } = proxy();
  const { token } = p.grant({ taskId: 't1', domains: ['nowhere.test'] });
  const verdict = await p.check({ header: basic(token), target: 'nowhere.test:443', defaultPort: 443 });
  assert.equal(verdict.status, 502);
  assert.match(verdict.reason, /does not resolve/);
});

test('a granted name that resolves to a private address does not get through', async () => {
  const { p } = proxy({ isPublicAddress: (ip) => ip !== '10.0.0.5', lookup: async () => ['93.184.216.34', '10.0.0.5'] });
  const { token } = p.grant({ taskId: 't1', domains: ['example.com'] });
  const verdict = await p.check({ header: basic(token), target: 'example.com:443', defaultPort: 443 });
  assert.equal(verdict.status, 403);
  assert.match(verdict.reason, /private address/);
});

test('the checked address is what gets connected to, so a rebind cannot land elsewhere', async () => {
  let call = 0;
  const { p } = proxy({ lookup: async () => [call++ === 0 ? '203.0.113.1' : '10.0.0.1'] });
  const { token } = p.grant({ taskId: 't1', domains: ['example.com'] });
  const verdict = await p.check({ header: basic(token), target: 'example.com:443', defaultPort: 443 });
  assert.equal(verdict.address, '203.0.113.1', 'the verdict carries the address; nothing re-resolves after it');
});

test('a granted request is proxied, and the proxy credential never travels onward', async () => {
  const seen = [];
  const origin = http.createServer((req, res) => { seen.push(req.headers); res.end('hello from upstream'); });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const originPort = origin.address().port;

  const { p, log } = proxy({ lookup: async () => ['127.0.0.1'], allowedPorts: [80, 443, originPort] });
  const { token } = p.grant({ taskId: 't1', domains: ['example.com'] });
  await p.listen();
  const proxyPort = p.server.address().port;

  const body = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET',
      path: `http://example.com:${originPort}/thing`,
      headers: { 'proxy-authorization': basic(token), host: `example.com:${originPort}`, 'x-task': 'yes' } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.end();
  });
  assert.equal(body, 'hello from upstream');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]['proxy-authorization'], undefined, 'the task token stays at the proxy');
  assert.equal(seen[0]['x-task'], 'yes', 'the request itself is otherwise intact');
  assert.equal(seen[0].host, `example.com:${originPort}`);
  assert.ok(log.some((e) => e.event === 'egress.allowed' && e.taskId === 't1' && e.host === 'example.com'));
  await p.close();
  origin.closeAllConnections?.(); origin.close();
});

test('a refused request is answered and logged against the task, with no token in the log', async () => {
  const { p, log } = proxy();
  p.grant({ taskId: 't1', domains: ['example.com'] });
  const { token } = p.grant({ taskId: 't2', domains: ['other.test'] });
  await p.listen();
  const port = p.server.address().port;
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: 'http://example.com/x',
      headers: { 'proxy-authorization': basic(token) } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  const refusal = log.find((e) => e.event === 'egress.refused');
  assert.equal(refusal.taskId, 't2');
  assert.equal(refusal.host, 'example.com');
  assert.equal(JSON.stringify(log).includes(token), false, 'tokens are never logged');
  await p.close();
});

test('CONNECT tunnels only to a granted host, and is refused without a grant', async () => {
  const origin = net.createServer((socket) => { socket.on('data', () => socket.end('tunnelled')); });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const originPort = origin.address().port;

  const { p } = proxy({ lookup: async () => ['127.0.0.1'],
    connect: ({ port }) => net.connect(port === 443 ? originPort : port, '127.0.0.1') });
  const { token } = p.grant({ taskId: 't1', domains: ['example.com'] });
  await p.listen();
  const proxyPort = p.server.address().port;

  // Spoken on a raw socket: Node's HTTP client never surfaces a non-2xx CONNECT reply, and
  // the bytes on the wire are what a real client (curl, npm, pip) actually reads.
  const tunnel = (host, header) => new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n` +
        (header ? `Proxy-Authorization: ${header}\r\n` : '') + '\r\n');
    });
    let buffer = '', established = false;
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!established && buffer.includes('\r\n\r\n')) {
        const status = Number(buffer.match(/^HTTP\/1\.[01] (\d+)/)?.[1]);
        if (status !== 200) { socket.destroy(); return resolve({ status }); }
        established = true; buffer = buffer.split('\r\n\r\n').slice(1).join('\r\n\r\n');
        socket.write('ping');
      } else if (established && buffer) { socket.destroy(); resolve({ status: 200, body: buffer }); }
    });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('the proxy never answered')); }, 5000).unref();
  });

  assert.deepEqual(await tunnel('example.com', basic(token)), { status: 200, body: 'tunnelled' });
  assert.equal((await tunnel('evil.test', basic(token))).status, 403);
  assert.equal((await tunnel('example.com', null)).status, 407);
  await p.close();
  origin.closeAllConnections?.(); origin.close();
});

test('a new grant for the same task replaces the old token', async () => {
  const { p } = proxy();
  const first = p.grant({ taskId: 't1', domains: ['a.test'] });
  const second = p.grant({ taskId: 't1', domains: ['b.test'] });
  assert.notEqual(first.token, second.token);
  assert.equal((await p.check({ header: basic(first.token), target: 'a.test:443', defaultPort: 443 })).status, 407);
  assert.equal((await p.check({ header: basic(second.token), target: 'b.test:443', defaultPort: 443 })).ok, true);
});

test('a client that disconnects mid-check does not take the proxy down with it', async () => {
  // The verdict does a DNS lookup, so there is a real window between accepting a connection and
  // answering it. An 'error' on the client socket with no listener attached is an uncaught
  // exception — and this proxy runs inside the web process, so that is the whole server.
  let release;
  const slow = new Promise((r) => { release = r; });
  const { p } = proxy({ lookup: async () => { await slow; return ['127.0.0.1']; } });
  const { token } = p.grant({ taskId: 't1', domains: ['example.com'] });
  await p.listen();
  const port = p.server.address().port;

  const crashes = [];
  const onCrash = (e) => crashes.push(e);
  process.on('uncaughtException', onCrash);
  try {
    for (const verb of ['CONNECT', 'GET']) {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(verb === 'CONNECT'
          ? `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${basic(token)}\r\n\r\n`
          : `GET http://example.com/x HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${basic(token)}\r\n\r\n`);
        // Gone before the lookup comes back, the way a cancelled task's container is — and
        // hung up with a reset, not a polite FIN, which is what a killed container sends.
        setTimeout(() => { socket.resetAndDestroy ? socket.resetAndDestroy() : socket.destroy(); }, 20);
      });
      socket.on('error', () => {});
      await new Promise((r) => setTimeout(r, 60));
    }
    release();
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(crashes.map((e) => e.message), [], 'the proxy must survive a client hanging up');

    // Still serving afterwards.
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: 'http://nope.test/x',
        headers: { 'proxy-authorization': basic(token) } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
  } finally {
    process.off('uncaughtException', onCrash);
    await p.close();
  }
});
