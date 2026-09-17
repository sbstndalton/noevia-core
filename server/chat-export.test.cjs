const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { zipStore, chatMarkdown, buildExport } = require('./chat-export.cjs');

// Minimal reader for stored (method 0) entries: local headers in order.
function unzip(buf) {
  const out = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8), crc = buf.readUInt32LE(at + 14), size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26), extraLen = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 30, at + 30 + nameLen);
    const data = buf.subarray(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + size);
    assert.equal(method, 0); assert.equal(zlib.crc32(data), crc, `crc ${name}`);
    out[name] = data.toString('utf8');
    at += 30 + nameLen + extraLen + size;
  }
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, 'end of central directory');
  assert.equal(buf.readUInt16LE(eocd + 10), Object.keys(out).length);
  return out;
}

test('zipStore writes a valid stored archive with UTF-8 names', () => {
  const files = unzip(zipStore([{ name: 'a.md', data: Buffer.from('hello') }, { name: 'dir/ü.md', data: Buffer.from('ümlaut') }]));
  assert.deepEqual(files, { 'a.md': 'hello', 'dir/ü.md': 'ümlaut' });
});

test('chatMarkdown keeps roles, content and tool names, and never prints reasoning', () => {
  const md = chatMarkdown({ title: 'Battery notes', updatedAt: Date.UTC(2026, 8, 17, 10) }, [
    { role: 'user', content: 'How long does it last?' },
    { role: 'assistant', content: 'About **ten hours**.', reasoning: 'private chain', toolCalls: [{ name: 'project_search' }] },
  ]);
  assert.match(md, /^# Battery notes\n/);
  assert.match(md, /## You\n\nHow long does it last\?/);
  assert.match(md, /## Assistant\n\nAbout \*\*ten hours\*\*\./);
  assert.match(md, /Tools used: project_search/);
  assert.doesNotMatch(md, /private chain/);
});

test('buildExport covers free and project chats with safe, unique file names', () => {
  const histories = { 'c-1': [{ role: 'user', content: 'hi' }], 'c-2': [{ role: 'user', content: 'x' }], 'c-3': [] };
  const zip = buildExport({
    freeChats: [{ id: 'c-1', title: '../../etc/passwd', updatedAt: 1 }, { id: 'c-2', title: '../../etc/passwd', updatedAt: 2 }],
    projects: [{ id: 'p-1', name: 'Work / Stuff', chats: [{ id: 'c-3', title: '', updatedAt: 3 }] }],
    readHistory: (id) => histories[id] || [],
    now: Date.UTC(2026, 8, 17),
  });
  const files = unzip(zip);
  const names = Object.keys(files);
  assert.ok(names.every((n) => !n.includes('..') && !n.startsWith('/') && !n.includes('\\')), names.join(', '));
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('README.md') && names.includes('conversations.json'));
  assert.equal(names.filter((n) => n.startsWith('chats/')).length, 2);
  assert.ok(names.some((n) => /^projects\/work-stuff\/untitled-chat-c-3\.md$/.test(n)), names.join(', '));
  const json = JSON.parse(files['conversations.json']);
  assert.equal(json.format, 'noevia-conversations-v1');
  assert.equal(json.chats.length, 3);
  assert.deepEqual(json.chats.find((c) => c.id === 'c-3').project, { id: 'p-1', name: 'Work / Stuff' });
});
