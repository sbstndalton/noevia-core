'use strict';
// HTTP contract recorder (full-Rust migration M0). Opt-in: NOEVIA_CONTRACT_RECORD=<dir> makes the
// UI listener write one JSON file per request/response pair into <dir>; unset, `fromEnv` returns
// null and index.cjs serves with the handler unchanged (no wrapper, no listeners, no copies).
//
// A recorded exchange is a contract for noevia-rs tools/replay, not a log, so nothing secret or
// run-specific may be written:
//   - secrets (cookies, CSRF and bearer tokens, passwords, keys, setup/invitation/recovery codes,
//     any value of a secret-named JSON field or query parameter, long random-looking strings, and
//     the values of secret-named environment variables) become `<secret:N>`;
//   - ids (UUIDs, long hex, values of id-named fields) become `<id:N>`;
//   - build stamps (`version`, `commit`, ...) become `<version>`;
//   - configured upstream URLs (INFERENCE_BASE_URL, DIARY_BASE_URL, ...) become `<url:name>`;
//   - timestamps (ISO strings, epoch-ms numbers in time-named fields) become `<ts>`, measured
//     durations and rates (`*Ms`, `tokensPerSecond`, `timeToFirstToken`, ...) `<num>`.
// N numbers values in order of first sight across the whole recording, so the same session
// cookie, CSRF token or project id carries the same placeholder in every file: the replayer binds
// `<id:3>` to whatever the server under test answered and substitutes it into later requests.
// Placeholders are counters, never hashes, so a short secret cannot be recovered from the corpus.
// Before a file is written its text is searched for every raw secret seen so far; a hit drops the
// exchange (a `.dropped` marker records only the sequence number and path shape).

const fs = require('node:fs');
const path = require('node:path');

// Secrets this short are still replaced in their own field. Down to LEAK_SCAN_MIN they are also
// scanned for in every file, but only as a whole token (not inside a longer word) and with the
// placeholders removed first; anything shorter would drop exchanges that merely hold a common
// letter pair.
const LEAK_SCAN_MIN = 4;
const LEAK_WORD_MIN = 6; // from this length a raw substring hit counts, whatever surrounds it
const PLACEHOLDER = /<(?:secret|id):\d+>|<url:[^>]*>|<(?:origin|ts|num|version)>/g;
const MARKER = '.noevia-contract-synthetic';
const CAPTURE_LIMIT = 1024 * 1024;
const SECRET_KEY = /pass(word|phrase)?|secret|token|api[-_]?key|^key$|keys?$|authorization|cookie|credential|session(?!s)|csrf|nonce|challenge|otp|recovery|setup[-_]?code|private|signature|^code$|refresh|bearer/i;
const NUMERIC_SECRET_KEY = /pass|secret|otp|pin$|setup[-_]?code|^code$/i;
const ID_KEY = /^(id|xid|uid)$|Id$|_id$|^(ids|.*Ids)$/;
const TIME_KEY = /(At|_at|Time|_time|^ts|Ts$|^time$|^date$|^created$|^updated$|^expires$|^lastModified$|^mtime$|^modified$)$/;
// Measured durations and rates differ on every run; their value is not contract, their presence is.
const TIMING_KEY = /(Ms|_ms|Millis|Seconds|_s|PerSecond|perSecond|Duration|duration|elapsed|Elapsed|latency|Latency|uptime|Uptime|^timeToFirstToken$|^tps$|^tokensPerSecond$)$/;
// A build stamp is the release's, not the contract's.
const VERSION_KEY = /^(version|serverVersion|buildVersion|commit|gitSha)$/;
const ISO_TS = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g;
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const UUID_ONE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /\b[0-9a-f]{12,}\b/g;
// Base64url-ish runs of 24+ chars with at least one digit and mixed case: tokens, not words.
const RANDOMISH = /[A-Za-z0-9_-]{24,}={0,2}/g;
const VOLATILE_HEADERS = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'etag', 'last-modified', 'age', 'server-timing', 'x-response-time', 'host', 'accept-encoding', 'accept-language', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']);
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-csrf-token', 'x-api-key', 'x-cowork-tenant-assertion', 'x-diary-tenant-key']);
// user-agent is kept: the server stores it on the session, so a replay must send the same one.
const REQUEST_HEADERS = /^(content-type|accept|user-agent|x-csrf-token|cookie|origin|authorization|x-cowork-.*|x-noevia-.*|last-event-id|if-none-match|range)$/;
const ENV_SECRET = /KEY|TOKEN|SECRET|PASSWORD|PASS$|CREDENTIAL|COOKIE/i;

