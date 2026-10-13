'use strict';
// #1639: turns the synthetic cases into the exact bodies production POSTs to
// {COWORK_DECISION_URL}/v1/decisions. It does not rebuild them: it drives the real callers
// (system-one-router, routing-modes sensitivity, tool-gate, step-supervision, chat-framing,
// load-advisor) through decision-settings' backend with a fetch that records the body and answers
// with a fixed valid decision. So a wording, option or state change in core is picked up here.
//
// The decision layer's request/result checks live in dav-parse.wasm, which a plain checkout does
// not have; they validate, they do not shape the body. For capturing only, they are replaced by
// permissive ones (permissiveDecisionChecks), in this process only.
//
// Usage: node build-requests.cjs --out requests.jsonl [--cases dir] [--smoke 20 --smoke-out smoke.jsonl]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const SERVER = path.join(__dirname, '..', '..', 'server');
const CASES = path.join(__dirname, 'cases');
const CAPTURE_URL = 'http://127.0.0.1:9';
const LANGS = Object.freeze(['en', 'de', 'fr', 'es', 'it', 'nb', 'nl', 'pt', 'sv']);
const LABELS = Object.freeze({
  'model.route': ['fast', 'smart', 'code'],
  'step.supervise': ['continue', 'verify', 'escalate'],
  'tool.gate': null, // the offered read tools plus "none", from cases/tool-gate.json
  'routing.sensitivity': ['sensitive', 'not_sensitive'],
  'chat.frame.kind': ['search', 'action', 'idea', 'question', 'code'],
  'load.advisor': ['oom', 'load_failed', 'recall_failed', 'template', 'unknown'],
});
// A short, fixed, synthetic stand-in for the system prompt: production's sensitivity input carries a
// "Context" section (chat.cjs routerSystem), which takes part of the 1,000-character chunk.
const SENSITIVITY_SYSTEM = 'You are noevia, a helpful assistant running on a self-hosted server. Answer clearly and briefly. Use the tools you are offered when they help. Ask before doing anything that changes data.';
const PERMUTED_ITEMS = 100;

function permissiveDecisionChecks() {
  const file = require.resolve(path.join(SERVER, 'dav-parse-wasm.cjs'));
  const stub = new Module(file);
  stub.filename = file;
  stub.loaded = true;
  stub.exports = { decisionInvalidRequest: () => null, decisionInvalidResult: () => null, decisionCauseOf: () => 'exception' };
  require.cache[file] = stub;
}

