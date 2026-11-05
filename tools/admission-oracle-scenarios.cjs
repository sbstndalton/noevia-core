'use strict';
// Port contract row H: the synthetic admission schedules behind tests/fixtures/inference-admission-node.v1.json.
// Each scenario names synthetic holds (no engine, no model, no account data) and a schedule of front calls. The same
// schedules are driven against Core's pre-port lease route (tools/gen-admission-oracle.cjs, recorded once at base
// 3521cdc2) and against the latch the front's authority now drives (server/inference-admission-oracle.test.cjs), and
// the Rust client replays the recorded answers (noevia-rs crates/engine-admission/tests/node_oracle.rs).

/** The synthetic holds of `spec`, logging every enter, hold and give-back into `log`. */
function holds(spec, log) {
  const gates = [];
  const modelManager = {};
  if (spec.maintenance !== 'absent') {
    modelManager.enterInference = () => {
      if (spec.maintenance && spec.maintenance.status) throw Object.assign(Error(spec.maintenance.message), { status: spec.maintenance.status });
      log.push('enter');
      return () => log.push('leave');
    };
    modelManager.enterInferenceWithin = async (waitMs, signal) => {
      if (spec.maintenance && spec.maintenance.status) throw Object.assign(Error(spec.maintenance.message), { status: spec.maintenance.status, ...(spec.maintenance.code ? { code: spec.maintenance.code } : {}) });
      log.push(`enter-within ${waitMs}`);
      if (spec.exchangeWait) await new Promise((resolve) => gates.push(resolve));
      signal?.throwIfAborted();
      return () => log.push('leave');
    };
  }
  if (spec.gate) {
    modelManager.acquireLease = async (model, o) => {
      log.push(`gate ${model} ${o.maxWaitMs}`);
      if (spec.gate.wait) await new Promise((resolve) => gates.push(resolve));
      if (spec.gate.refuse) throw Object.assign(Error('gate words'), spec.gate.refuse);
      return { headers: () => (spec.gate.header ? { 'x-noevia-lease': spec.gate.header } : null), release: async () => log.push('gate-release') };
    };
  }
  const admitEngineModel = async (model) => {
    log.push(`budget ${model}`);
    if (spec.budget) throw Object.assign(Error('over'), spec.budget);
  };
  const chatMachines = spec.machine ? {
    target: () => (spec.machine.moved ? { machine: { id: 'other' }, model: 'm' } : { machine: { id: 'm1' }, model: 'm' }),
    ready: async () => {
      log.push('ready');
      if (spec.machine.wait) await new Promise((resolve) => gates.push(resolve));
      return spec.machine.unready || { ok: true };
    },
    beginTurn: () => { log.push('turn'); return () => log.push('turn-end'); },
  } : null;
  const diaryExchange = spec.diary ? {
    rateLimited: (user) => { log.push(`throttle ${user}`); return spec.diary.limited === true; },
    foreground: () => { log.push('pause'); return () => log.push('resume'); },
  } : null;
  return { options: { modelManager, admitEngineModel, chatMachines, diaryExchange }, open: () => { for (const g of gates.splice(0)) g(); } };
}

const BUSY_MAINT = { status: 409, message: 'internal words' };
const TUNING = { status: 503, message: 'A model is being tuned.' };

/** Steps: ['acquire', body] | ['acquire-abort', body] (the caller leaves while waiting, then the hold is granted)
 *  | ['renew', n] | ['release', n] (n: which granted lease) | ['wait', ms]. */
