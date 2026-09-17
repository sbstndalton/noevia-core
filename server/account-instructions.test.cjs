const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ai = require('./account-instructions.cjs');

test('round trip, trimmed, capped, and empty clears the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-instr-'));
  try {
    assert.deepEqual(ai.read(dir), { text: '', updatedAt: null });
    const saved = ai.write(dir, '  Answer in British English.  ', 1000);
    assert.deepEqual(saved, { text: 'Answer in British English.', updatedAt: 1000 });
    assert.deepEqual(ai.read(dir), saved);
    assert.throws(() => ai.write(dir, 'x'.repeat(ai.MAX_CHARS + 1)), /4000 characters/);
    assert.throws(() => ai.write(dir, 42), /text/);
    ai.write(dir, '   ');
    assert.equal(fs.existsSync(path.join(dir, 'account-instructions.json')), false);
    fs.writeFileSync(path.join(dir, 'account-instructions.json'), '{broken');
    assert.deepEqual(ai.read(dir), { text: '', updatedAt: null }, 'a damaged file never breaks chat');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('system part says project instructions win and is empty without text', () => {
  assert.equal(ai.systemPart(''), null);
  const part = ai.systemPart('Be brief.');
  assert.match(part, /Be brief\./);
  assert.match(part, /project instructions take precedence/i);
});
