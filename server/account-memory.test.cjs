// The account memory chat.cjs reads. The Rust front writes it (PUT /api/account/memory,
// sbstndalton/noevia#1071; noevia-rs crates/server-account): the records here are written as files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const mem = require('./account-memory.cjs');

test('reads what was saved, trimmed and capped; a missing or damaged file is the default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-mem-'));
  try {
    assert.deepEqual(mem.read(dir), { memories: [], useProjectMemories: true, updatedAt: null });
    fs.writeFileSync(path.join(dir, 'account-memory.json'), JSON.stringify({ memories: ['  I use metric units ', '', 7, 'x'.repeat(400), ...Array.from({ length: 60 }, (_, i) => `m${i}`)], useProjectMemories: false, updatedAt: 1000 }));
    const r = mem.read(dir);
    assert.equal(r.memories[0], 'I use metric units');
    assert.equal(r.memories[1].length, mem.MAX_ITEM_CHARS);
    assert.equal(r.memories.length, mem.MAX_ITEMS);
    assert.equal(r.useProjectMemories, false);
    assert.equal(r.updatedAt, 1000);
    fs.writeFileSync(path.join(dir, 'account-memory.json'), '{broken');
    assert.deepEqual(mem.read(dir), { memories: [], useProjectMemories: true, updatedAt: null }, 'a damaged file never breaks chat');
    assert.equal(typeof mem.write, 'undefined', 'writing it is the Rust front\'s');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('system part merges account and project lines and honours the project switch', () => {
  assert.equal(mem.systemPart({ memories: [], useProjectMemories: true }, []), null);
  const both = mem.systemPart({ memories: ['A'], useProjectMemories: true }, ['B', 'A']);
  assert.equal(both, 'Things you know about the user (persistent memory, apply silently):\n- A\n- B');
  assert.equal(mem.systemPart({ memories: ['A'], useProjectMemories: false }, ['B']), 'Things you know about the user (persistent memory, apply silently):\n- A');
  assert.equal(mem.systemPart({ memories: [], useProjectMemories: false }, ['B']), null);
});
