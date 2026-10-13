'use strict';
// #1639: sends the built requests (build-requests.cjs) to one decision server, one at a time, and
// records the raw answer of each. Dependency-free: it runs with the eval host's Node, no checkout.
//
//   --target laya    POST the body unchanged to <url>/v1/decisions (our contract, services/laya).
//   --target ollaya  through adapter.cjs to <url>/v1/decisions (TypeSafe), as --model.
//
// Sequential by design (production sends one request at a time per service). --min-interval-ms
// spaces request starts (use 1000 for the live service). --gate runs a shell command before the
// first request and every --gate-every requests; a non-zero exit stops the run with exit code 75,
// and so do --max-failures failures in a row (exit 3). Output is appended per request, so a
// stopped run resumes where it stopped: requests already in --out are skipped.
//
// Usage: node run.cjs --requests requests.jsonl --out results.jsonl --target laya|ollaya --url URL
//          [--model NAME] [--label NAME] [--api-key-file FILE] [--min-interval-ms 0] [--timeout-ms 10000]
//          [--warmup 0] [--gate CMD --gate-every 50] [--max-failures 5] [--backoff-ms 3000]

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { toTypeSafe, fromTypeSafe, contractProblem } = require('./adapter.cjs');

const EXIT_PAUSED = 75, EXIT_FAILING = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (r) => `${r.id}\u0000${r.variant}`;

function parseArgs(argv) {
  const a = { minIntervalMs: 0, timeoutMs: 10000, warmup: 0, gateEvery: 50, maxFailures: 5, backoffMs: 3000 };
  const names = { 'min-interval-ms': 'minIntervalMs', 'timeout-ms': 'timeoutMs', 'gate-every': 'gateEvery', 'max-failures': 'maxFailures', 'backoff-ms': 'backoffMs', 'api-key-file': 'apiKeyFile' };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const name = names[k] || k;
    a[name] = ['minIntervalMs', 'timeoutMs', 'warmup', 'gateEvery', 'maxFailures', 'backoffMs'].includes(name) ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!a.requests || !a.out || !a.url || !['laya', 'ollaya'].includes(a.target) || (a.target === 'ollaya' && !a.model)) {
    throw Error('usage: node run.cjs --requests FILE --out FILE --target laya|ollaya --url URL [--model NAME] ...');
  }
  a.url = String(a.url).replace(/\/+$/, '');
  a.label ||= a.target === 'laya' ? 'laya-en (live)' : a.model;
  return a;
}

/**
 * One exchange: { ok, reason, status, selected, scores, raw, latencyMs }. Never throws. `fetchImpl`
 * and `now` are injectable for tests.
 */
async function send(req, opts, { fetchImpl = globalThis.fetch, now = () => performance.now() } = {}) {
  const ollaya = opts.target === 'ollaya';
  const payload = ollaya ? toTypeSafe(req.body, opts.model) : req.body;
  const headers = { 'content-type': 'application/json', ...(ollaya && opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) };
  const started = now();
  let response, text;
  try {
    response = await fetchImpl(`${opts.url}/v1/decisions`, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs) });
    text = await response.text();
  } catch (error) {
    return { ok: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'network', status: null, latencyMs: now() - started };
  }
  const latencyMs = now() - started;
  if (!response.ok) {
    let code = null;
    try { code = JSON.parse(text)?.code ?? null; } catch { /* not JSON */ }
    return { ok: false, reason: `http-${response.status}${typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? `-${code}` : ''}`, status: response.status, latencyMs };
  }
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, reason: 'parse', status: response.status, latencyMs }; }
  let result;
  if (ollaya) {
    try { result = fromTypeSafe(json, req.body, opts.label); } catch (e) { return { ok: false, reason: e.reason || 'adapter', status: response.status, latencyMs, raw: json?.answers?.d?.probabilities ?? null }; }
  } else {
    result = { selected: json?.selected, scores: json?.scores, raw: json?.scores ?? null };
  }
  const problem = contractProblem(req.body, result);
  return { ok: !problem, reason: problem ? `invalid-result-${problem}` : null, status: response.status, selected: result.selected ?? null, scores: result.scores ?? null, raw: result.raw ?? null, latencyMs };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function gateOpen(cmd) {
  if (!cmd) return true;
  try { execFileSync('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60000 }); return true; } catch { return false; }
}

async function run(opts, deps = {}) {
  const requests = readJsonl(opts.requests);
  const done = new Set(readJsonl(opts.out).map(keyOf));
  const todo = requests.filter((r) => !done.has(keyOf(r)));
  const log = deps.log || ((line) => process.stderr.write(line + '\n'));
  log(`[decision-eval] ${opts.label}: ${todo.length} to send, ${done.size} already done`);
  if (!gateOpen(opts.gate)) { log('[decision-eval] idle gate closed before the run; nothing sent'); return EXIT_PAUSED; }
  for (const r of todo.slice(0, opts.warmup)) await send(r, opts, deps); // warm caches; not recorded
  let last = 0, failures = 0, sent = 0;
  const latencies = [];
  for (const r of todo) {
    if (sent && opts.gateEvery > 0 && sent % opts.gateEvery === 0 && !gateOpen(opts.gate)) {
      log(`[decision-eval] idle gate closed after ${sent}; paused (rerun to resume)`);
      return EXIT_PAUSED;
    }
    const wait = last + opts.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const out = await send(r, opts, deps);
    sent += 1;
    fs.appendFileSync(opts.out, JSON.stringify({ id: r.id, purpose: r.purpose, variant: r.variant, lang: r.lang, label: r.label,
      model: opts.label, target: opts.target, ...out, at: new Date().toISOString() }) + '\n');
    if (out.ok) { failures = 0; latencies.push(out.latencyMs); } else {
      failures += 1;
      if (failures >= opts.maxFailures) { log(`[decision-eval] ${failures} failures in a row (last: ${out.reason}); stopped`); return EXIT_FAILING; }
      if (out.status === 503 || out.reason === 'timeout') await sleep(opts.backoffMs);
    }
    if (sent % 50 === 0) {
      const s = latencies.slice().sort((a, b) => a - b);
      log(`[decision-eval] ${opts.label}: ${sent}/${todo.length}, p50 ${Math.round(s[s.length >> 1] || 0)} ms`);
    }
  }
  log(`[decision-eval] ${opts.label}: done, ${sent} sent`);
  return 0;
}

if (require.main === module) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.apiKeyFile) opts.apiKey = fs.readFileSync(opts.apiKeyFile, 'utf8').trim();
    process.exit(await run(opts));
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { send, run, parseArgs, readJsonl, EXIT_PAUSED, EXIT_FAILING };
