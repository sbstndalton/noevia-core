'use strict';
// #1639: per-purpose decision routing. Kev-0.8B serves route, tool gate, supervision, framing and the
// load advisor; the sensitivity check stays on Laya-en (#1647: Kev is not qualified) through
// COWORK_SENSITIVITY_DECISION_URL. Unset, everything is as before #1639. Synthetic requests only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDecisionSettings } = require('./decision-settings.cjs');

const KEV = 'http://kev:11435';
const LAYA = 'http://laya:8040';
const memory = (saved) => { const m = new Map(saved ? [['decision:configuration', JSON.stringify(saved)]] : []); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
function recorder() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers, redirect: init.redirect });
    if (body.questions) return Response.json({ answers: { d: { probabilities: { sensitive: 0.3, not_sensitive: 0.7 } } } });
    return Response.json({ selected: 'not_sensitive', scores: { sensitive: 0.3, not_sensitive: 0.7 }, model: 'convaiinnovations/laya' });
  };
  return { calls, fetchImpl };
}
const request = (purpose) => ({ kind: 'choice', purpose, question: 'Synthetic question?', context: { stateText: 'synthetic text' },
  options: [{ id: 'sensitive', label: 'Sensitive' }, { id: 'not_sensitive', label: 'Not sensitive' }] });

test('override unset: sensitivity uses the shared backend, exactly as before #1639', async () => {
  for (const extra of [{}, { COWORK_SENSITIVITY_DECISION_URL: '' }, { COWORK_SENSITIVITY_DECISION_URL: '  ' }]) {
    const { calls, fetchImpl } = recorder();
    const settings = createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: LAYA, ...extra }, fetchImpl });
    assert.equal(settings.sensitivityBackend(), settings.backend());
    assert.equal(settings.backend().wording, 'standard');
    await settings.sensitivityBackend().decide(request('routing.sensitivity'));
    assert.deepEqual(calls.map((c) => c.url), [`${LAYA}/v1/decisions`]);
    assert.deepEqual(Object.keys(calls[0].body), ['state', 'question', 'options']);
  }
});

test('override set: sensitivity requests go only to that URL, on Laya wording and contract; the rest go to Kev', async () => {
  const { calls, fetchImpl } = recorder();
  const settings = createDecisionSettings({ store: memory(), fetchImpl, env: { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b',
    COWORK_DECISION_API_KEY: 'synthetic-key', COWORK_SENSITIVITY_DECISION_URL: LAYA } });
  const shared = settings.backend(), sensitivity = settings.sensitivityBackend();
  assert.notEqual(shared, sensitivity);
  assert.deepEqual([shared.model, shared.wording, sensitivity.model, sensitivity.wording], ['kev-0.8b', 'compact', 'laya', 'standard']);
  await sensitivity.decide(request('routing.sensitivity'));
  await shared.decide(request('tool.gate'));
  await shared.supervise({ goal: 'synthetic', outputs: [{ role: 'tool', content: 'r' }] }).catch(() => {}); // options differ from the stub: refused, still sent
  assert.equal(calls[0].url, `${LAYA}/v1/decisions`);
  assert.deepEqual(Object.keys(calls[0].body), ['state', 'question', 'options']);
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json' }, 'the Kev key never goes to Laya');
  assert.ok(calls.slice(1).every((c) => c.url === `${KEV}/v1/decisions` && c.body.model === 'ollaya.dev/library/kev:0.8b'));
  assert.equal(calls[2].body.questions.d.instructions, 'What should the assistant do next with these tool results?');
  assert.equal(calls.filter((c) => c.url.startsWith(LAYA)).length, 1, 'only the sensitivity request reached Laya');
  assert.ok(calls.every((c) => c.redirect === 'error'));
});

test('per-model T: Kev scores are tempered at 0.45, Laya scores are not', async () => {
  const { fetchImpl } = recorder();
  const settings = createDecisionSettings({ store: memory(), fetchImpl, env: { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_SENSITIVITY_DECISION_URL: LAYA } });
  const kev = await settings.backend().decide(request('tool.gate'));
  const laya = await settings.sensitivityBackend().decide(request('routing.sensitivity'));
  const a = 0.3 ** (1 / 0.45), b = 0.7 ** (1 / 0.45);
  assert.ok(Math.abs(kev.scores.not_sensitive - b / (a + b)) < 1e-12);
  assert.deepEqual(laya.scores, { sensitive: 0.3, not_sensitive: 0.7 });
  assert.equal(laya.metadata.model, 'convaiinnovations/laya');
});

test('a set override that is not a private decision-service URL disables sensitivity; it never falls back to the shared service', () => {
  // #1755: a name (https://cloud.example.com) is judged at connect time (service-endpoint-1755.test.cjs).
  for (const url of ['http://8.8.8.8:8040', 'http://203.0.113.7:8040', 'http://laya:8040/path', 'http://user:pw@laya:8040', 'garbage']) {
    const settings = createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_SENSITIVITY_DECISION_URL: url } });
    assert.ok(settings.backend(), url);
    assert.equal(settings.sensitivityBackend(), null, url);
  }
});

test('the sensitivity model defaults to Laya even when the shared one is Kev; it can be named explicitly', () => {
  const env = { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_SENSITIVITY_DECISION_URL: LAYA };
  assert.equal(createDecisionSettings({ store: memory(), env }).sensitivityBackend().wording, 'standard');
  assert.equal(createDecisionSettings({ store: memory(), env: { ...env, COWORK_SENSITIVITY_DECISION_MODEL: 'laya' } }).sensitivityBackend().model, 'laya');
});

