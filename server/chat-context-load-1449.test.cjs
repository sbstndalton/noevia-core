'use strict';
// #1449: the 'Loading the selected model' status names the model and role, and gives an expected
// wait only from a load measured in this process. Fakes only: no model manager, no inference.
const test = require('node:test'), assert = require('node:assert/strict');
const context = require('./chat-context.cjs');

// A manager whose model starts unloaded; load() takes `loadMs` on a fake clock and then serves it.
function fakeManager({ loadMs = 0, loadOk = true, clock }) {
  const state = { loaded: false, loads: 0, model: null };
  return {
    state,
    manager: {
      enabled: true,
      health: async () => ({ ok: true, body: { all_models_loaded: state.loaded ? [{ model_name: state.model, loaded: true, backend_alive: true, recipe_options: { ctx_size: 8192 } }] : [] } }),
      load: async (model) => {
        state.loads += 1;
        state.model = model;
        clock.now += loadMs;
        if (loadOk) state.loaded = true;
        return { ok: loadOk };
      },
    },
  };
}

function withClock(fn) {
  const clock = { now: 1_000_000 };
  const real = Date.now;
  Date.now = () => clock.now;
  return Promise.resolve().then(() => fn(clock)).finally(() => { Date.now = real; });
}

test('the first load of a model names the model and role, with no number when no load was measured', () => withClock(async (clock) => {
  const { manager, state } = fakeManager({ loadMs: 4000, clock });
  const statuses = [];
  await context.resolveRuntimeLimit({ manager, model: 'fast-model-a', role: 'fast', onStatus: (text, id, detail) => statuses.push({ text, id, detail }) });
  assert.equal(state.loads, 1);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].id, 'loadingModel', 'the catalogue id stays for localised wording');
  assert.match(statuses[0].text, /fast-model-a for the fast role/);
  assert.doesNotMatch(statuses[0].text, /Expected wait/);
  assert.deepEqual(statuses[0].detail, { model: 'fast-model-a', role: 'fast' });
}));

test('after a measured load, the next load of the same model states the expected wait from the median', () => withClock(async (clock) => {
  const { manager, state } = fakeManager({ loadMs: 4000, clock });
  const statuses = [];
  const onStatus = (text, id, detail) => statuses.push({ text, id, detail });
  await context.resolveRuntimeLimit({ manager, model: 'code-model', role: 'code', onStatus });
  state.loaded = false; // the swap: another role's model took the GPU
  await context.resolveRuntimeLimit({ manager, model: 'code-model', role: 'code', onStatus });
  assert.equal(state.loads, 2);
  assert.match(statuses[1].text, /code-model for the code role .*Expected wait about 4 s\./);
  assert.equal(statuses[1].detail.expectedSeconds, 4);
}));

test('the expected wait is the median of the recent loads, at least 1 second, and only models that were measured', () => {
  assert.equal(context.expectedLoadSeconds('never-loaded-here'), null);
  context.recordLoad('median-model', 9000);
  context.recordLoad('median-model', 1000);
  context.recordLoad('median-model', 5000);
  assert.equal(context.expectedLoadSeconds('median-model'), 5, 'median of 1s, 5s, 9s');
  context.recordLoad('quick-model', 40);
  assert.equal(context.expectedLoadSeconds('quick-model'), 1, 'a sub-second load still states one second');
  for (let i = 0; i < 9; i += 1) context.recordLoad('window-model', 60_000);
  context.recordLoad('window-model', 2000);
  assert.equal(context.expectedLoadSeconds('window-model'), 60, 'only the last five loads count');
  context.recordLoad('bad-model', Number.NaN);
  context.recordLoad('bad-model', -5);
  assert.equal(context.expectedLoadSeconds('bad-model'), null, 'non-numeric and negative durations are not recorded');
});

test('a failed load records nothing, so the next status states no number', () => withClock(async (clock) => {
  const { manager, state } = fakeManager({ loadMs: 3000, loadOk: false, clock });
  await assert.rejects(context.resolveRuntimeLimit({ manager, model: 'flaky-model', role: 'smart', onStatus: () => {} }), /could not load/);
  assert.equal(context.expectedLoadSeconds('flaky-model'), null);
  assert.equal(state.loads, 1);
}));

test('no status at all when the model is already loaded', () => withClock(async (clock) => {
  const { manager, state } = fakeManager({ loadMs: 1000, clock });
  state.loaded = true;
  state.model = 'fast-model';
  const statuses = [];
  await context.resolveRuntimeLimit({ manager, model: 'fast-model', role: 'fast', onStatus: (text) => statuses.push(text) });
  assert.equal(state.loads, 0);
  assert.deepEqual(statuses, []);
}));

test('a manual chat with no routed role names the model only', () => {
  assert.equal(context.loadingStatus('manual-model', null, null), 'Loading the selected model manual-model and checking its context allocation…');
  assert.equal(context.loadingStatus('manual-model', 'smart', 12), 'Loading the selected model manual-model for the smart role and checking its context allocation… Expected wait about 12 s.');
});
