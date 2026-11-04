'use strict';
// noevia-rs model_maint/reload.rs: the front holds the preset reload baseline and Node reaches it
// over the internal store listener (createBridgeReloadGuard). Synthetic presets and a fake front only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReloadGuard, createBridgeReloadGuard, engineView, BRIDGE_TIMEOUT_MS } = require('./preset-reload.cjs');
const { createFakePresetBaseline } = require('./preset-baseline-fixture.cjs');
const { createLlamaCppManager } = require('./llamacpp-manager.cjs');
const { createClient } = require('./project-store-client.cjs');

const BASE = 'version = 1\n[*]\ncache-ram = 1024\n[loaded-model]\nmodel = /models/a.gguf\nctx-size = 8192\n[other]\nmodel = /models/b.gguf\n';
const same = ({ baseline, current }) => ({ safe: baseline === current, reason: baseline === current ? 'unchanged' : 'changed', changed: baseline === current ? [] : ['loaded-model'] });
const rows = (loaded = []) => ['loaded-model', 'other'].map((id) => ({ id, status: { value: loaded.includes(id) ? 'loaded' : 'unloaded', preset: `[${id}]` } }));
function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-bridge-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

// A manager on synthetic presets whose router and front calls share one ordered log.
function managerWith(t, front, { log } = {}) {
  const dir = tmp(t), file = path.join(dir, 'models.ini'), stateFile = path.join(dir, 'reload.json');
  fs.writeFileSync(file, BASE);
  const state = { loaded: [], calls: log || [] };
  const openAtReload = [];
  const fetchJson = async (url, opts = {}) => {
    const u = new URL(url);
    state.calls.push(`${opts.method || 'GET'} ${u.pathname}${u.search}`);
    if (u.search.includes('reload=1') && typeof front.state === 'function') openAtReload.push(front.state().open);
    if (u.pathname === '/models/unload') { const id = JSON.parse(opts.body).model; state.loaded = state.loaded.filter((x) => x !== id); return { ok: true, status: 200, body: { success: true } }; }
    return { ok: true, status: 200, body: { data: rows(state.loaded) } };
  };
  const logs = [];
  const reloadGuard = createBridgeReloadGuard({ client: front, legacy: () => createReloadGuard({ check: same, stateFile }), log: (m) => logs.push(m), retryMs: 1 });
  const manager = createLlamaCppManager({ baseUrl: 'http://synthetic', presetPath: file, fetchJson, reloadGuard });
  return { manager, state, stateFile, logs, reloadGuard, openAtReload, reloads: () => state.calls.filter((c) => c === 'GET /models?reload=1').length };
}

test('the boot session decides bridge mode, and the front then holds the baseline', async (t) => {
  const log = [];
  const front = createFakePresetBaseline({ check: same, log });
  const f = managerWith(t, front, { log });
  assert.equal(await f.reloadGuard.mode(), 'bridge');
  assert.equal(log[0], 'bridge session');
  assert.equal(front.state().boots.length, 1);
  assert.equal(await f.reloadGuard.known(), false);
  const at = log.length;
  assert.equal((await f.manager.reloadPresets()).status, 200);
  assert.deepEqual(log.slice(at).filter((c) => c.startsWith('bridge') || c.includes('reload=1')), ['bridge begin:node', 'GET /models?reload=1', 'bridge settle']);
  assert.equal(front.state().baseline.text, BASE);
  assert.equal(front.state().baseline.view, engineView(rows()));
  assert.equal(await f.reloadGuard.known(), true);
  assert.equal(await f.manager.presetsInRouter(), BASE);
  f.state.loaded = ['loaded-model'];
  fs.appendFileSync(path.join(path.dirname(f.stateFile), 'models.ini'), '[new]\nmodel = /models/n.gguf\n');
  // The fake check is "identical text", so an added section is a change here: refused, reason from the front.
  const r = await f.manager.reloadPresets();
  assert.equal(r.status, 409); assert.equal(r.body.reason, 'changed');
  assert.equal(fs.existsSync(f.stateFile), false, 'Node never opened the state file');
  assert.deepEqual(f.logs, []);
});