test('the model belongs to COWORK_DECISION_URL: an admin-saved other URL gets the Laya profile', () => {
  const env = { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b' };
  assert.equal(createDecisionSettings({ store: memory(), env }).backend().wording, 'compact');
  assert.equal(createDecisionSettings({ store: memory({ url: KEV, timeoutMs: 1500 }), env }).backend().wording, 'compact', 'saved, same URL');
  assert.equal(createDecisionSettings({ store: memory({ url: LAYA, timeoutMs: 1500 }), env }).backend().wording, 'standard', 'saved, Laya URL');
  assert.equal(createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: LAYA, COWORK_DECISION_MODEL: 'something-new' } }).backend().wording, 'standard', 'unknown model');
});

test('the backend object is stable between calls, so the callers keep their decision layers', () => {
  const settings = createDecisionSettings({ store: memory(), env: { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_SENSITIVITY_DECISION_URL: LAYA } });
  assert.equal(settings.backend(), settings.backend());
  assert.equal(settings.sensitivityBackend(), settings.sensitivityBackend());
});

// #1745: the shared COWORK_DECISION_API_KEY belongs to COWORK_DECISION_URL's host. A sensitivity service on another
// host gets COWORK_SENSITIVITY_DECISION_API_KEY, or no key at all.
const SYNTHETIC_KEY = 'synthetic-shared-key';
const SYNTHETIC_SENS_KEY = 'synthetic-sensitivity-key';
async function sensitivityAuth(env) {
  const { calls, fetchImpl } = recorder();
  await createDecisionSettings({ store: memory(), env, fetchImpl }).sensitivityBackend().decide(request('routing.sensitivity'));
  assert.equal(calls.length, 1);
  return { url: calls[0].url, auth: calls[0].headers.Authorization };
}
const kevBoth = { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_DECISION_API_KEY: SYNTHETIC_KEY, COWORK_SENSITIVITY_DECISION_MODEL: 'kev-0.8b' };

test('a sensitivity service on another host never receives the shared decision key (#1745)', async () => {
  const other = await sensitivityAuth({ ...kevBoth, COWORK_SENSITIVITY_DECISION_URL: 'http://192.168.1.30:11435' });
  assert.equal(other.url, 'http://192.168.1.30:11435/v1/decisions');
  assert.equal(other.auth, undefined, 'no key for another host');
  const own = await sensitivityAuth({ ...kevBoth, COWORK_SENSITIVITY_DECISION_URL: 'http://192.168.1.30:11435', COWORK_SENSITIVITY_DECISION_API_KEY: SYNTHETIC_SENS_KEY });
  assert.equal(own.auth, `Bearer ${SYNTHETIC_SENS_KEY}`, 'its own key when set');
  const sameHost = await sensitivityAuth({ ...kevBoth, COWORK_SENSITIVITY_DECISION_URL: 'http://kev:11436' });
  assert.equal(sameHost.auth, `Bearer ${SYNTHETIC_KEY}`, 'the same host keeps the shared key');
  const shared = createDecisionSettings({ store: memory(), env: { ...kevBoth, COWORK_SENSITIVITY_DECISION_URL: 'http://192.168.1.30:11435' } });
  const { calls, fetchImpl } = recorder();
  await createDecisionSettings({ store: memory(), env: { ...kevBoth, COWORK_SENSITIVITY_DECISION_URL: 'http://192.168.1.30:11435' }, fetchImpl }).backend().decide(request('routing.route'));
  assert.equal(calls[0].headers.Authorization, `Bearer ${SYNTHETIC_KEY}`, 'the shared backend still sends the shared key');
  assert.notEqual(shared.backend(), shared.sensitivityBackend());
});

test('startup warns when COWORK_DECISION_URL is the kev host but the model is not Kev (#1745)', () => {
  const { startupWarnings } = require('./decision-settings.cjs');
  assert.equal(startupWarnings({ COWORK_DECISION_URL: KEV }).length, 1, 'model unset');
  assert.match(startupWarnings({ COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'laya' })[0], /not a Kev model/);
  assert.deepEqual(startupWarnings({ COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b' }), []);
  assert.deepEqual(startupWarnings({ COWORK_DECISION_URL: LAYA }), []);
  assert.deepEqual(startupWarnings({}), []);
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.cjs'), 'utf8'), /startupWarnings\(process\.env\)/, 'index.cjs logs them at startup');
});

test('a Settings-saved URL other than the deployment URL gets Laya wording while the deployment model is Kev (#1745)', async () => {
  const env = { COWORK_DECISION_URL: KEV, COWORK_DECISION_MODEL: 'kev-0.8b', COWORK_DECISION_API_KEY: SYNTHETIC_KEY };
  for (const savedUrl of [LAYA, 'http://kev:11436', 'http://192.168.1.20:8040']) {
    const { calls, fetchImpl } = recorder();
    const settings = createDecisionSettings({ store: memory({ url: savedUrl, timeoutMs: 1500 }), env, fetchImpl });
    assert.equal(settings.get().source, 'admin');
    assert.equal(settings.backend().wording, 'standard', savedUrl);
    assert.equal(settings.backend().model, 'laya', savedUrl);
    await settings.backend().decide(request('routing.route'));
    assert.deepEqual(Object.keys(calls[0].body), ['state', 'question', 'options'], 'the Laya contract');
  }
});
