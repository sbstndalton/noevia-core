'use strict';
// Row V differential fixtures. Drives the FROZEN Node oracle (code-egress-control.cjs) through scripted
// scenarios against a fake proxy and records, per step, every request the client sent, the answer it got
// and the result it returned. The native issuer (noevia-rs crates/egress-issuer) replays the same steps
// with the same clocks and the same byte stream of randomness and must send byte-identical requests and
// reach identical results. Synthetic data only; no key here protects anything.
//
// usage: node tests/reference/code-egress-issuer-fixtures.cjs <out.json>
// Deterministic: running it twice produces identical bytes (see tests/server/code-egress-issuer-fixtures.test.cjs).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');

// ---- the one byte stream both sides draw from -------------------------------------------------
// draw k (0-based) of n bytes = sha256("noevia-egress-fixture" || k as u64 LE)[0..n]. File-temporary names drawn
// inside writeKeyFile are not part of the protocol and come from the real generator.
const realRandomBytes = crypto.randomBytes.bind(crypto);
let drawn = 0;
crypto.randomBytes = (n, cb) => {
  if (cb) return realRandomBytes(n, cb);
  if (n === 16 && new Error().stack.includes('writeKeyFile')) return realRandomBytes(n);
  const counter = Buffer.alloc(8); counter.writeBigUInt64LE(BigInt(drawn++));
  return crypto.createHash('sha256').update('noevia-egress-fixture').update(counter).digest().subarray(0, n);
};

const oracle = require('./code-egress-control.cjs');
const { CAPABILITY, ROUTES, deriveFileKey, createControlClient, publishWebKey, createKeyKeeper, responseMac } = oracle;

const MASTER = Buffer.alloc(32, 7);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const BOOT_A = 'a1'.repeat(16), SESSION_A = 'b2'.repeat(16), SESSION_B = 'c3'.repeat(16), SNAP = 'ef'.repeat(16), SNAP_2 = 'ab'.repeat(16);
const hdr = (tag, bytes) => ['content-type', 'application/json', 'content-length', String(bytes.length), 'cache-control', 'no-store', 'connection', 'close', 'x-noevia-control-mac', tag];

