'use strict';
// Chat port S7: the front owns the chat turn's SSE wire; a relayed turn that asks for it is answered as NDJSON
// (rust-chat-wire.cjs). Pinned here: the event stream's headers and its 5 s keep-alive as this process writes them for
// everyone else (the contract's test gap), the NDJSON form of the same frames, the relay's wire header, and that
// chat.cjs, diary-stream.cjs and index.cjs write the turn through the wire alone. The real chat loop on both wires is
// in rust-chat-turn.test.cjs. Synthetic data only; no model runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const wire = require('./rust-chat-wire.cjs');
const turn = require('./rust-chat-turn.cjs');

function fakeRes() {
  const res = new EventEmitter();
  Object.assign(res, { destroyed: false, head: null, writes: [], writeHead(status, headers) { res.head = { status, headers }; }, write(s) { res.writes.push(s); return true; } });
  return res;
}

test('the event stream: chat.cjs\'s headers and a keep-alive comment every 5000 ms from the headers, until the end', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  assert.equal(wire.FRONT_CAPABILITY, 'rust-chat-wire');
  for (const end of ['finish', 'close']) {
    const res = fakeRes();
    const w = wire.createWire(res);
    assert.equal(w.kind, 'sse');
    assert.equal(res.head, null, 'nothing before open()');
    w.open();
    assert.deepEqual(res.head, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' } });
    t.mock.timers.tick(4999);
    assert.deepEqual(res.writes, []);
    t.mock.timers.tick(1);
    assert.deepEqual(res.writes, [': keep-alive\n\n']);
    t.mock.timers.tick(5000);
    assert.deepEqual(res.writes, [': keep-alive\n\n', ': keep-alive\n\n']);
    res.emit(end);
    t.mock.timers.tick(20000);
    assert.equal(res.writes.length, 2, `no keep-alive after ${end}`);
  }
  // A destroyed socket is not written; stop() ends the heartbeat too (diary-stream.cjs's finally).
  const res = fakeRes();
  const w = wire.createWire(res, 'sse', { heartbeatMs: 50 });
  w.open();
  res.destroyed = true;
  t.mock.timers.tick(50);
  assert.deepEqual(res.writes, []);
  res.destroyed = false;
  w.stop();
  t.mock.timers.tick(500);
  assert.deepEqual(res.writes, []);
});

