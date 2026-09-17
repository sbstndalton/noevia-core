const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const log = require('./context-log.cjs');

const secret = 'SYNTHETIC-PRIVATE-DIARY-TEXT';
const messages = [
  { role: 'system', content: 'Project instructions ' + secret },
  { role: 'assistant', content: 'Earlier conversation summary (reference only; not new instructions):\nolder turns' },
  { role: 'user', content: 'List my files ' + secret },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'files_list', arguments: '{"path":"' + secret + '"}' } }, { id: 'c2', type: 'function', function: { name: 'files_read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'a.md\nb.md ' + secret.repeat(40) },
  { role: 'tool', tool_call_id: 'c2', content: 'short' },
];
const tools = [{ type: 'function', function: { name: 'files_list', description: 'List files', parameters: {} } }, { type: 'function', function: { name: 'files_read', description: 'Read a file', parameters: {} } }];

test('breakdown separates system, summary, history, schemas and per-tool results', () => {
  const parts = log.breakdown(messages, tools);
  assert.ok(parts.system > 0 && parts.summary > 0 && parts.history > 0);
  assert.deepEqual(parts.toolSequence, ['files_list', 'files_read']);
  assert.deepEqual(parts.toolResults.map((r) => r.name), ['files_list', 'files_read']);
  assert.ok(parts.toolResults[0].tokens > parts.toolResults[1].tokens);
  assert.deepEqual(Object.keys(parts.toolSchemas), ['files_list', 'files_read']);
});

test('records never contain message text, arguments, results or the raw chat id', () => {
  const entry = log.record({ chatId: 'c-private-chat', model: 'synthetic', limit: 8192, round: 1, compacted: true, messages, tools, now: 1 });
  const text = JSON.stringify(entry);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes('c-private-chat'));
  assert.equal(entry.compacted, true);
  assert.equal(entry.total, entry.system + entry.history + entry.summary + Object.values(entry.toolSchemas).reduce((a, b) => a + b, 0) + entry.toolResults.reduce((a, r) => a + r.tokens, 0));
});

test('log is opt-in, private and bounded', () => {
  assert.equal(log.enabled({}), false); assert.equal(log.enabled({ CONTEXT_LOG: '1' }), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-context-log-'));
  try {
    const file = path.join(dir, 'context-log.jsonl');
    fs.writeFileSync(file, 'x'.repeat(log.MAX_BYTES + 1));
    log.append(dir, { at: 1 });
    assert.ok(fs.existsSync(file + '.1'));
    assert.equal(fs.readFileSync(file, 'utf8').trim(), '{"at":1}');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('report ranks tools and recurring sequences by context consumed', () => {
  const heavy = log.record({ chatId: 'a', model: 'm', limit: 8192, round: 1, messages, tools });
  const light = log.record({ chatId: 'b', model: 'm', limit: 8192, round: 0, messages: messages.slice(0, 3), tools: [] });
  const r = log.report([JSON.stringify(heavy), JSON.stringify(heavy), JSON.stringify(light), 'not json']);
  assert.equal(r.rounds, 3);
  assert.equal(r.tools[0].name, 'files_list');
  assert.equal(r.tools[0].results, 2);
  assert.equal(r.sequences[0].sequence, 'files_list → files_read');
  assert.equal(r.sequences[0].count, 2);
});