function idLike(s) {
  // A letter and a digit: `proj-1791600933849-w10hvg`, a UUID; not `127.0.0.1` or a count.
  return s.length >= 8 && /\d/.test(s) && /[A-Za-z]/.test(s) && /^[A-Za-z0-9_.:-]+$/.test(s);
}

function isRandomish(s) {
  return /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
}

// `upstreams` maps a configured service URL (the model server, the Diary) to a name: it is
// `<url:name>` in the corpus, because its host and port belong to the run, not the contract.
function createNormaliser({ envSecrets = [], origin = '', upstreams = {} } = {}) {
  const upstreamPairs = Object.entries(upstreams).filter(([u]) => u).map(([u, n]) => [u.replace(/\/+$/, ''), `<url:${n}>`]).sort((a, b) => b[0].length - a[0].length);
  const secrets = new Map(); // raw -> placeholder
  const ids = new Map();
  let secretN = 0; let idN = 0;
  const secret = (raw) => {
    const value = String(raw);
    if (!value) return value;
    if (!secrets.has(value)) secrets.set(value, `<secret:${++secretN}>`);
    return secrets.get(value);
  };
  // Only random-looking ids get a placeholder: `default` or `general` stay literal (they are the
  // same on every server), and a word is never rewritten inside prose.
  const id = (raw) => {
    const value = String(raw);
    if (!idLike(value) || /^<(secret|id):\d+>$/.test(value)) return value;
    if (secrets.has(value)) return secrets.get(value);
    if (!ids.has(value)) ids.set(value, `<id:${++idN}>`);
    return ids.get(value);
  };
  for (const v of envSecrets) if (typeof v === 'string' && v.length >= 6) secret(v);

  // Known values first (longest first so a token containing an id is replaced whole), then shapes.
  function text(input) {
    let s = String(input);
    // The server's own origin (a run-specific port in a corpus run) is <origin> wherever it appears.
    if (origin && s.includes(origin)) s = s.split(origin).join('<origin>');
    for (const [u, name] of upstreamPairs) if (s.includes(u)) s = s.split(u).join(name);
    const known = [...secrets.keys(), ...ids.keys()].filter((k) => k.length >= 6).sort((a, b) => b.length - a.length);
    for (const k of known) if (s.includes(k)) s = s.split(k).join(secrets.get(k) || ids.get(k));
    s = s.replace(ISO_TS, '<ts>');
    s = s.replace(UUID, (m) => id(m));
    s = s.replace(LONG_HEX, (m) => (/[a-f]/.test(m) && /\d/.test(m) ? id(m) : m));
    s = s.replace(RANDOMISH, (m) => (isRandomish(m) ? secret(m) : m));
    if (HTTP_DATE.test(s)) return '<ts>';
    return s;
  }

  function value(v, key = '') {
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (TIME_KEY.test(key) && v > 1e9) return '<ts>';
      if (key && TIMING_KEY.test(key)) return '<num>';
      if (key && NUMERIC_SECRET_KEY.test(key)) return secret(v);
      return v;
    }
    if (typeof v === 'string') {
      if (key && SECRET_KEY.test(key) && v !== '') return secret(v);
      if (key && VERSION_KEY.test(key)) return '<version>';
      if (key && ID_KEY.test(key)) return id(v);
      if (key && TIME_KEY.test(key) && !Number.isNaN(Date.parse(v)) && /\d{4}/.test(v)) return '<ts>';
      return text(v);
    }
    if (Array.isArray(v)) return v.map((x) => value(x, ID_KEY.test(key) ? 'id' : SECRET_KEY.test(key) ? 'secret' : ''));
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) {
        // A key can itself be an id (a map keyed by project id).
        const nk = UUID_ONE.test(k) || idLike(k) ? text(k) : k;
        out[nk] = value(v[k], k);
      }
      return out;
    }
    return String(v);
  }

  function cookiePairs(header) {
    return String(header).split(';').map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return part.trim();
      const name = part.slice(0, eq).trim();
      const val = part.slice(eq + 1).trim();
      return val ? `${name}=${secret(val)}` : `${name}=`;
    }).join('; ');
  }

  function setCookie(header) {
    const [first, ...attrs] = String(header).split(';');
    const eq = first.indexOf('=');
    const name = eq < 0 ? first.trim() : first.slice(0, eq).trim();
    const val = eq < 0 ? '' : first.slice(eq + 1).trim();
    const rest = attrs.map((a) => a.trim()).map((a) => (/^expires=/i.test(a) ? 'Expires=<ts>' : a));
    return [`${name}=${val ? secret(val) : ''}`, ...rest].join('; ');
  }

  function header(name, raw, { origin } = {}) {
    const n = name.toLowerCase();
    const list = Array.isArray(raw) ? raw : [raw];
    const one = (v) => {
      const s = String(v);
      if (n === 'cookie') return cookiePairs(s);
      if (n === 'set-cookie') return setCookie(s);
      if (n === 'origin') return origin && s === origin ? '<origin>' : text(s);
      if (n === 'location' && origin && s.startsWith(origin)) return `<origin>${text(s.slice(origin.length))}`;
      if (SECRET_HEADERS.has(n) || /token|secret|key|assertion/i.test(n)) {
        const m = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(s);
        return m ? `${m[1]} ${secret(m[2])}` : secret(s);
      }
      return text(s);
    };
    return list.length === 1 && !Array.isArray(raw) ? one(list[0]) : list.map(one);
  }

  function url(raw) {
    const u = new URL(raw, 'http://contract.invalid');
    const segments = u.pathname.split('/').map((seg) => {
      if (!seg) return seg;
      let decoded = seg;
      try { decoded = decodeURIComponent(seg); } catch { /* keep raw */ }
      const t = text(decoded);
      return t === decoded ? seg : t;
    });
    const query = [];
    for (const [k, v] of u.searchParams) query.push([k, SECRET_KEY.test(k) || k === 'state' ? secret(v) : ID_KEY.test(k) ? id(v) : text(v)]);
    return { path: segments.join('/'), query };
  }

  // Raw values that must never reach disk: every secret, plus nothing else (ids may repeat in
  // prose, timestamps are harmless).
  // The forms a file can hold a value in: as is, percent-encoded (path, query, form), base64 /
  // base64url, and escaped inside a JSON string (the files are pretty-printed JSON).
  function forms(raw) {
    const out = new Set([raw]);
    const b64 = Buffer.from(raw, 'utf8').toString('base64');
    for (const f of [encodeURIComponent(raw), encodeURIComponent(raw).replace(/%20/g, '+'), JSON.stringify(raw).slice(1, -1),
      b64, b64.replace(/=+$/, ''), b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')]) out.add(f);
    return [...out].filter((f) => f.length >= LEAK_SCAN_MIN);
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function holds(text, raw) {
    for (const form of forms(raw)) {
      if (form.length >= LEAK_WORD_MIN) { if (text.includes(form)) return true; continue; }
      if (new RegExp(`(?<![A-Za-z0-9])${escapeRe(form)}(?![A-Za-z0-9])`).test(text)) return true;
    }
    return false;
  }
  // `only` limits the check to those raw values (rescan); default is every secret seen so far.
  function leaks(serialised, only) {
    const text = String(serialised).replace(PLACEHOLDER, '');
    for (const raw of only || secrets.keys()) if (raw.length >= LEAK_SCAN_MIN && holds(text, raw)) return true;
    return false;
  }

  // Secrets first seen after `since` (a count from secretCount()): an earlier file cannot have
  // been checked for them when it was written.
  const secretCount = () => secrets.size;
  const secretsSince = (since) => [...secrets.keys()].slice(since).filter((raw) => raw.length >= LEAK_SCAN_MIN);

  return { value, text, header, url, leaks, secret, id, secretCount, secretsSince };
}

function parseSse(text, norm) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const ev = {};
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) { ev.comment = true; continue; }
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'data') data.push(val);
      else if (field === 'event') ev.event = val;
      else if (field === 'id') ev.id = norm.text(val);
      else if (field === 'retry') ev.retry = Number(val);
    }
    if (data.length) {
      const joined = data.join('\n');
      try { ev.data = norm.value(JSON.parse(joined)); ev.json = true; } catch { ev.data = norm.text(joined); }
    }
    if (ev.comment && Object.keys(ev).length === 1) continue; // keep-alive pings are not contract
    delete ev.comment;
    events.push(ev);
  }
  return events;
}