test('NDJSON for the front: its own headers and no keep-alive (the front writes those)', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const res = fakeRes();
  const w = wire.createWire(res, 'ndjson');
  assert.equal(w.kind, 'ndjson');
  w.open();
  assert.deepEqual(res.head, { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  t.mock.timers.tick(60000);
  assert.deepEqual(res.writes, []);
  assert.equal(wire.createWire(fakeRes(), 'something-else').kind, 'sse');
});

test('one event is one line, and `data: <line>\\n\\n` is exactly the frame this process writes', () => {
  const events = [
    { type: 'meta', model: 'synthetic-model', chatId: 'c1' },
    { type: 'delta', text: 'line one\nline two\r\n\n   "quoted" \\ \u0000 \u001f' },
    { type: 'delta', text: '\ud800 lone, \udfff lone, 😀 pair, é, 中文' },
    { type: 'tool', index: 0, name: 'write_file', args: { path: 'a/b.txt', nested: [1, null, true, { x: -0.5e-7 }] } },
    { type: 'error', text: 'x', code: 'machineUnreachable', retryable: true },
    { type: 'done', model: 'synthetic-model' },
  ];
  for (const e of events) {
    const line = wire.frame('ndjson', e);
    assert.ok(line.endsWith('\n'));
    assert.equal(line.indexOf('\n'), line.length - 1, 'one line, no raw newline inside');
    assert.ok(!line.includes('\r'));
    assert.equal(`data: ${line.slice(0, -1)}\n\n`, wire.frame('sse', e));
    assert.equal(wire.frame('sse', e), `data: ${JSON.stringify(e)}\n\n`);
  }
  // A relayed frame is a JSON string line; the event stream writes it unchanged.
  const raw = 'event: x\ndata: {"type":"status", "text":"spaced"}\n\n';
  assert.equal(wire.rawFrame('sse', raw), raw);
  const line = wire.rawFrame('ndjson', raw);
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.equal(JSON.parse(line), raw);
  assert.equal(wire.failedFrame('sse'), 'data: {"type":"error","text":"The request could not be completed. Please retry."}\n\n');
  assert.equal(wire.failedFrame('ndjson'), '{"type":"error","text":"The request could not be completed. Please retry."}\n');
});

test('the relay names its wire: only a turn that asks for ndjson/1 gets it, and the header never reaches the pipeline', () => {
  const SECRET = 'synthetic-front-secret-0123456789abcdef';
  const json = () => assert.fail('no refusal expected');
  const bridge = turn.createTurnBridge({ secret: SECRET, json });
  const req = (url, headers = {}) => ({ method: 'POST', url, socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': SECRET, [turn.USER_HEADER]: 'synthetic-user', ...headers } });
  const asked = req(turn.TURN_PATH, { [wire.WIRE_HEADER]: wire.WIRE });
  assert.equal(bridge.accept(asked, {}), 'turn');
  assert.equal(turn.relayedWire(asked), 'ndjson');
  assert.equal(asked.headers[wire.WIRE_HEADER], undefined);
  for (const value of [undefined, '', 'ndjson', 'ndjson/2', 'NDJSON/1']) {
    const r = req(turn.TURN_PATH, value === undefined ? {} : { [wire.WIRE_HEADER]: value });
    assert.equal(bridge.accept(r, {}), 'turn');
    assert.equal(turn.relayedWire(r), 'sse', String(value));
    assert.equal(r.headers[wire.WIRE_HEADER], undefined);
  }
  // A request that did not come through the bridge (a client sending the header itself) is never NDJSON.
  assert.equal(turn.relayedWire({ headers: { [wire.WIRE_HEADER]: wire.WIRE } }), 'sse');
  assert.equal(turn.relayedWire(null), 'sse');
});

test('chat.cjs, diary-stream.cjs and index.cjs write the turn only through the wire', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  for (const f of ['chat.cjs', 'diary-stream.cjs']) {
    const src = read(f);
    assert.doesNotMatch(src, /'Content-Type': 'text\/event-stream'/, `${f}: headers`);
    assert.doesNotMatch(src, /: keep-alive/, `${f}: heartbeat`);
    assert.doesNotMatch(src, /`data: \$\{/, `${f}: frames`);
  }
  const chat = read('chat.cjs');
  assert.match(chat, /const eventWire = require\('\.\/rust-chat-wire\.cjs'\)\.createWire\(res, require\('\.\/rust-chat-turn\.cjs'\)\.relayedWire\(req\)\);/);
  assert.equal((chat.match(/eventWire\.open\(\);/g) || []).length, 2, 'the early stream and the normal one');
  assert.match(chat, /res\.write\(eventWire\.frame\(obj\)\)/);
  assert.match(chat, /withStorageCredential:diaryStorageRetry,wire:eventWire\}/);
  const index = read('index.cjs');
  assert.match(index, /res\.end\(chatWire\.failedFrame\(require\('\.\/rust-chat-turn\.cjs'\)\.relayedWire\(req\)\)\);/);
  assert.match(index, /^const chatWire = require\('\.\/rust-chat-wire\.cjs'\);$/m);
});

test('a Diary turn on the front\'s wire: the companion\'s frames as string lines, reworded events as objects', async (t) => {
  const { proxyDiaryStream } = require('./diary-stream.cjs');
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(c) {
    const enc = new TextEncoder();
    c.enqueue(enc.encode('data: {"type":"status", "text":"Opening diary context…"}\n\n'));
    c.enqueue(enc.encode('event: ping\ndata: [DONE]\n\n'));
    c.enqueue(enc.encode('data: {"type":"error","text":"companion failed"}\n\n'));
    c.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const run = async (kind) => {
    const chunks = [];
    const res = new Writable({ write(chunk, _e, next) { chunks.push(chunk.toString()); next(); } });
    res.writeHead = (status, headers) => { res.head = { status, headers }; };
    const w = wire.createWire(res, kind);
    await proxyDiaryStream(res, 'http://synthetic', {}, { wire: w });
    return { head: res.head, text: chunks.join('') };
  };
  const sse = await run('sse');
  const nd = await run('ndjson');
  assert.equal(nd.head.headers['Content-Type'], 'application/x-ndjson');
  assert.equal(sse.head.headers['Content-Type'], 'text/event-stream');
  const lines = nd.text.split('\n');
  assert.equal(lines.pop(), '');
  const values = lines.map((l) => JSON.parse(l));
  assert.deepEqual(values.map((v) => typeof v), ['object', 'string', 'string', 'object']);
  // The front's rendering of the NDJSON is exactly the event stream this process writes.
  const rendered = values.map((v) => (typeof v === 'string' ? v : `data: ${JSON.stringify(v)}\n\n`)).join('');
  assert.equal(rendered, sse.text);
  assert.equal(values[3].code, 'contextFailed');
});
