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

// The pre-#867 implementation, kept as the reference: normal exports must stay byte for byte the same.
function legacyExport({ freeChats = [], projects = [], readHistory, now }) {
  const { FORMAT } = require('./chat-export.cjs');
  const entries = [], taken = new Set(), chats = [];
  const add = (name, text) => {
    let unique = name, n = 2;
    while (taken.has(unique)) unique = name.replace(/\.md$/, `-${n++}.md`);
    taken.add(unique); entries.push({ name: unique, data: Buffer.from(text, 'utf8') });
  };
  const idPart = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  const slug = (text, fallback) => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || fallback;
  for (const chat of freeChats) {
    const history = readHistory(chat.id);
    add(`chats/${slug(chat.title, 'untitled-chat')}-${idPart(chat.id)}.md`, chatMarkdown(chat, history));
    chats.push({ id: chat.id, title: chat.title || '', updatedAt: chat.updatedAt || null, project: null, history });
  }
  for (const project of projects) {
    const folder = `projects/${slug(project.name, idPart(project.id) || 'project')}`;
    for (const chat of project.chats || []) {
      const history = readHistory(chat.id);
      add(`${folder}/${slug(chat.title, 'untitled-chat')}-${idPart(chat.id)}.md`, chatMarkdown(chat, history));
      chats.push({ id: chat.id, title: chat.title || '', updatedAt: chat.updatedAt || null, project: { id: project.id, name: project.name }, history });
    }
  }
  add('README.md', `# noevia conversations\n\nExported ${new Date(now).toISOString()}. ${chats.length} chat${chats.length === 1 ? '' : 's'}.\n\n- \`chats/\`: chats outside projects, one Markdown file each.\n- \`projects/\`: chats grouped by project.\n- \`conversations.json\`: everything above in one file (format ${FORMAT}).\n\nThinking text is not included.\n`);
  add('conversations.json', JSON.stringify({ format: FORMAT, exportedAt: new Date(now).toISOString(), chats: chats.map((c) => ({ ...c, history: c.history.map(({ reasoning, ...m }) => m) })) }, null, 2));
  return zipStore(entries, now);
}

const fixtureHistories = {
  'c-1': [{ role: 'user', content: 'hi "quoted"\nsecond line ü 😀  ' }, { role: 'assistant', content: 'About **ten hours**.', reasoning: 'private chain', toolCalls: [{ name: 'project_search', args: { q: 'x', nested: { a: [1, 2, { b: null }] } } }] }],
  'c-2': [{ role: 'user', content: 'x' }], 'c-3': [], 'c-4': [{ role: 'user', content: 'in a project' }],
};
const fixtureArgs = (extra = {}) => ({
  freeChats: [{ id: 'c-1', title: 'Battery notes', updatedAt: 1 }, { id: 'c-2', title: 'Battery notes', updatedAt: 2 }],
  projects: [{ id: 'p-1', name: 'Work / Stuff', chats: [{ id: 'c-3', title: '' }, { id: 'c-4', title: 'Plan', updatedAt: 4 }] }, { id: 'p-2', name: 'Empty', chats: [] }],
  readHistory: (id) => fixtureHistories[id] || [], now: Date.UTC(2026, 9, 5), ...extra,
});

test('a normal export is byte-identical to the pre-cap implementation (#867)', () => {
  assert.ok(buildExport(fixtureArgs()).equals(legacyExport(fixtureArgs())));
  // Nothing to export at all: still the same empty-chats document.
  const none = { readHistory: () => [], now: Date.UTC(2026, 9, 5) };
  assert.ok(buildExport(none).equals(legacyExport(none)));
});

test('a history over the byte cap is refused with a 413 error, not thrown mid-build (#867)', () => {
  const { ExportTooLargeError } = require('./chat-export.cjs');
  assert.throws(() => buildExport(fixtureArgs({ maxBytes: 200 })), (e) => e instanceof ExportTooLargeError && e.status === 413 && /too large to export in one file/.test(e.publicMessage));
  // Just enough room still works.
  assert.ok(buildExport(fixtureArgs({ maxBytes: 64 * 1024 })).length > 0);
});

test('more chats than the entry cap are refused before any history is read (#867)', () => {
  let reads = 0;
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `c-${i}`, title: `t${i}` }));
  assert.throws(() => buildExport({ freeChats: many, readHistory: () => { reads++; return []; }, maxEntries: 10 }), (e) => e.status === 413);
  assert.equal(reads, 0);
  assert.throws(() => buildExport({ projects: [{ id: 'p', name: 'p', chats: many }], readHistory: () => [], maxEntries: 51 }), (e) => e.status === 413, 'README and conversations.json count too');
  assert.ok(buildExport({ projects: [{ id: 'p', name: 'p', chats: many }], readHistory: () => [], maxEntries: 52 }).length > 0);
});

test('a large synthetic history stops at the cap quickly and with bounded work (#867)', () => {
  const { MAX_EXPORT_BYTES, ExportTooLargeError } = require('./chat-export.cjs');
  const big = 'synthetic message text '.repeat(40000); // ~0.9 MB per message
  let reads = 0;
  const freeChats = Array.from({ length: 500 }, (_, i) => ({ id: `c-${i}`, title: `Chat ${i}`, updatedAt: i }));
  const readHistory = () => { reads++; return [{ role: 'user', content: big }, { role: 'assistant', content: big }]; };
  assert.throws(() => buildExport({ freeChats, readHistory }), ExportTooLargeError);
  // Each chat is ~3.7 MB of Markdown plus JSON, so the cap trips after a bounded number of reads.
  assert.ok(reads < Math.ceil(MAX_EXPORT_BYTES / (2 * big.length * 2)) + 2, `read ${reads} chats`);
});

test('a history too large to stringify becomes a 413, not a RangeError (#867)', () => {
  const huge = { toJSON() { throw new RangeError('Invalid string length'); } };
  assert.throws(() => buildExport({ freeChats: [{ id: 'c-1', title: 'x' }], readHistory: () => [{ role: 'user', content: 'x', extra: huge }] }), (e) => e.status === 413);
});

test('#893: the byte cap counts every exported byte once, so chats exactly at the cap still export', () => {
  const { ExportTooLargeError } = require('./chat-export.cjs');
  const files = unzip(buildExport(fixtureArgs()));
  const exact = Object.values(files).reduce((n, text) => n + Buffer.byteLength(text, 'utf8'), 0);
  // Exactly the content size fits; one byte less does not.
  assert.ok(buildExport(fixtureArgs({ maxBytes: exact })).equals(buildExport(fixtureArgs())));
  assert.throws(() => buildExport(fixtureArgs({ maxBytes: exact - 1 })), (e) => e instanceof ExportTooLargeError);
  // Same with no chats at all (the "[]" wrapper).
  const none = { readHistory: () => [], now: Date.UTC(2026, 9, 5) };
  const noneSize = Object.values(unzip(buildExport(none))).reduce((n, text) => n + Buffer.byteLength(text, 'utf8'), 0);
  assert.ok(buildExport({ ...none, maxBytes: noneSize }).length > 0);
  assert.throws(() => buildExport({ ...none, maxBytes: noneSize - 1 }), (e) => e instanceof ExportTooLargeError);
});
