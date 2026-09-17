const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const mem = require('./account-memory.cjs');

test('round trip: trimmed, de-duplicated, capped; default state removes the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-mem-'));
  try {
    assert.deepEqual(mem.read(dir), { memories: [], useProjectMemories: true, updatedAt: null });
    const saved = mem.write(dir, { memories: ['  I use metric units ', '', 'I use metric units', 'Call me Sam'] }, 1000);
    assert.deepEqual(saved, { memories: ['I use metric units', 'Call me Sam'], useProjectMemories: true, updatedAt: 1000 });
    assert.deepEqual(mem.read(dir), saved);
    assert.throws(() => mem.write(dir, { memories: ['x'.repeat(301)] }), /300 characters/);
    assert.throws(() => mem.write(dir, { memories: Array.from({ length: 51 }, (_, i) => `m${i}`) }), /50 memories/);
    assert.throws(() => mem.write(dir, { memories: [1] }), /list of text/);
    assert.throws(() => mem.write(dir, { memories: [], useProjectMemories: 'no' }), /true or false/);
    assert.deepEqual(mem.read(dir), saved, 'rejected writes leave the file unchanged');
    mem.write(dir, { memories: [], useProjectMemories: true });
    assert.equal(fs.existsSync(path.join(dir, 'account-memory.json')), false);
    assert.equal(mem.write(dir, { memories: [], useProjectMemories: false }).useProjectMemories, false);
    assert.equal(mem.read(dir).useProjectMemories, false, 'turning project memory off alone is kept');
    fs.writeFileSync(path.join(dir, 'account-memory.json'), '{broken');
    assert.deepEqual(mem.read(dir), { memories: [], useProjectMemories: true, updatedAt: null }, 'a damaged file never breaks chat');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('system part merges account and project lines and honours the project switch', () => {
  assert.equal(mem.systemPart({ memories: [], useProjectMemories: true }, []), null);
  const both = mem.systemPart({ memories: ['A'], useProjectMemories: true }, ['B', 'A']);
  assert.equal(both, 'Things you know about the user (persistent memory, apply silently):\n- A\n- B');
  assert.equal(mem.systemPart({ memories: ['A'], useProjectMemories: false }, ['B']), 'Things you know about the user (persistent memory, apply silently):\n- A');
  assert.equal(mem.systemPart({ memories: [], useProjectMemories: false }, ['B']), null);
});