// ---- the fake proxy ----------------------------------------------------------------------------
// It answers as the real proxy does: it reads the published key on every request, signs with the key it
// reads, accepts Initial only when it has no live session, Replace only for the session it holds.
function makeProxy({ keyFile, fixedKey }) {
  const state = { mode: 'normal', session: null, lease: 15000, lostOnce: false, snapshot: SNAP, finalState: 'complete', staleSessions: new Set() };
  const currentKey = () => (keyFile ? Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex') : fixedKey);
  const exchanges = [];
  async function transport(req) {
    const key = currentKey(), fp = sha(key), body = JSON.parse(req.body);
    const rec = { route: req.route, headers: Object.entries(req.headers).map(([k, v]) => [k, String(v)]), body: Buffer.from(req.body).toString('utf8') };
    exchanges.push(rec);
    const reply = (value, status = 200) => {
      const bytes = Buffer.from(JSON.stringify({ version: 1, requestId: req.headers['x-noevia-request-id'], ...value }));
      const out = { status, rawHeaders: hdr(responseMac(key, req.headers['x-noevia-control-mac'], status, bytes), bytes), body: bytes };
      rec.response = { status, rawHeaders: out.rawHeaders, body: bytes.toString('utf8') };
      return out;
    };
    const lose = () => { rec.response = { throw: 'transport' }; throw Object.assign(Error('synthetic transport loss'), { code: 'ECONNRESET' }); };
    if (state.mode === 'down') lose();
    const session = state.session || SESSION_A;
    const proof = (kind, extra = {}) => reply({ state: kind, capability: CAPABILITY, bootId: BOOT_A, sessionId: state.session, keyFingerprint: fp, ...extra, leaseMs: state.lease });
    if (req.route === ROUTES.ready) {
      if (state.mode === 'conflict') {
        // The proxy reads the key file on every request: a new key retires its session and accepts Initial.
        if (!state.conflictFp) state.conflictFp = fp;
        if (fp === state.conflictFp) return reply({ state: 'conflict' }, 409);
        state.mode = 'normal'; state.session = null; state.restarted = false;
      }
      if (body.mode === 'replace') {
        if (body.priorSession !== state.session) return reply({ state: 'no-such-session' }, 409);
        state.session = state.nextSession || SESSION_B; return proof('ready', { sequence: 0, challenge: body.challenge });
      }
      if (state.session && !state.restarted) return reply({ state: 'initialized' }, 409);
      state.session = state.nextSession || SESSION_A; state.restarted = false; return proof('ready', { sequence: 0, challenge: body.challenge });
    }
    if (req.route === ROUTES.renew) return proof('renewed', { sequence: body.sequence });
    if (req.route === ROUTES.forget) return reply({ state: 'forgotten', bootId: BOOT_A, sessionId: body.sessionId, taskId: body.taskId, leaseNonce: body.leaseNonce, snapshotId: body.snapshotId });
    if (body.sessionId !== state.session) return reply({ state: 'unknown-session' }, 409);
    if (state.mode === 'uncertain') return reply({ state: 'drain-incomplete' }, 503);
    const isRevoke = req.route === ROUTES.revoke;
    if (state.mode === 'lost' && isRevoke && !state.lostOnce) { state.lostOnce = true; lose(); }
    const taskId = state.mode === 'cross-task' ? 'another' : body.taskId;
    return reply({ state: isRevoke ? 'revoke-confirmed' : 'activity', bootId: BOOT_A, sessionId: body.sessionId, taskId, leaseNonce: body.leaseNonce, barrierInstalled: isRevoke, drained: isRevoke,
      snapshot: { id: state.snapshot, state: isRevoke ? state.finalState : 'complete', final: isRevoke, summary: state.finalState === 'evicted' && isRevoke ? null : { hosts: [{ host: 'example.com', allowed: 2, refused: 1, reason: 'host does not resolve' }], allowed: 2, refused: 1 }, partial: false, overflow: false } });
  }
  return { state, transport, exchanges };
}

// ---- a scenario runner --------------------------------------------------------------------------
async function run(name, { keyed = false, ttlMs = 6 * 3600 * 1000, lifetimeMs = 7200000, script }) {
  drawn = 0; // every scenario starts the stream at draw 0
  const clock = { wall: 1_800_000_000_000, mono: 1000 };
  let fileKey, keyFile = null, dir = null, keeper = null;
  if (keyed) {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egress-fixture-')));
    const uid = process.getuid(), gid = process.getgid() || 1;
    fs.chownSync(dir, uid, gid); fs.chmodSync(dir, 0o750);
    keyFile = path.join(dir, 'current.key');
    fileKey = publishWebKey({ masterKey: MASTER, file: keyFile, uid, gid });
    keeper = createKeyKeeper({ deriveMaster: () => MASTER, fileKey, file: keyFile, uid, gid });
  } else fileKey = Buffer.alloc(32, 9);
  const proxy = makeProxy({ keyFile, fixedKey: fileKey });
  const client = createControlClient({ fileKey, endpoint: 'egress-rs-code:8040', transport: proxy.transport, autoRenew: false, ttlMs, lifetimeMs, keeper,
    now: () => clock.wall, monotonic: () => clock.mono, retryMinMs: 1000, retryMaxMs: 15000 });
  const handles = new Map(), steps = [];
  const outcome = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { error: e.reason || `other:${e.message}` }; } };
  const jsonOf = (v) => JSON.parse(JSON.stringify(v));
  const api = {
    set(patch) { Object.assign(clock, patch); return { op: 'set', ...patch }; },
    mode(m, extra = {}) { proxy.state.mode = m; Object.assign(proxy.state, extra); return { op: 'mode', mode: m, ...extra }; },
    async ready() { return { op: 'ready', result: await outcome(async () => (await client.ready(), true)) }; },
    async renew() { return { op: 'renew', result: await outcome(async () => (await client.renew(), true)) }; },
    async grant(as, taskId, domains) {
      const r = await outcome(async () => { const h = await client.grant({ taskId, domains }); handles.set(as, h); return { taskId: h.taskId, domains: [...h.domains], token: h.token }; });
      return { op: 'grant', as, taskId, domains, result: r };
    },
    async revoke(as, budget) { return { op: 'revoke', as, budget, result: await outcome(async () => jsonOf(await client.revoke(handles.get(as), budget))) }; },
    async activity(as, budget) { return { op: 'activity', as, budget, result: await outcome(async () => jsonOf(await client.activity(handles.get(as), budget))) }; },
    async forget(as, snapshotId) { return { op: 'forget', as, snapshotId, result: await outcome(async () => jsonOf(await client.forget(handles.get(as), snapshotId))) }; },
    available() { return { op: 'available', result: { ok: client.available() } }; },
    keyFile() { return { op: 'keyFile', result: { ok: { hex: fs.readFileSync(keyFile, 'utf8').trim(), mode: (fs.statSync(keyFile).mode & 0o7777).toString(8) } } }; },
  };
  const initialKey = keyed ? fileKey.toString('hex') : null;
  await script(api, async (step) => {
    const before = proxy.exchanges.length;
    const done = await step();
    steps.push({ ...done, exchanges: proxy.exchanges.slice(before) });
  }, proxy);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  return { name, keyed, initialKeyHex: initialKey, endpoint: 'egress-rs-code:8040', ttlMs, lifetimeMs, wall0: 1_800_000_000_000, mono0: 1000, steps };
}

