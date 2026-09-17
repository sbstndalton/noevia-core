'use strict';
// Configuration-scoped qualification evidence (spec-agent-execution §1).
// Append-only records; states are derived on read against the live identity.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sorted = (value) => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])])) : value;
const identityHash = (identity) => sha(JSON.stringify(sorted(identity)));

const SAMPLE = 1024 * 1024;
// Cheap artifact identity: size, mtime and the first/last MiB. Replacing a file under the
// same name changes it; hashing a 20 GB GGUF on every read does not happen.
function fileFingerprint(file) {
  if (!file) return null;
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    fd = fs.openSync(file, 'r');
    const read = (position, length) => { const buf = Buffer.alloc(length); const n = fs.readSync(fd, buf, 0, length, position); return buf.subarray(0, n); };
    const head = read(0, Math.min(SAMPLE, stat.size));
    const tail = stat.size > SAMPLE ? read(Math.max(0, stat.size - SAMPLE), SAMPLE) : Buffer.alloc(0);
    return `${stat.size}:${Math.floor(stat.mtimeMs)}:${sha(Buffer.concat([head, tail])).slice(0, 32)}`;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const PRESET_IGNORED = new Set(['model', 'mmproj', 'spec-draft-model']);
function presetHash(options) {
  const clean = Object.fromEntries(Object.entries(options || {}).filter(([k, v]) => !PRESET_IGNORED.has(k) && v !== '' && v != null).map(([k, v]) => [k, String(v)]));
  return identityHash(clean);
}

// Append-only in normal use. When the log passes maxBytes it is rewritten keeping the newest
// keepPerKey records for each model/category/identity, so per-reply producers (MTP acceptance)
// cannot grow it without bound while every identity keeps its latest evidence.
function createStore(dir, { maxBytes = 1024 * 1024, keepPerKey = 50 } = {}) {
  const file = path.join(dir, 'evidence.jsonl');
  function compact() {
    const records = list();
    const counts = new Map(), keep = new Array(records.length).fill(false);
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i], key = `${r.model}|${r.category}|${r.identityHash}`;
      const n = counts.get(key) || 0;
      if (n < keepPerKey) { keep[i] = true; counts.set(key, n + 1); }
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, records.filter((_, i) => keep[i]).map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function list() {
    try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
    catch { return []; }
  }
  function append(record) {
    const entry = { id: 'ev_' + crypto.randomUUID(), at: Date.now(), limitations: [], ...record };
    if (!entry.category || !entry.model || !['passed', 'failed', 'reported'].includes(entry.result)) throw Error('Invalid evidence record');
    if (/Bearer\s+[A-Za-z0-9._~+/=-]{8,}|\bhf_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{16,}|"(?:api_?key|password|secret|access_?token|authorization)"\s*:/i.test(JSON.stringify(entry))) throw Error('Evidence must not contain credentials');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    try { if (fs.statSync(file).size > maxBytes) compact(); } catch { /* compaction is best-effort */ }
    return entry;
  }
  // Skip a record when the newest one for the same category and identity already says the same.
  function appendIfChanged(record) {
    const newest = list().filter((r) => r.model === record.model && r.category === record.category && r.identityHash === record.identityHash).at(-1);
    if (newest && newest.result === record.result && JSON.stringify(newest.value ?? null) === JSON.stringify(record.value ?? null)) return newest;
    return append(record);
  }
  // Reported rates drift a little on every reply; keep one record per meaningful change or per day.
  function appendReportedRate(record, { minDelta = 0.05, maxAgeMs = 86400000, now = Date.now() } = {}) {
    const newest = list().filter((r) => r.model === record.model && r.category === record.category && r.identityHash === record.identityHash).at(-1);
    const rate = Number(record.value?.rate), prev = Number(newest?.value?.rate);
    if (newest && Number.isFinite(rate) && Number.isFinite(prev) && Math.abs(rate - prev) < minDelta && now - newest.at < maxAgeMs) return newest;
    return append(record);
  }
  return { list, append, appendIfChanged, appendReportedRate, file };
}

const CATEGORIES = ['context_capacity', 'vision', 'mtp_acceptance', 'throughput'];

function derive(records, { model, category, liveHash }) {
  const mine = records.filter((r) => r.model === model && r.category === category);
  if (!liveHash) return { category, state: 'unavailable', record: mine.at(-1) || null };
  const matching = mine.filter((r) => r.identityHash === liveHash);
  const newestMatch = matching.at(-1);
  if (newestMatch?.result === 'passed') return { category, state: 'verified', record: newestMatch };
  if (newestMatch?.result === 'failed') return { category, state: 'failed', record: newestMatch };
  if (newestMatch?.result === 'reported') return { category, state: 'reported', record: newestMatch };
  const older = mine.filter((r) => r.result !== 'reported').at(-1);
  if (older) return { category, state: 'stale', record: older };
  return { category, state: 'unverified', record: null };
}

module.exports = { identityHash, fileFingerprint, presetHash, createStore, derive, CATEGORIES };