function body(buffer, contentType, norm, truncated, { api }) {
  if (!buffer.length) return { kind: 'empty' };
  const ct = String(contentType || '').toLowerCase();
  const textual = /json|text\/|event-stream|x-www-form-urlencoded|xml|javascript/.test(ct) || !ct;
  if (truncated) return { kind: 'truncated', length: buffer.length };
  const s = buffer.toString('utf8');
  if (ct.includes('event-stream')) return { kind: 'sse', events: parseSse(s, norm) };
  if (ct.includes('json') || (!ct && /^\s*[[{]/.test(s))) {
    try { return { kind: 'json', json: norm.value(JSON.parse(s)) }; } catch { /* fall through */ }
  }
  if (ct.includes('x-www-form-urlencoded')) {
    const out = [];
    for (const [k, v] of new URLSearchParams(s)) out.push([k, SECRET_KEY.test(k) ? norm.secret(v) : norm.text(v)]);
    return { kind: 'form', form: out };
  }
  // Static assets and downloads: shape only. API text is normalised like any string.
  if (!api || !textual) return { kind: 'bytes', length: buffer.length };
  return { kind: 'text', text: norm.text(s) };
}

function slug(p) {
  return p.replace(/<(secret|id):\d+>/g, (m, k) => k).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'root';
}

/** Returns a recorder for `dir`, or null. Options: env (for secret values), origin (the public
 *  origin, recorded as <origin>), clock (tests), filter(path) => boolean (default: /api/ only). */
function createContractRecorder({ dir, env = {}, origin = '', filter } = {}) {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const envSecrets = Object.entries(env).filter(([k, v]) => ENV_SECRET.test(k) && typeof v === 'string').map(([, v]) => v);
  const upstreams = {};
  for (const [k, name] of [['INFERENCE_BASE_URL', 'inference'], ['LEMONADE_BASE_URL', 'inference'], ['MODEL_MANAGER_BASE_URL', 'model-manager'], ['MODEL_LOADER_URL', 'model-loader'], ['DIARY_BASE_URL', 'diary'], ['OCR_BASE_URL', 'ocr']]) {
    const u = String(env[k] || '').trim();
    if (u && !upstreams[u]) upstreams[u] = name;
  }
  const norm = createNormaliser({ envSecrets, origin, upstreams });
  // A reused directory restarts the numbering and keeps stale files the rescan never checks.
  if (fs.readdirSync(dir).length) throw new Error(`contract recorder: ${dir} is not empty; record into a new directory`);
  const keep = filter || ((p) => p.startsWith('/api/'));
  let seq = 0;
  let scanned = 0; // secrets every written file has been checked against
  const written = [];

  function capture(target, method) {
    const chunks = []; let size = 0; let truncated = false;
    const orig = target[method];
    target[method] = function (chunk, ...rest) {
      if (chunk !== null && chunk !== undefined && typeof chunk !== 'function') {
        const b = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : typeof chunk === 'string' ? Buffer.from(chunk, typeof rest[0] === 'string' ? rest[0] : 'utf8') : null;
        if (b) { if (size + b.length > CAPTURE_LIMIT) truncated = true; else { chunks.push(Buffer.from(b)); size += b.length; } }
      }
      return orig.call(this, chunk, ...rest);
    };
    return () => ({ buffer: Buffer.concat(chunks), truncated });
  }

  function record(req, res, startOrder) {
    const reqPath = String(req.url || '/').split('?')[0];
    if (!keep(reqPath)) return;
    // Request body: `push` is how the HTTP parser hands chunks to the stream whatever the
    // consumer's read mode (for await, 'data', pipe), so teeing it changes nothing it sees.
    const reqBody = capture(req, 'push');
    const resWrite = capture(res, 'write');
    const resEnd = capture(res, 'end');
    let headHeaders = null;
    const writeHead = res.writeHead;
    res.writeHead = function (status, ...rest) {
      const h = rest.find((x) => x && typeof x === 'object');
      if (h) headHeaders = Array.isArray(h) ? h : { ...h };
      return writeHead.call(this, status, ...rest);
    };
    const done = () => {
      try {
        const w = resWrite(); const e = resEnd(); const rb = reqBody();
        const resBuf = Buffer.concat([w.buffer, e.buffer]);
        const headers = { ...res.getHeaders() };
        if (headHeaders && !Array.isArray(headHeaders)) for (const [k, v] of Object.entries(headHeaders)) headers[k.toLowerCase()] = v;
        write(startOrder, req, res.statusCode, headers, rb, { buffer: resBuf, truncated: w.truncated || e.truncated }, res.writableFinished === false);
      } catch (err) {
        console.warn('[contract-record] could not record an exchange:', err?.message || err);
      }
    };
    let fired = false;
    const once = () => { if (!fired) { fired = true; done(); } };
    res.once('finish', once);
    res.once('close', once);
  }

  function write(order, req, status, resHeaders, reqBody, resBody, aborted) {
    const u = norm.url(req.url || '/');
    const reqHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const n = k.toLowerCase();
      if (!REQUEST_HEADERS.test(n) || VOLATILE_HEADERS.has(n)) continue;
      reqHeaders[n] = norm.header(n, v, { origin });
    }
    const outHeaders = {};
    for (const [k, v] of Object.entries(resHeaders)) {
      const n = k.toLowerCase();
      if (VOLATILE_HEADERS.has(n) || v === undefined) continue;
      outHeaders[n] = norm.header(n, v, { origin });
    }
    const api = u.path.startsWith('/api/');
    const exchange = {
      v: 1,
      seq: order,
      request: { method: req.method, path: u.path, query: u.query, headers: sortKeys(reqHeaders), body: body(reqBody.buffer, req.headers['content-type'], norm, reqBody.truncated, { api }) },
      response: { status, headers: sortKeys(outHeaders), body: body(resBody.buffer, resHeaders['content-type'], norm, resBody.truncated, { api }), ...(aborted ? { aborted: true } : {}) },
    };
    const text = `${JSON.stringify(exchange, null, 2)}\n`;
    const base = `${String(order).padStart(6, '0')}-${req.method}-${slug(u.path)}`;
    if (norm.leaks(text)) {
      fs.writeFileSync(path.join(dir, `${base}.dropped`), `${JSON.stringify({ seq: order, method: req.method, reason: 'a secret value survived normalisation' })}\n`, { mode: 0o600 });
      return;
    }
    fs.writeFileSync(path.join(dir, `${base}.json`), text, { mode: 0o600 });
    written.push(base);
    rescan();
  }

  // A value can become known as a secret only in a later exchange (a password typed into a form
  // whose earlier page showed it as plain text). Re-check the files already written for it.
  function rescan() {
    const fresh = norm.secretsSince(scanned);
    scanned = norm.secretCount();
    if (!fresh.length) return;
    for (let i = written.length - 1; i >= 0; i -= 1) {
      const base = written[i];
      const file = path.join(dir, `${base}.json`);
      let content;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (!norm.leaks(content, fresh)) continue;
      fs.writeFileSync(path.join(dir, `${base}.dropped`), `${JSON.stringify({ seq: Number(base.slice(0, 6)), reason: 'a secret value seen in a later exchange' })}\n`, { mode: 0o600 });
      fs.rmSync(file, { force: true });
      written.splice(i, 1);
    }
  }

  return {
    dir,
    normaliser: norm,
    /** Wraps a (req, res) handler; the order number is taken when the request arrives. */
    wrap(handler) {
      return (req, res) => {
        const order = ++seq;
        try { record(req, res, order); } catch (err) { console.warn('[contract-record] not recording:', err?.message || err); }
        return handler(req, res);
      };
    },
  };
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

function loopbackHost(h) {
  const host = String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === '' || host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

function loopbackOrigin(o) {
  const v = String(o || '').trim();
  if (!v) return true;
  try { return loopbackHost(new URL(v).hostname); } catch { return false; }
}

/** A recording needs a synthetic deployment: UI_HOST and PUBLIC_ORIGIN loopback or unset, or the
 *  marker generate.cjs writes into the throwaway data dir it hands the server. A real deploy that
 *  keeps the variable set after its first boot has neither, so it records nothing. */
function syntheticDeployment(env) {
  if (loopbackHost(env.UI_HOST) && loopbackOrigin(env.PUBLIC_ORIGIN)) return true;
  const dataDir = String(env.UI_DATA_DIR || '').trim();
  return Boolean(dataDir) && fs.existsSync(path.join(dataDir, MARKER));
}

/** null unless NOEVIA_CONTRACT_RECORD names a directory. `accounts` is how many accounts the data
 *  dir held at boot: recording needs a fresh synthetic data dir, because prose (chat text, names,
 *  file contents) is kept verbatim, so a dir that already has accounts is refused. */
function fromEnv(env = process.env, { accounts = 0, ...opts } = {}) {
  const dir = String(env.NOEVIA_CONTRACT_RECORD || '').trim();
  if (!dir) return null;
  if (accounts > 0) {
    console.error(`[contract-record] NOEVIA_CONTRACT_RECORD is set but this data dir already has ${accounts} account(s); not recording. Record only against a fresh synthetic UI_DATA_DIR.`);
    return null;
  }
  if (!syntheticDeployment(env)) {
    console.error('[contract-record] NOEVIA_CONTRACT_RECORD is set but UI_HOST / PUBLIC_ORIGIN are not loopback and the data dir has no synthetic marker; not recording. Only tools/contract-corpus/generate.cjs may record a non-loopback server.');
    return null;
  }
  let recorder;
  try {
    recorder = createContractRecorder({ dir: path.resolve(dir), env, origin: String(env.PUBLIC_ORIGIN || '').replace(/\/$/, ''), ...opts });
  } catch (err) {
    console.error(`[contract-record] not recording: ${err.message}`);
    return null;
  }
  console.warn(`[contract-record] NOEVIA_CONTRACT_RECORD is set: recording normalised /api/ exchanges to ${recorder.dir}. Never enable this on a deployment that serves real users.`);
  return recorder;
}

module.exports = { MARKER, syntheticDeployment, createContractRecorder, createNormaliser, fromEnv, parseSse };