for (const [name, front] of [
  ['an older front answers the session with 404', () => createFakePresetBaseline({ check: same, session: 404 })],
  ['the front does not answer the session', () => createFakePresetBaseline({ check: same, unreachable: ['session'] })],
]) test(`${name}: the legacy local guard for this process's life, logged once`, async (t) => {
  const fake = front();
  const f = managerWith(t, fake);
  assert.equal(await f.reloadGuard.mode(), 'legacy');
  assert.equal((await f.manager.reloadPresets()).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')), { text: BASE, view: engineView(rows()) }, 'the local guard wrote the shared file');
  assert.equal(await f.reloadGuard.known(), true);
  assert.equal(await f.manager.presetsInRouter(), BASE);
  await f.reloadGuard.invalidate('calibration');
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{}');
  assert.equal(f.logs.length, 1, f.logs.join('\n'));
  assert.match(f.logs[0], /does not hold the preset reload baseline.*keeps its own guard/);
  const sessions = fake.log.filter((c) => c === 'bridge session').length;
  assert.equal(sessions, name.includes('404') ? 1 : 3, 'a 404 is final; no answer is retried a bounded number of times');
  assert.deepEqual(fake.log.filter((c) => c !== 'bridge session'), [], 'nothing else was asked of the front');
});

for (const [name, front] of [
  ['refuses', () => createFakePresetBaseline({ check: same, begin: 503 })],
  ['does not answer', () => createFakePresetBaseline({ check: same, unreachable: ['begin'] })],
]) test(`a front that ${name} a reload ticket: no reload, answered as a failed reload (502)`, async (t) => {
  const f = managerWith(t, front());
  assert.equal(await f.reloadGuard.mode(), 'bridge');
  const r = await f.manager.reloadPresets();
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'The engine did not reload its settings. Check the Hardware tab.');
  assert.equal(f.reloads(), 0, 'the router was never asked to reload');
  // A models.ini write keeps its write and reports the reload as not done.
  const { reload } = await f.manager.writePresets(async () => 'written');
  assert.equal(reload.ok, false);
  assert.equal(f.reloads(), 0);
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('a stale settle (409) is settled as unknown, logged and not retried', async (t) => {
  const front = createFakePresetBaseline({ check: same, staleSettle: true });
  const f = managerWith(t, front);
  const r = await f.manager.reloadPresets();
  assert.equal(r.status, 200, 'the reload itself happened');
  assert.equal(f.reloads(), 1);
  assert.equal(front.log.filter((c) => c === 'bridge settle').length, 1, 'not retried');
  assert.ok(f.logs.some((m) => /ticket was stale/.test(m)), f.logs.join('\n'));
  f.state.loaded = ['loaded-model'];
  assert.equal((await f.manager.reloadPresets()).body.reason, 'unknown', 'a keep-loaded reload is refused');
  assert.equal(f.reloads(), 1);
});

test('a front restarted on its own: begin shows a new epoch and the session is sent again', async (t) => {
  const front = createFakePresetBaseline({ check: same });
  const f = managerWith(t, front);
  assert.equal((await f.manager.reloadPresets()).status, 200);
  assert.equal(f.reloadGuard.epoch(), 'fake-epoch-1');
  front.restart();
  const at = front.log.length;
  assert.deepEqual(front.state().boots, [], 'the restarted front knows no session');
  assert.equal((await f.manager.reloadPresets()).status, 200);
  assert.equal(f.reloadGuard.epoch(), 'fake-epoch-2');
  assert.equal(front.state().boots.length, 1, 'the same boot id, sent to the new front');
  // The re-session ends the first ticket (Rust's session does), so a fresh one carries the reload.
  assert.deepEqual(front.log.slice(at), ['bridge begin:node', 'bridge session', 'bridge begin:node', 'bridge settle']);
  assert.deepEqual(f.openAtReload.at(-1), 1, 'the ticket was open through the engine call');
  assert.equal(front.state().baseline?.text, BASE, 'the settle recorded (200), not stale');
  assert.ok(!f.logs.some((m) => /stale/.test(m)), f.logs.join('\n'));
  assert.ok(f.logs.some((m) => /front restarted.*fake-epoch-1 -> fake-epoch-2/.test(m)), f.logs.join('\n'));
  // The same epoch again: no further session.
  await f.manager.reloadPresets();
  assert.equal(front.log.filter((c) => c === 'bridge session').length, 2);
});

test('a front restarted while a reload was in flight: the stale settle sends the session again', async (t) => {
  const front = createFakePresetBaseline({ check: same });
  const guard = createBridgeReloadGuard({ client: front, legacy: () => { throw new Error('legacy'); } });
  const ticket = await guard.begin('node');
  front.restart();
  const settled = await guard.settle(ticket, 'record', { before: BASE, rows: rows(), after: BASE });
  assert.equal(settled.stale, true);
  assert.equal(guard.epoch(), 'fake-epoch-2');
  assert.equal(front.state().boots.length, 1);
  assert.equal(await guard.known(), false);
});

test('a failed invalidate, verdict or router-text reads as unknown and never throws', async (t) => {
  const front = createFakePresetBaseline({ check: same, unreachable: ['invalidate', 'verdict', 'router-text'] });
  const logs = [];
  const guard = createBridgeReloadGuard({ client: front, log: (m) => logs.push(m) });
  assert.deepEqual(await guard.invalidate('autotune'), { saved: false });
  assert.deepEqual(await guard.verdict(BASE, rows(), []), { safe: false, reason: 'unknown' });
  assert.equal(await guard.routerText(rows()), null);
  assert.ok(logs.some((m) => /invalidate did not reach the front/.test(m)));
});

test('the store client sends the bridge ops to the internal listener with the secret and a 5 s deadline', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return new Response(JSON.stringify({ epoch: 'e', protocol: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const client = createClient({ port: 4321, token: 'x'.repeat(32), fetchImpl });
  const answer = await client.presetBaseline('session', { nodeBoot: 'b', protocol: 1 }, { timeoutMs: BRIDGE_TIMEOUT_MS });
  assert.deepEqual(answer, { status: 200, body: { epoch: 'e', protocol: 1 } });
  assert.equal(seen[0].url, 'http://127.0.0.1:4321/v1/preset-baseline/session');
  assert.equal(seen[0].opts.headers['x-noevia-store-token'], 'x'.repeat(32));
  assert.equal(BRIDGE_TIMEOUT_MS, 5000);
  await assert.rejects(client.presetBaseline('write', {}), /not a preset baseline op/);
});

test('a front whose epoch moves again after the re-session is not trusted with the reload (502, no reload)', async (t) => {
  const front = createFakePresetBaseline({ check: same });
  // Every session after the boot one lands on a front that restarts right after answering it.
  let sessions = 0;
  const client = { state: front.state, presetBaseline: async (op, body, o) => {
    const answer = await front.presetBaseline(op, body, o);
    if (op === 'session' && ++sessions > 1) front.restart();
    return answer;
  } };
  const f = managerWith(t, client);
  assert.equal((await f.manager.reloadPresets()).status, 200);
  front.restart();
  const r = await f.manager.reloadPresets();
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'The engine did not reload its settings. Check the Hardware tab.');
  assert.equal(f.reloads(), 1, 'only the first reload reached the router');
  assert.equal(front.log.filter((c) => c === 'bridge begin:node').length, 3, 'one retry, no more');
});

test('a re-session the front does not answer means no ticket: 502, no reload', async (t) => {
  const front = createFakePresetBaseline({ check: same });
  let down = false;
  const client = { state: front.state, presetBaseline: async (op, body, o) => {
    if (down && op === 'session') throw new Error('The project store is busy. Try again shortly.');
    return front.presetBaseline(op, body, o);
  } };
  const f = managerWith(t, client);
  assert.equal((await f.manager.reloadPresets()).status, 200);
  front.restart(); down = true;
  assert.equal((await f.manager.reloadPresets()).status, 502);
  assert.equal(f.reloads(), 1);
});

test('the fake front retires another session\'s tickets on session, as reload.rs does', async () => {
  const front = createFakePresetBaseline({ check: same });
  const opts = { timeoutMs: 5000 };
  const early = (await front.presetBaseline('begin', { origin: 'node' }, opts)).body.ticket;
  await front.presetBaseline('session', { nodeBoot: 'boot-a', protocol: 1 }, opts);
  assert.equal(front.state().open, 0);
  assert.equal((await front.presetBaseline('settle', { ticket: early, outcome: 'forget' }, opts)).status, 409);
  const mine = (await front.presetBaseline('begin', { origin: 'node' }, opts)).body.ticket;
  await front.presetBaseline('session', { nodeBoot: 'boot-a', protocol: 1 }, opts);
  assert.equal(front.state().open, 1, 'the same boot id again is a no-op');
  assert.equal((await front.presetBaseline('settle', { ticket: mine, outcome: 'forget' }, opts)).status, 200);
});

test('invalidate answers saved only when the front or the local file took the tombstone', async (t) => {
  const ok = createBridgeReloadGuard({ client: createFakePresetBaseline({ check: same }) });
  assert.deepEqual(await ok.invalidate('calibration'), { saved: true });
  const down = createBridgeReloadGuard({ client: createFakePresetBaseline({ check: same, unreachable: ['invalidate'] }) });
  assert.deepEqual(await down.invalidate('calibration'), { saved: false });
  const stateFile = path.join(tmp(t), 'reload.json');
  const local = createReloadGuard({ stateFile, check: same, lock: { waitMs: 30 } });
  assert.deepEqual(await local.invalidate(), { saved: true });
  fs.writeFileSync(`${stateFile}.lock`, 'other');
  assert.deepEqual(await local.invalidate(), { saved: false });
});