async function main() {
  const out = [];
  out.push(await run('basic grant, renew, revoke, forget', { script: async (a, s) => {
    await s(() => a.ready()); await s(() => a.renew());
    await s(() => a.grant('h1', 'task:1', ['.EXAMPLE.com.', 'api.Example.com', 'example.com']));
    await s(() => a.grant('h2', 'task:1', ['example.org']));
    await s(() => a.activity('h1')); await s(() => a.revoke('h1'));
    await s(() => a.forget('h1', SNAP)); await s(() => a.forget('h1', SNAP_2)); await s(() => a.revoke('h2'));
    await s(() => a.grant('bad1', 'bad task', ['example.com'])); await s(() => a.grant('bad2', 'task:2', [])); await s(() => a.grant('bad3', 'task:2', ['not a host']));
    await s(() => a.available());
  } }));
  out.push(await run('lost revoke reply is retried with the exact bytes; concurrent owners share cleanup', { script: async (a, s, p) => {
    await s(() => a.grant('h1', 'job.1', ['example.com'])); await s(() => a.mode('lost'));
    await s(() => a.revoke('h1')); await s(() => a.forget('h1', SNAP));
  } }));
  out.push(await run('scope mismatch and uncertainty never fabricate success or allow a replacement', { script: async (a, s) => {
    await s(() => a.grant('h1', 'job.1', ['example.com'])); await s(() => a.mode('cross-task')); await s(() => a.activity('h1'));
    await s(() => a.mode('uncertain')); await s(() => a.revoke('h1')); await s(() => a.available());
    await s(() => a.mode('normal')); await s(() => a.grant('h2', 'job.1', ['example.com']));
  } }));
  out.push(await run('zero and negative cleanup budgets send nothing and hold new authority', { script: async (a, s) => {
    await s(() => a.grant('h1', 'budget.1', ['example.com'])); await s(() => a.revoke('h1', 0)); await s(() => a.grant('h2', 'budget.2', ['example.com'])); await s(() => a.available());
  } }));
  out.push(await run('same-task grants never repeat an issue time; lifetime and idle are capped', { ttlMs: 10 * 24 * 3600 * 1000, lifetimeMs: 48 * 3600 * 1000, script: async (a, s) => {
    await s(() => a.grant('h1', 'task:s', ['example.com'])); await s(() => a.grant('h2', 'task:s', ['example.com'])); await s(() => a.set({ wall: 1_800_000_000_001 })); await s(() => a.grant('h3', 'task:s', ['example.com']));
    await s(() => a.revoke('h3'));
  } }));
  out.push(await run('a restarted proxy gets Replace refused then Initial; the old lease cannot take the new session down', { script: async (a, s, p) => {
    await s(() => a.grant('h1', 'task:r', ['example.com']));
    await s(() => a.set({ mono: 22000 })); await s(() => a.ready());                // expired, in backoff
    await s(() => a.set({ mono: 24000 })); await s(() => a.mode('normal', { restarted: true, session: null, nextSession: SESSION_B }));
    await s(() => a.ready());                                                  // Replace -> 409 -> Initial -> new session
    await s(() => a.available()); await s(() => a.revoke('h1')); await s(() => a.available());
    await s(() => a.grant('h2', 'task:r', ['example.com'])); await s(() => a.revoke('h2'));
  } }));
  out.push(await run('rotation: signed refusals outlasting any session re-key; held grants of the old key stay scoped', { keyed: true, script: async (a, s) => {
    await s(() => a.ready()); await s(() => a.grant('held', 'task:held', ['example.com'])); await s(() => a.keyFile());
    await s(() => a.mode('conflict'));
    await s(() => a.set({ mono: 30000 })); await s(() => a.ready());               // expired, backoff
    await s(() => a.set({ mono: 50000 })); await s(() => a.ready());               // first signed refusals: conflict starts
    await s(() => a.set({ mono: 70000 })); await s(() => a.ready());               // 20 s: still conflict
    await s(() => a.set({ mono: 90000 })); await s(() => a.mode('conflict', { nextSession: SESSION_B }));
    await s(() => a.ready()); await s(() => a.keyFile());                          // 40 s: re-key, Initial under the new key
    await s(() => a.available()); await s(() => a.grant('fresh', 'task:fresh', ['example.com']));
    await s(() => a.revoke('held')); await s(() => a.available()); await s(() => a.revoke('fresh'));
  } }));
  out.push(await run('a revoke whose snapshot was already evicted still confirms, without a summary', { script: async (a, s, p) => {
    await s(() => a.mode('normal', { finalState: 'evicted' })); await s(() => a.grant('h1', 'job.v', ['example.com'])); await s(() => a.revoke('h1')); await s(() => a.forget('h1', SNAP));
  } }));
  out.push(await run('a late active read after the acknowledgement cannot downgrade the delivered final', { script: async (a, s, p) => {
    await s(() => a.grant('h1', 'job.e', ['example.com'])); await s(() => a.revoke('h1')); await s(() => a.forget('h1', SNAP));
    await s(() => a.activity('h1'));
  } }));
  process.stdout.write(`${JSON.stringify({ version: 1, capability: CAPABILITY, masterHex: MASTER.toString('hex'), scenarios: out }, null, 1)}\n`);
}
main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exitCode = 1; });
