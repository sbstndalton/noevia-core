'use strict';
// Private control/data-key closures; static capability metadata is never a Ready proof.
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const { mintGrant, grantHosts, DEFAULT_TOKEN_TTL_MS } = require('./code-egress.cjs');
const CAPABILITY = 'noevia-code-egress-control/1';
const ROUTES = Object.freeze(Object.fromEntries(['ready', 'renew', 'activity', 'revoke', 'forget'].map((name) => [name, `/v1/control/${name}`])));
const MAX_REQUEST = 32768, MAX_RESPONSE = 65536, SESSION_MS = 15000, RENEW_MS = 5000, MAX_HANDLES = 256, RETRY_MIN_MS = 1000, RETRY_MAX_MS = 15000;
const HEX32 = /^[0-9a-f]{32}$/, HEX64 = /^[0-9a-f]{64}$/, TASK = /^[A-Za-z0-9._:-]{1,128}$/;
class ControlError extends Error {
  constructor(reason = 'unavailable') { super('native egress is unavailable'); this.name = 'EgressControlError'; this.code = 'EGRESS_UNAVAILABLE'; this.status = 503; this.reason = reason; }
}
const error = (reason) => new ControlError(reason);
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function key32(key) { if (!Buffer.isBuffer(key) || key.length !== 32) throw error('key'); return key; }
function id(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) throw error('identity'); return value; }
function safeInt(value, positive = true) { if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw error('integer'); return value; }
function deriveFileKey(master, nonce) { key32(master); key32(nonce); return hmac(master, Buffer.concat([Buffer.from(`${CAPABILITY}:web-key\0`), nonce])); }
function deriveControlKey(file) { return hmac(key32(file), Buffer.from(`${CAPABILITY}:control-key\0`)); }
function deriveGrantKey(file, boot, session) { return hmac(key32(file), Buffer.concat([Buffer.from(`${CAPABILITY}:grant-key\0`), Buffer.from(id(boot, HEX32), 'hex'), Buffer.from(id(session, HEX32), 'hex')])); }
function requestMac(file, route, meta, body) {
  if (!Object.values(ROUTES).includes(route) || !Buffer.isBuffer(body) || body.length > MAX_REQUEST) throw error('request');
  id(meta.requestId, HEX32); id(meta.keyFingerprint, HEX64); safeInt(meta.deadlineMs);
  if (meta.bootId !== null) id(meta.bootId, HEX32);
  return hmac(deriveControlKey(file), `${CAPABILITY}:request\nPOST\n${route}\n${meta.requestId}\n${meta.deadlineMs}\n${meta.bootId || ''}\n${meta.keyFingerprint}\n${sha(body)}\n`).toString('hex');
}
function responseMac(file, requestTag, status, body) {
  id(requestTag, HEX64); if (!Number.isInteger(status) || status < 100 || status > 599 || !Buffer.isBuffer(body) || body.length > MAX_RESPONSE) throw error('response');
  return hmac(deriveControlKey(file), `${CAPABILITY}:response\n${requestTag}\n${status}\n${sha(body)}\n`).toString('hex');
}
function equalTag(actual, expected) { return typeof actual === 'string' && HEX64.test(actual) && crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')); }
function endpointAddress(endpoint) {
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):([1-9][0-9]{0,4})$/.exec(String(endpoint));
  if (!m || Number(m[2]) > 65535 || m[1].length > 253) throw error('endpoint');
  const host = m[1].startsWith('[') ? m[1].slice(1, -1) : m[1];
  if (m[1].startsWith('[') && net.isIP(host) !== 6) throw error('endpoint');
  return { host, port: Number(m[2]) };
}
function defaultTransport({ endpoint, route, headers, body, timeoutMs, signal }) {
  const address = endpointAddress(endpoint);
  return new Promise((resolve, reject) => {
    let done = false, bytes = 0; const chunks = [];
    const finish = (err, result) => { if (done) return; done = true; clearTimeout(timer); if (err) reject(error('transport')); else resolve(result); };
    const req = http.request({ host: address.host, port: address.port, method: 'POST', path: route, headers, signal, agent: false, maxHeaderSize: 16384 }, (res) => {
      res.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_RESPONSE) { req.destroy(); finish(error('response')); } else chunks.push(chunk); });
      res.on('aborted', () => finish(error('transport'))); res.on('error', () => finish(error('transport')));
      res.on('end', () => finish(null, { status: res.statusCode, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => { req.destroy(); finish(error('timeout')); }, timeoutMs);
    req.on('error', () => finish(error('transport'))); req.end(body);
  });
}
function responseHeaders(raw, body) {
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > 32) throw error('headers');
  const headers = Object.create(null); let size = 2;
  for (let i = 0; i < raw.length; i += 2) {
    const name = String(raw[i]).toLowerCase(), value = raw[i + 1];
    if (typeof value !== 'string' || Object.hasOwn(headers, name) || !['date', 'content-type', 'content-length', 'cache-control', 'connection', 'x-noevia-control-mac'].includes(name)) throw error('headers');
    size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4; if (size > 16384) throw error('headers'); headers[name] = value;
  }
  if (headers['content-type'] !== 'application/json' || headers['content-length'] !== String(body.length) || headers['cache-control'] !== 'no-store' || headers.connection !== 'close') throw error('headers');
  return headers;
}
function closedKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some((k) => !Object.hasOwn(value, k)) || Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))) throw error('shape');
}
function cloneFrozen(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) cloneFrozen(child); Object.freeze(value); } return value; }
function reportValue(body, record) {
  closedKeys(body, ['version', 'requestId', 'state', 'bootId', 'sessionId', 'taskId', 'leaseNonce', 'barrierInstalled', 'drained', 'snapshot']);
  scope(body, record); if (typeof body.barrierInstalled !== 'boolean' || typeof body.drained !== 'boolean') throw error('scope');
  const s = body.snapshot; closedKeys(s, ['id', 'state', 'final', 'summary', 'partial', 'overflow']); id(s.id, HEX32);
  if (!['complete', 'partial', 'interrupted', 'evicted', 'forgotten'].includes(s.state) || typeof s.final !== 'boolean' || typeof s.partial !== 'boolean' || typeof s.overflow !== 'boolean' || s.final !== body.drained) throw error('snapshot');
  const available = s.summary !== null;
  if (available) {
    closedKeys(s.summary, ['allowed', 'refused', 'hosts']); safeInt(s.summary.allowed, false); safeInt(s.summary.refused, false);
    if (!Array.isArray(s.summary.hosts) || s.summary.hosts.length > 50 || Buffer.byteLength(JSON.stringify(s.summary)) > 48 * 1024) throw error('summary');
    for (const row of s.summary.hosts) { closedKeys(row, ['host', 'allowed', 'refused', 'reason']); if (typeof row.host !== 'string' || !row.host || !(row.reason === null || typeof row.reason === 'string')) throw error('summary'); safeInt(row.allowed, false); safeInt(row.refused, false); }
    for (const k of ['allowed', 'refused']) { const total = s.summary.hosts.reduce((sum, h) => sum + BigInt(h[k]), 0n); if (BigInt(s.summary[k]) !== (total > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : total)) throw error('summary'); }
  } else if (!['evicted', 'forgotten'].includes(s.state)) throw error('summary');
  return cloneFrozen({ available, state: s.state, final: s.final, partial: s.partial, overflow: s.overflow, snapshotId: s.id, ...(available ? s.summary : {}) });
}
function scope(body, record) {
  if (body.bootId !== record.boot || body.sessionId !== record.session || body.taskId !== record.claims.task || body.leaseNonce !== record.claims.nonce) throw error('scope');
}
// Publication is confined to a preexisting trusted local key volume. No mkdir,
// permission repair, old-key restoration, or path/value leakage on failure.
function publishWebKey({ masterKey, file, uid, gid }) {
  key32(masterKey);
  return writeKeyFile({ file, uid, gid, make: () => deriveFileKey(masterKey, crypto.randomBytes(32)), replace: true });
}
// Recovery only: restores this process's own key to a trusted directory that lost it. It never
// replaces a present file, which may be a newer web's key or a fault the operator must see.
function republishMissingKey({ fileKey, file, uid, gid }) {
  const fs = require('node:fs'); key32(fileKey);
  try { fs.lstatSync(file); return false; } catch (e) { if (e.code !== 'ENOENT') throw error('publication'); }
  writeKeyFile({ file, uid, gid, make: () => fileKey, replace: false });
  return true;
}
function writeKeyFile({ file, uid, gid, make, replace }) {
  const fs = require('node:fs'), path = require('node:path');
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || file.includes('\0') || !Number.isInteger(uid) || uid < 0 || uid >= 0xffffffff || !Number.isInteger(gid) || gid <= 0 || gid >= 0xffffffff || process.getuid?.() !== uid || !Number.isInteger(fs.constants.O_NOFOLLOW)) throw error('publication');
  const dir=path.dirname(file); let fd, temporary, created=false;
  try {
    const parent=fs.lstatSync(dir);
    if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(dir)!==dir || parent.uid!==uid || parent.gid!==gid || (parent.mode&0o022)!==0 || (parent.mode&0o050)!==0o050) throw error('publication');
    try { const old=fs.lstatSync(file); if(!old.isFile()||old.isSymbolicLink()||old.nlink!==1||old.uid!==uid||old.gid!==gid||(old.mode&0o7777)!==0o440) throw error('publication'); } catch(e) {if(e.code!=='ENOENT') throw e;}
    const fileKey=make();
    temporary=path.join(dir,`.egress-key-${crypto.randomBytes(16).toString('hex')}.tmp`);
    fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o440);created=true;
    fs.fchownSync(fd,uid,gid);fs.fchmodSync(fd,0o440);fs.writeFileSync(fd,`${fileKey.toString('hex')}\n`);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    const current=fs.lstatSync(dir);if(current.dev!==parent.dev||current.ino!==parent.ino) throw error('publication');
    if(replace){fs.renameSync(temporary,file);created=false;}
    else{fs.linkSync(temporary,file);fs.unlinkSync(temporary);created=false;}
    return fileKey;
  } catch {
    if(fd!==undefined)try{fs.closeSync(fd);}catch{}
    if(created)try{fs.unlinkSync(temporary);}catch{}
    throw error('publication');
  }
}
function createControlClient({ fileKey, endpoint, now = Date.now, monotonic = () => performance.now(), transport = defaultTransport, log = () => {}, ttlMs = DEFAULT_TOKEN_TTL_MS, lifetimeMs = 7200000, autoRenew = true, republishKey = null, retryMinMs = RETRY_MIN_MS, retryMaxMs = RETRY_MAX_MS } = {}) {
  fileKey = Buffer.from(key32(fileKey)); endpointAddress(endpoint);
  const fingerprint = sha(fileKey), records = new WeakMap(), active = new Set(), latest = new Map();
  const life = Math.min(safeInt(lifetimeMs), 86400000), idle = Math.min(safeInt(ttlMs), life);
  // `epoch` is the only network authority. A failure drops it and only an authenticated Ready for a
  // different session restores it: the proxy refuses that Ready until the old session is dead (expired,
  // retired or lost with its process), so an uncertain revoke cannot survive recovery. The clock fault alone is final.
  let epoch = null, lastEpoch = null, readyFlight = null, renewFlight = null, timer = null, retryTimer = null, failed = false, closed = false, clockFault = false, lastMono = -Infinity, nextAttempt = -Infinity, retryDelay = retryMinMs, downSince = null;
  const note = (entry) => { try { log(entry); } catch { /* diagnostics cannot change authority */ } };
  const stopTimers = () => { clearTimeout(timer); timer = null; clearTimeout(retryTimer); retryTimer = null; };
  const mono = () => { const value = monotonic(); if (!Number.isFinite(value) || value < lastMono) { failed = true; clockFault = true; epoch = null; stopTimers(); throw error('clock'); } lastMono = value; return value; };
  function armRetry() {
    clearTimeout(retryTimer); retryTimer = null;
    if (!autoRenew || closed || clockFault || !failed) return;
    retryTimer = setTimeout(() => { retryTimer = null; ready().catch(() => { if (!retryTimer) armRetry(); }); }, Math.max(retryMinMs, nextAttempt - lastMono));
    retryTimer.unref?.();
  }
  const fail = (reason, holdUntil = -Infinity) => {
    if (!failed) { downSince = Number.isFinite(lastMono) ? lastMono : 0; note({ event: 'egress.control_unavailable', reason }); }
    failed = true; if (epoch) { lastEpoch = epoch; epoch = null; }
    clearTimeout(timer); timer = null;
    nextAttempt = Math.max((Number.isFinite(lastMono) ? lastMono : 0) + retryDelay, holdUntil); retryDelay = Math.min(retryDelay * 2, retryMaxMs);
    armRetry();
  };
  const stamp = (task) => { const wall = safeInt(now()), t = Math.max(wall, (latest.get(task) || 0) + 1); if (!Number.isSafeInteger(t) || t - wall > 60000) throw error('clock'); latest.delete(task); latest.set(task, t); if (latest.size > 10000) latest.delete(latest.keys().next().value); return t; };
  async function rpc(name, body, boot, budgetMs = 10000) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw error('timeout');
    const first = mono(), until = first + Math.min(10000, budgetMs), requestId = crypto.randomBytes(16).toString('hex');
    const bytes = Buffer.from(JSON.stringify(body)); if (bytes.length > MAX_REQUEST) throw error('request');
    const meta = { requestId, deadlineMs: safeInt(now()) + Math.ceil(until - first), bootId: boot, keyFingerprint: fingerprint };
    const tag = requestMac(fileKey, ROUTES[name], meta, bytes);
    const headers = { 'content-type': 'application/json', 'content-length': bytes.length, 'cache-control': undefined, connection: 'close', 'x-noevia-request-id': requestId, 'x-noevia-deadline-ms': String(meta.deadlineMs), 'x-noevia-key-fingerprint': fingerprint, 'x-noevia-control-mac': tag };
    delete headers['cache-control']; if (boot !== null) headers['x-noevia-boot-id'] = boot;
    for (let attempt = 0; attempt < 16; attempt++) {
      const left = until - mono(); if (left <= 0) throw error('timeout');
      const abort = new AbortController(); let t;
      try {
        const reply = await Promise.race([transport({ endpoint, route: ROUTES[name], headers: { ...headers }, body: Buffer.from(bytes), timeoutMs: Math.min(7500, left), signal: abort.signal }), new Promise((_, reject) => { t = setTimeout(() => { abort.abort(); reject(error('timeout')); }, left); })]);
        clearTimeout(t);
        if (mono() >= until || safeInt(now()) >= meta.deadlineMs) throw error('stale');
        if (!reply || !Buffer.isBuffer(reply.body) || reply.body.length > MAX_RESPONSE) throw error('response');
        const h = responseHeaders(reply.rawHeaders, reply.body);
        if (!equalTag(h['x-noevia-control-mac'], responseMac(fileKey, tag, reply.status, reply.body))) throw error('authentication');
        let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.body)); } catch { throw error('response'); }
        if (!value || value.version !== 1 || value.requestId !== requestId || typeof value.state !== 'string') throw error('identity');
        if (reply.status === 202) { /* exact in-flight retry, never new mutation identity */ }
        else return { status: reply.status, value, first, requestId };
      } catch (e) {
        clearTimeout(t); abort.abort();
        if (e instanceof ControlError && !['transport', 'timeout'].includes(e.reason)) throw e;
      }
      const rest = until - mono(); if (rest <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, rest)));
    }
    throw error('uncertain');
  }
  function proof(reply, state, challenge, sequence) {
    const v = reply.value; closedKeys(v, ['version', 'requestId', 'state', 'capability', 'bootId', 'sessionId', 'keyFingerprint', 'sequence', 'leaseMs'], challenge ? ['challenge'] : []);
    id(v.bootId, HEX32); id(v.sessionId, HEX32); safeInt(v.sequence, false); safeInt(v.leaseMs);
    if (reply.status !== 200 || v.state !== state || v.capability !== CAPABILITY || v.keyFingerprint !== fingerprint || v.sequence !== sequence || v.leaseMs > SESSION_MS || (challenge && v.challenge !== challenge) || reply.first + v.leaseMs <= mono()) throw error('proof');
    if (epoch && (v.bootId !== epoch.boot || v.sessionId !== epoch.session)) throw error('epoch');
    return { boot: v.bootId, session: v.sessionId, sequence: v.sequence, until: reply.first + v.leaseMs };
  }
  function schedule() { clearTimeout(timer); if (autoRenew && !closed && !failed) { timer = setTimeout(() => { renew().catch(() => {}); }, RENEW_MS); timer.unref?.(); } }
  async function readyRequest(mode, prior) {
    const challenge = crypto.randomBytes(16).toString('hex');
    const reply = await rpc('ready', { version: 1, mode, challenge, expectedKeyFingerprint: fingerprint, priorSession: prior ? prior.session : null }, prior ? prior.boot : null);
    return { reply, challenge };
  }
  async function establish() {
    if (failed && republishKey) { try { if (republishKey()) note({ event: 'egress.key_republished' }); } catch { /* the proxy still refuses without it */ } }
    const prior = lastEpoch; let sent = null;
    // Replace answers a live proxy whose session this client held. A restarted or re-keyed proxy has
    // no such session and answers 409, signed; it accepts only Initial, which an initialized proxy refuses.
    if (prior) { sent = await readyRequest('replace', prior); if (sent.reply.status === 409) sent = null; }
    sent ||= await readyRequest('initial', null);
    const next = proof(sent.reply, 'ready', sent.challenge, 0);
    if (closed || clockFault || (prior && next.session === prior.session)) throw error('epoch');
    const recovered = failed, downMs = recovered && downSince !== null ? Math.max(0, Math.round(lastMono - downSince)) : 0;
    epoch = next; lastEpoch = null; failed = false; downSince = null; retryDelay = retryMinMs; nextAttempt = -Infinity;
    clearTimeout(retryTimer); retryTimer = null;
    // Tokens of a replaced session verify nowhere now. Their owners can still ask for a report.
    for (const r of active) if (r.session !== next.session) active.delete(r);
    note({ event: 'egress.control_ready', recovered, ...(recovered ? { downMs } : {}) });
    schedule();
    return { capability: CAPABILITY, available: true };
  }
  function ready() {
    if (closed || clockFault) return Promise.reject(error('unavailable'));
    if (epoch) { if (mono() < epoch.until) return Promise.resolve({ capability: CAPABILITY, available: true }); fail('expired'); }
    if (readyFlight) return readyFlight;
    // Inside the backoff a caller is refused at once, not parked behind a proxy that just failed.
    if (failed && mono() < nextAttempt) return Promise.reject(error('unavailable'));
    readyFlight = Promise.resolve().then(establish)
      .catch((e) => { if (!closed && !clockFault) fail('ready'); throw e instanceof ControlError ? e : error('ready'); })
      .finally(() => { readyFlight = null; });
    return readyFlight;
  }
  function renew() {
    if (renewFlight) return renewFlight;
    renewFlight = Promise.resolve().then(async () => {
      await ready(); const prior = epoch; if (!prior || !Number.isSafeInteger(prior.sequence + 1)) throw error('epoch');
      try {
        const reply = await rpc('renew', { version: 1, sessionId: prior.session, sequence: prior.sequence + 1 }, prior.boot, Math.min(1000, prior.until - mono()));
        const next = proof(reply, 'renewed', null, prior.sequence + 1); if (closed || epoch !== prior) throw error('closed'); epoch = next; schedule(); return { available: true };
      } catch (e) { if (epoch === prior) fail('renew'); throw e instanceof ControlError ? e : error('renew'); }
    }).finally(() => { renewFlight = null; });
    return renewFlight;
  }
  /** Boot without waiting: an outage is logged, retried and refused per grant, never fatal to the web. */
  function start() { ready().catch(() => {}); }
  function available() { try { return !closed && !failed && !!epoch && mono() < epoch.until; } catch { return false; } }
  async function grant({ taskId, domains = [] } = {}) {
    if (typeof taskId !== 'string' || !TASK.test(taskId)) throw error('task'); if(!Array.isArray(domains)||domains.some((v)=>typeof v!=='string')) throw error('hosts'); let hosts; try { hosts=grantHosts(domains); } catch { throw error('hosts'); } if (!hosts.length) throw error('hosts');
    await ready(); if (renewFlight) await renewFlight;
    if (closed || failed || !epoch || mono() >= epoch.until || active.size >= MAX_HANDLES) throw error('unavailable');
    const claims = { task: taskId, hosts, iat: stamp(taskId), exp: 0, idle, nonce: crypto.randomBytes(16).toString('base64url') }; claims.exp = safeInt(claims.iat + life);
    const key = deriveGrantKey(fileKey, epoch.boot, epoch.session), token = mintGrant(key, claims);
    const handle = { taskId, domains: Object.freeze([...hosts]) }; Object.defineProperty(handle, 'token', { value: token }); Object.freeze(handle);
    const record = { handle, claims, token, key, boot: epoch.boot, session: epoch.session, cleanup: null, report: null, ackable: null, acknowledged: false, forget: null };
    records.set(handle, record); active.add(record); return handle;
  }
  function recordFor(handle) { const r = handle && typeof handle === 'object' && records.get(handle); if (!r) throw error('handle'); return r; }
  const leaseBody = (r) => ({ version: 1, sessionId: r.session, taskId: r.claims.task, leaseNonce: r.claims.nonce, signedGrant: r.token });
  function retainReport(r, report) {
    // Response arrival order is not native snapshot order. Once delivered, a
    // frozen final identity remains acknowledgeable across late active reads.
    if (r.ackable !== null) {
      if (!report.final || !report.snapshotId || r.acknowledged) return;
      const prior = r.report?.state;
      if (prior === 'forgotten') return;
      if (prior === 'evicted' && !['evicted', 'forgotten'].includes(report.state)) return;
      // FIFO eviction drops the held frozen body and creates a new, unavailable
      // final snapshot. Its new identity is valid only in this forward transition.
      const evicted = ['complete', 'partial', 'interrupted'].includes(prior) && report.state === 'evicted';
      if (report.snapshotId !== r.ackable && !evicted) throw error('snapshot');
    }
    if (report.final && report.snapshotId) r.ackable = report.snapshotId;
    r.report = report;
  }
  async function activity(handle, budgetMs = 10000) {
    const r = recordFor(handle), reply = await rpc('activity', leaseBody(r), r.boot, budgetMs);
    if (reply.status !== 200 || reply.value.state !== 'activity') throw error('report');
    const report = reportValue(reply.value, r); retainReport(r, report); return report;
  }
  const unavailableReport = () => Object.freeze({ confirmed: false, report: Object.freeze({ available: false, state: 'uncertain', final: false, partial: true }) });
  function revoke(handle, budgetMs = 10000) {
    const r = recordFor(handle); if (r.cleanup) return r.cleanup;
    r.cleanup = Promise.resolve().then(async () => {
      try {
      if (budgetMs <= 0) throw error('timeout');
      const first = mono(), until = first + Math.min(10000,budgetMs), iat = stamp(r.claims.task);
      const signedRevoke = mintGrant(r.key, { act: 'revoke', task: r.claims.task, hosts: [], iat, exp: safeInt(iat + life), idle: 1, nonce: crypto.randomBytes(16).toString('base64url') });
        const reply = await rpc('revoke', { ...leaseBody(r), grantIssuedAt: r.claims.iat, signedRevoke }, r.boot, until - mono());
        let report;
        if (reply.status === 200 && reply.value.state === 'revoke-confirmed') report = reportValue(reply.value, r);
        else { scope(reply.value, r); if (reply.value.state !== 'barrier-installed' || reply.value.barrierInstalled !== true || reply.value.drained !== true) throw error('uncertain'); }
        if (report && (!report.final || reply.value.barrierInstalled !== true)) throw error('uncertain');
        if (!report) { try { report = await activity(handle, until - mono()); } catch { report = Object.freeze({ available: false, state: 'unavailable', final: true, partial: true }); } }
        if (!report.final) throw error('uncertain');
        retainReport(r, report); active.delete(r);
        return Object.freeze({ confirmed: true, report });
      } catch {
        // Only the session this lease belongs to can be left uncertain. Hold new authority until that
        // lease has run out. A lease of an already replaced session must not take the new one down.
        if (epoch && epoch.session === r.session) fail('cleanup', epoch.until);
        if (!epoch || epoch.session !== r.session) active.delete(r);
        return unavailableReport();
      }
    });
    return r.cleanup;
  }
  function forget(handle, snapshotId) {
    const r = recordFor(handle);
    if (snapshotId !== r.ackable || !HEX32.test(snapshotId)) return Promise.reject(error('snapshot'));
    if (r.forget) return r.forget;
    r.forget = Promise.resolve().then(async () => {
      try { const reply = await rpc('forget', { version: 1, sessionId: r.session, taskId: r.claims.task, leaseNonce: r.claims.nonce, snapshotId }, r.boot, 5000); scope(reply.value, r); if (reply.status !== 200 || reply.value.state !== 'forgotten' || reply.value.snapshotId !== snapshotId) throw error('forget'); r.acknowledged = true; return Object.freeze({ confirmed: true }); }
      catch { return Object.freeze({ confirmed: false }); }
    }); return r.forget;
  }
  async function close() { closed = true; stopTimers(); const until=mono()+10000; const pending = [...active]; let cursor = 0; const results = []; await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => { while (cursor < pending.length) { const r = pending[cursor++]; results.push(await revoke(r.handle, Math.max(0,until-mono()))); } })); return results; }
  return Object.freeze({ impl: 'rust-controlled', capability: CAPABILITY, endpoint, start, available, ready, renew, grant, activity, revoke, forget, close, sweep: () => 0 });
}
module.exports = { CAPABILITY, ROUTES, ControlError, publishWebKey, republishMissingKey, deriveFileKey, deriveControlKey, deriveGrantKey, requestMac, responseMac, createControlClient, defaultTransport };
