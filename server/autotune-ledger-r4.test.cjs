'use strict';
// K r4 review P1-1: the actor's operation ledger and its covered repair (the exact committed section of
// llamacpp-full-autotune.cjs, with promise-controlled dependencies). AUTOTUNE_LEDGER_SOURCE may point at
// another revision's file (fail-before evidence).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const SOURCE = process.env.AUTOTUNE_LEDGER_SOURCE || require.resolve('./llamacpp-full-autotune.cjs');

function actor({ flushReload = async () => {}, held = () => true } = {}) {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const code = src.slice(src.indexOf('  const ledger = new Map(), LEDGER_MAX'), src.indexOf('  // Facts only this process has.'));
  const calls = { flushReload: 0 };
  const context = {
    fenced: null, maintenance: { held }, publicFail: m => Error(m), Error, Object, Promise, Set, Map,
    flush: async () => {},
    flushReload: async (...a) => { calls.flushReload++; return flushReload(...a); },
  };
  vm.createContext(context);
  vm.runInContext(code + ';this.ledgerBegin=ledgerBegin;this.ledgerEnd=ledgerEnd;this.settle=settle;this.ledger=ledger;'
    + 'this.trackReload=typeof trackReload==="function"?trackReload:(p=>p);', context);
  return { ...context, calls };
}
const id = n => n.toString(16).padStart(8, '0');
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const turn = () => new Promise(r => setImmediate(r));

test('a retried repair joins the running one and is never terminal before it settles', async () => {
  const g = gate();
  const a = actor({ flushReload: () => g.p });
  a.ledgerEnd(a.ledgerBegin(id(0), 'identities'), { needsRepair: true });
  const first = a.settle({ op: id(0), repair: true });
  await turn();
  const second = await a.settle({ op: id(0), repair: true });
  assert.notEqual(second.repaired, true, 'retry declared settlement while the first re-read runs');
  assert.equal(second.state, 'running');
  assert.equal(a.calls.flushReload, 1, 'retry dispatched a second repair');
  g.open();
  assert.equal((await first).repaired, true);
  assert.equal((await a.settle({ op: id(0), repair: true })).repaired, true);
});

test('a repair is not terminal while another re-read the actor dispatched is still in flight', async () => {
  const other = gate();
  const a = actor();
  a.trackReload(other.p);
  a.ledgerEnd(a.ledgerBegin(id(0), 'identities'), { needsRepair: true });
  let done = false;
  const r = a.settle({ op: id(0), repair: true }).then(x => { done = true; return x; });
  for (let i = 0; i < 5; i++) await turn();
  assert.equal(done, false, 'repair receipt preceded an in-flight re-read');
  other.open();
  assert.equal((await r).repaired, true);
});

test('an active repair is never evicted and its receipt is never refused', async () => {
  const g = gate();
  const a = actor({ flushReload: () => g.p });
  a.ledgerEnd(a.ledgerBegin(id(0), 'identities'), { needsRepair: true });
  const pending = a.settle({ op: id(0), repair: true });
  for (let n = 1; n <= 600; n++) { try { const e = a.ledgerBegin(id(n), 'listing'); a.ledgerEnd(e, { ok: true }); } catch { /* full */ } }
  assert.equal(a.ledger.has(id(0)), true);
  assert.equal((await a.settle({ op: id(0) })).state, 'running');
  g.open(); await pending;
});

test('a refusal fence survives any number of later operations', async () => {
  const a = actor();
  assert.equal((await a.settle({ op: id(0) })).state, 'refused');
  for (let n = 1; n <= 1200; n++) {
    try { a.ledgerEnd(a.ledgerBegin(id(n), 'listing'), { ok: true }); await a.settle({ op: id(n), forget: true }); } catch { /* full */ }
  }
  assert.equal(a.ledger.has(id(0)), true);
  assert.equal(a.ledgerBegin(id(0), 'identities'), null, 'a fenced operation was admitted');
  assert.equal((await a.settle({ op: id(0) })).state, 'refused');
});

test('the ledger bounds running operations: at capacity new work is refused', () => {
  const a = actor();
  let refused = 0;
  for (let n = 0; n < 600; n++) { try { a.ledgerBegin(id(n), 'listing'); } catch { refused++; } }
  assert.ok(a.ledger.size <= 512, `ledger holds ${a.ledger.size}`);
  assert.equal(refused, 600 - 512);
});

test('a repair whose maintenance hold is gone dispatches nothing and is not settled', async () => {
  const a = actor({ held: () => false });
  a.ledgerEnd(a.ledgerBegin(id(0), 'identities'), { needsRepair: true });
  const r = await a.settle({ op: id(0), repair: true });
  assert.equal(r.repaired, false);
  assert.equal(a.calls.flushReload, 0);
});