const SCENARIOS = [
  { name: 'engine-gate-grant-renew-release', spec: { gate: { header: 'abc123' } }, steps: [['acquire', { model: 'm' }], ['renew', 0], ['release', 0], ['renew', 0], ['release', 0]] },
  { name: 'engine-gate-not-renewed-expires', spec: { gate: { header: 'abc123' } }, steps: [['acquire', { model: 'm' }], ['wait', 250], ['renew', 0]] },
  { name: 'engine-no-gate-budget-ok', spec: {}, steps: [['acquire', { model: 'm' }], ['release', 0]] },
  { name: 'engine-no-gate-over-budget', spec: { budget: { status: 409, publicMessage: 'Over the inference budget.', code: 'overBudget' } }, steps: [['acquire', { model: 'big' }]] },
  { name: 'engine-gate-refusal-kept', spec: { gate: { refuse: { status: 409, publicMessage: 'The engine is switching models.', code: 'engine_busy' } } }, steps: [['acquire', { model: 'm' }]] },
  { name: 'engine-gate-500-is-busy', spec: { gate: { refuse: { status: 500 } } }, steps: [['acquire', { model: 'm' }]] },
  { name: 'engine-maintenance-tuning-503', spec: { maintenance: TUNING, gate: {} }, steps: [['acquire', { model: 'm' }]] },
  { name: 'engine-maintenance-other-busy', spec: { maintenance: BUSY_MAINT, gate: {} }, steps: [['acquire', { model: 'm' }]] },
  { name: 'engine-caller-leaves-while-queued', spec: { gate: { wait: true } }, steps: [['acquire-abort', { model: 'm' }]] },
  { name: 'ask-without-model', spec: {}, steps: [['acquire', {}], ['acquire', { model: '' }], ['acquire', { model: 'x'.repeat(1025) }]] },
  { name: 'embedding-grant', spec: { gate: {} }, steps: [['acquire', { model: 'e', embedding: true }], ['release', 0], ['release', 0]] },
  { name: 'embedding-invalid', spec: {}, steps: [['acquire', { model: 'e', embedding: false }], ['acquire', { model: 'e', embedding: true, role: 'smart' }]] },
  { name: 'machine-turn', spec: { machine: {} }, steps: [['acquire', { role: 'smart', machine: 'm1', model: 'm' }], ['release', 0]] },
  { name: 'machine-moved', spec: { machine: { moved: true } }, steps: [['acquire', { role: 'smart', machine: 'm1', model: 'm' }]] },
  { name: 'machine-offline', spec: { machine: { unready: { ok: false, error: 'The machine is not answering.', code: 'machineUnreachable' } } }, steps: [['acquire', { role: 'smart', machine: 'm1', model: 'm' }]] },
  { name: 'machine-wrong-role', spec: { machine: {} }, steps: [['acquire', { role: 'fast', machine: 'm1', model: 'm' }], ['acquire', { role: 'smart', model: 'm' }]] },
  { name: 'machine-caller-leaves', spec: { machine: { wait: true } }, steps: [['acquire-abort', { role: 'smart', machine: 'm1', model: 'm' }]] },
  { name: 'diary-grant', spec: { diary: {} }, steps: [['acquire', { diaryExchange: { user: 'u-synthetic' } }], ['renew', 0], ['release', 0]] },
  { name: 'diary-throttled', spec: { diary: { limited: true } }, steps: [['acquire', { diaryExchange: { user: 'u-synthetic' } }]] },
  { name: 'diary-maintenance', spec: { diary: {}, maintenance: { status: 503, message: 'Model configuration is being applied. Try again shortly.', code: 'inferenceMaintenance' } }, steps: [['acquire', { diaryExchange: { user: 'u1' } }]] },
  { name: 'diary-bad-asks', spec: { diary: {} }, steps: [['acquire', { diaryExchange: {} }], ['acquire', { diaryExchange: { user: 7 } }], ['acquire', { diaryExchange: { user: 'u1' }, model: 'm' }], ['acquire', { diaryExchange: null }]] },
  { name: 'diary-not-wired', spec: {}, steps: [['acquire', { diaryExchange: { user: 'u1' } }]] },
  { name: 'diary-caller-leaves', spec: { diary: {}, exchangeWait: true }, steps: [['acquire-abort', { diaryExchange: { user: 'u1' } }]] },
  { name: 'concurrent-chat-worker-diary', spec: { gate: { header: 'abc123' }, diary: {} }, steps: [['acquire', { model: 'm' }], ['acquire', { model: 'e', embedding: true }], ['acquire', { diaryExchange: { user: 'u1' } }], ['release', 1], ['release', 0], ['release', 2]] },
];

const TTL_MS = 80;

/** Drives one scenario through `client` ({acquire(body, signal), renew(lease), release(lease)} → {status, body}). */
async function drive(scenario, client, open) {
  const out = [];
  const leases = [];
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  for (const [op, arg] of scenario.steps) {
    if (op === 'acquire') {
      const r = await client.acquire(arg);
      if (r.status === 201 && r.body?.lease) leases.push(r.body.lease);
      out.push({ op, status: r.status, body: normal(r.body) });
    } else if (op === 'acquire-abort') {
      const controller = new AbortController();
      const pending = client.acquire(arg, controller.signal).then(() => 'answered', () => 'gone');
      await settle();
      controller.abort();
      const how = await pending;
      await settle();
      open();
      await settle();
      out.push({ op, outcome: how });
    } else if (op === 'renew' || op === 'release') {
      const r = await client[op](leases[arg]);
      out.push({ op, status: r.status });
    } else if (op === 'wait') {
      await settle(arg);
      out.push({ op });
    }
  }
  return out;
}

function normal(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = { ...body };
  if (typeof copy.lease === 'string') copy.lease = /^[0-9a-f]{32}$/.test(copy.lease) ? '<lease>' : copy.lease;
  return copy;
}

module.exports = { holds, SCENARIOS, TTL_MS, drive };