/** A fetch that records each decision request body and answers with the first option at 0.6. */
function createCapture() {
  const seen = [];
  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), body });
    const ids = body.options.map((o) => o.id);
    const scores = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0.6 : 0.4 / (ids.length - 1)]));
    return new Response(JSON.stringify({ selected: ids[0], scores, model: 'capture', calibrated: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return { fetchImpl, take: () => seen.splice(0) };
}

/** The production callers wired to one capturing decision backend. */
function createCallers() {
  permissiveDecisionChecks();
  const capture = createCapture();
  const { createDecisionSettings } = require(path.join(SERVER, 'decision-settings.cjs'));
  const { createDecisions } = require(path.join(SERVER, 'decision', 'index.cjs'));
  const { createDecisionEndpoint } = require(path.join(SERVER, 'decision-endpoint.cjs'));
  const store = { get: () => JSON.stringify({ url: CAPTURE_URL, timeoutMs: 2000 }), set() {} };
  const settings = createDecisionSettings({ store, env: {}, fetchImpl: capture.fetchImpl });
  const backend = settings.backend();
  if (!backend) throw Error('capture backend not configured');
  const layer = (purposes) => createDecisions({ backends: { configured: backend }, chains: Object.fromEntries(purposes.map((p) => [p, ['configured']])) });

  const routers = {};
  const router = (code) => (routers[code] ||= require(path.join(SERVER, 'system-one-router.cjs')).createSystemOneRouter({
    enabled: () => true, env: {}, log: () => {}, fallback: async () => 'smart',
    roles: () => ({ fast: 'fast-model', smart: 'smart-model', ...(code ? { code: 'code-model' } : {}) }),
    getBackend: () => backend, getDeadlineMs: () => 2000,
  }));

  const rm = require(path.join(SERVER, 'routing-modes.cjs'));
  const sensitivityLayer = layer(['routing.sensitivity']);
  const sensitivity = rm.createSensitivity({ decide: (r) => sensitivityLayer.decide(r), deadlineMs: () => rm.SENSITIVITY_DEADLINE_MS, log: () => {} });

  const gateLayer = layer(['tool.gate']);
  const framingLayer = layer(['chat.frame.kind', 'chat.frame.project', 'chat.frame.tag']);
  const framing = require(path.join(SERVER, 'chat-framing.cjs')).createChatFraming({
    enabled: () => true, decide: (r) => framingLayer.decide(r), deadlineMs: () => 2000, log: () => {},
  });
  const supervision = require(path.join(SERVER, 'step-supervision.cjs')).createStepSupervision({
    enabled: () => true, provider: { decide: (...a) => backend.supervise(...a) }, deadlineMs: 1500, getDeadlineMs: () => 2000, log: () => {},
  });
  const endpoint = createDecisionEndpoint({ env: { COWORK_DECISION_URL: CAPTURE_URL }, fetchImpl: capture.fetchImpl });
  const advisor = require(path.join(SERVER, 'load-advisor.cjs')).createLoadAdvisor({
    endpoint, log: () => {},
    // No rule matched and there is engine text: the only path on which the advisor asks the service.
    verdict: (req) => ({ ask: !req.advice, outcome: 'load', reason: 'eval', source: 'rule', rule: null, ruleId: null, advice: req.advice || null, adviceUsed: false }),
  });

  const one = async (run) => {
    capture.take();
    const outcome = await run();
    const sent = capture.take();
    return { sent, outcome };
  };

  return {
    backend,
    route: (message, { code = true } = {}) => one(() => router(code).classifyWithDetails(message)),
    sensitivity: (message) => one(() => sensitivity(rm.routerChunks({ message, system: SENSITIVITY_SYSTEM, history: [], attachments: [] },
      { chunkChars: rm.chunkCharsFor(backend), maxChunks: 1 }))),
    preRule: (message) => rm.preRule(message),
    toolGate: (message, tools, writeTools) => {
      const gate = require(path.join(SERVER, 'tool-gate.cjs')).createToolGate({
        enabled: () => true, isWriteTool: (n) => writeTools.has(n), deadlineMs: () => 2000, env: {}, warn: () => {},
        limits: () => backend.limits, unavailable: () => null, decide: (r) => gateLayer.decide(r), log: () => {},
      });
      return one(() => gate.evaluate(message, tools));
    },
    supervise: (goal, outputs) => one(() => supervision.decide({ round: 0, goal, messages: [{ role: 'user', content: goal }, ...outputs] })),
    frameKind: (message) => one(() => framing.suggest({ message, projects: [], chats: [] })),
    loadAdvisor: (text) => one(() => advisor.judge({ cause: 'load', evidence: { status: 500, exitCode: 1, text, crash: false } })),
  };
}

const readCases = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Every case file as flat rows { id, purpose, lang, label, input }; throws on a malformed case. */
function loadCases(dir = CASES) {
  const rows = [];
  const add = (purpose, file, perLang, toInput) => {
    for (const [lang, list] of Object.entries(perLang)) {
      if (!LANGS.includes(lang)) throw Error(`${file}: unknown language ${lang}`);
      list.forEach((entry, i) => rows.push({ id: `${file.replace(/\.json$/, '')}-${lang}-${String(i + 1).padStart(3, '0')}`, purpose, lang, label: entry[0], input: toInput(entry) }));
    }
  };
  add('model.route', 'route.json', readCases(dir, 'route.json'), ([, message]) => ({ message }));
  add('step.supervise', 'supervision.json', readCases(dir, 'supervision.json'), ([, goal, outputs]) => ({ goal, outputs: outputs.map(([role, content]) => ({ role, content })) }));
  const gate = readCases(dir, 'tool-gate.json');
  add('tool.gate', 'tool-gate.json', gate.cases, ([, message]) => ({ message }));
  add('routing.sensitivity', 'sensitivity.json', readCases(dir, 'sensitivity.json'), ([, message]) => ({ message }));
  add('chat.frame.kind', 'frame-kind.json', readCases(dir, 'frame-kind.json'), ([, message]) => ({ message }));
  add('load.advisor', 'load-advisor.json', readCases(dir, 'load-advisor.json'), ([, text]) => ({ text }));
  const gateLabels = [...gate.tools.filter((t) => !t.write).map((t) => t.function.name), 'none'];
  for (const r of rows) {
    const allowed = LABELS[r.purpose] || gateLabels;
    if (!allowed.includes(r.label)) throw Error(`${r.id}: label ${JSON.stringify(r.label)} is not one of ${allowed.join(', ')}`);
  }
  return { rows, gate };
}

const rotate = (list, k) => list.slice(k).concat(list.slice(0, k));

/** Builds every request record: { id, purpose, variant, lang, label, body }, plus what was skipped and why. */
async function buildRequests(dir = CASES) {
  const { rows, gate } = loadCases(dir);
  const callers = createCallers();
  const tools = gate.tools.map(({ write, ...t }) => t);
  const writeTools = new Set(gate.tools.filter((t) => t.write).map((t) => t.function.name));
  const records = [], skipped = [];
  const push = (row, variant, sent) => {
    if (sent.length !== 1) { skipped.push({ id: row.id, variant, reason: sent.length ? 'more-than-one-request' : 'no-request' }); return; }
    if (!sent[0].url.endsWith('/v1/decisions')) throw Error(`${row.id}: unexpected URL ${sent[0].url}`);
    records.push({ id: row.id, purpose: row.purpose, variant, lang: row.lang, label: row.label, body: sent[0].body });
  };
  for (const row of rows) {
    if (row.purpose === 'model.route') {
      push(row, 'base', (await callers.route(row.input.message, { code: true })).sent);
      if (row.lang === 'en' && row.label !== 'code') push(row, 'nocode', (await callers.route(row.input.message, { code: false })).sent);
    } else if (row.purpose === 'routing.sensitivity') {
      if (callers.preRule(row.input.message)) { skipped.push({ id: row.id, variant: 'base', reason: 'pre-rule' }); continue; }
      push(row, 'base', (await callers.sensitivity(row.input.message)).sent);
    } else if (row.purpose === 'tool.gate') {
      const { sent, outcome } = await callers.toolGate(row.input.message, tools, writeTools);
      if (!sent.length && outcome?.source === 'rule') { skipped.push({ id: row.id, variant: 'base', reason: `rule-${outcome.decision?.tool || 'none'}` }); continue; }
      push(row, 'base', sent);
    } else if (row.purpose === 'step.supervise') {
      push(row, 'base', (await callers.supervise(row.input.goal, row.input.outputs)).sent);
    } else if (row.purpose === 'chat.frame.kind') {
      push(row, 'base', (await callers.frameKind(row.input.message)).sent);
    } else if (row.purpose === 'load.advisor') {
      push(row, 'base', (await callers.loadAdvisor(row.input.text)).sent);
    }
  }
  // Order flips: the same request with its options rotated by one and by two, on PERMUTED_ITEMS
  // English requests with three or more options, picked by a hash of the id (stable, not by file order).
  const pool = records.filter((r) => r.variant === 'base' && r.lang === 'en' && r.body.options.length >= 3)
    .sort((a, b) => hash(a.id).localeCompare(hash(b.id))).slice(0, PERMUTED_ITEMS);
  for (const r of pool) for (const k of [1, 2]) records.push({ ...r, variant: `perm${k}`, body: { ...r.body, options: rotate(r.body.options, k) } });
  return { records, skipped };
}

/** A small stratified smoke subset: round-robin over purposes, then languages, by hash order. */
function smokeSubset(records, n) {
  const byPurpose = new Map();
  for (const r of records.filter((x) => x.variant === 'base').sort((a, b) => hash(a.id).localeCompare(hash(b.id)))) {
    if (!byPurpose.has(r.purpose)) byPurpose.set(r.purpose, []);
    byPurpose.get(r.purpose).push(r);
  }
  const queues = [...byPurpose.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, list]) => {
    // Interleave languages so the first picks of each purpose differ in language.
    const byLang = new Map();
    for (const r of list) { if (!byLang.has(r.lang)) byLang.set(r.lang, []); byLang.get(r.lang).push(r); }
    const lanes = [...byLang.values()], out = [];
    for (let i = 0; out.length < list.length; i++) for (const lane of lanes) if (lane[i]) out.push(lane[i]);
    return out;
  });
  const picked = [];
  for (let i = 0; picked.length < n && queues.some((q) => q[i]); i++) for (const q of queues) if (q[i] && picked.length < n) picked.push(q[i]);
  return picked;
}

const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!args.out) throw Error('usage: node build-requests.cjs --out requests.jsonl [--cases dir] [--smoke N --smoke-out smoke.jsonl]');
  const { records, skipped } = await buildRequests(args.cases || CASES);
  fs.writeFileSync(args.out, toJsonl(records));
  if (args.smoke) fs.writeFileSync(args['smoke-out'], toJsonl(smokeSubset(records, Number(args.smoke))));
  const counts = {};
  for (const r of records) counts[`${r.purpose}/${r.variant}`] = (counts[`${r.purpose}/${r.variant}`] || 0) + 1;
  console.log(JSON.stringify({ requests: records.length, counts, skipped }, null, 1));
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { buildRequests, loadCases, smokeSubset, createCallers, rotate, LANGS, LABELS, SENSITIVITY_SYSTEM, PERMUTED_ITEMS };
