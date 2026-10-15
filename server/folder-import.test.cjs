'use strict';
// #1805: the folder-import rules on their own: relative paths, the shared skip list, the caps, the
// plan's change detection and the per-import tickets. Synthetic names only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fi = require('./folder-import.cjs');
const contract = require('../contracts/folder-import.json');
const storage = require('./storage-client.cjs');

test('#1805: relative paths are normalised; traversal, absolute and drive paths are refused, never rewritten', () => {
  assert.equal(fi.relativePath('docs/api/auth.md'), 'docs/api/auth.md');
  assert.equal(fi.relativePath('docs\\api\\auth.md'), 'docs/api/auth.md');
  assert.equal(fi.relativePath('docs//api///auth.md'), 'docs/api/auth.md');
  for (const bad of ['../secret.md', 'docs/../../secret.md', 'docs/./a.md', '/etc/passwd.md', '\\\\server\\share\\a.md', 'C:\\Users\\a.md', 'c:a.md',
    'docs/a\u0000.md', 'docs/a\n.md', '', '///', ' docs/a.md', 'docs /a.md', 'a/'.repeat(contract.maxDepth) + 'deep.md', 'x'.repeat(1001), 42, null]) {
    assert.throws(() => fi.relativePath(bad), (e) => e.status === 400 && e.code === 'invalidPath', `refused: ${JSON.stringify(bad)}`);
  }
});

test('#1805: one shared skip list, at any depth, plus hidden names and unreadable types', () => {
  const code = (p) => fi.skipReason(p)?.code || null;
  for (const p of ['.git/config.md', 'src/.git/HEAD.md', 'node_modules/pkg/index.js', 'a/b/node_modules/x.js', '__pycache__/m.py', '.venv/lib/x.py',
    'dist/app.js', 'build/out.js', 'Thumbs.db', 'pics/Thumbs.db', 'desktop.ini', '.DS_Store', 'sub/.DS_Store']) {
    assert.ok(['system', 'hidden'].includes(code(p)), `${p} is skipped as system/hidden, got ${code(p)}`);
  }
  assert.equal(code('.env.md'), 'hidden');
  assert.equal(code('notes/.hidden/a.md'), 'hidden');
  assert.equal(code('NODE_MODULES/x.js'), 'system', 'case-insensitive, as on macOS and Windows');
  for (const p of ['tool.exe', 'archive.zip', 'data.sqlite', 'noext', 'slides.key']) assert.equal(code(p), 'unsupported', p);
  for (const p of ['docs/api/auth.md', 'a/b/c/readme.md', 'spec.pdf', 'letter.docx', 'diagram.png', 'photo.JPG', 'main.py', 'build.md', 'distance.txt']) assert.equal(code(p), null, p);
  // The contract covers every text type the server reads, so nothing readable is skipped as unsupported.
  for (const ext of storage.TEXT_EXTENSIONS) assert.ok(contract.readableExtensions.includes(ext), ext);
});

test('#1805: caps come from the env, falling back to the contract; a bad value falls back too', () => {
  assert.deepEqual(fi.limits({}), { maxFiles: contract.projectLimits.sources, maxBytes: contract.maxBytes, maxDepth: contract.maxDepth, maxFolders: contract.maxFolders });
  assert.equal(fi.limits({ PROJECT_SOURCE_LIMIT: '1000' }).maxFiles, 1000, 'the import cap follows the project source limit');
  assert.equal(fi.limits({ FOLDER_IMPORT_MAX_FILES: '5' }).maxFiles, 5);
  assert.equal(fi.limits({ FOLDER_IMPORT_MAX_BYTES: '1024' }).maxBytes, 1024);
  for (const bad of ['0', '-3', 'lots', '1.5']) assert.equal(fi.limits({ FOLDER_IMPORT_MAX_FILES: bad }).maxFiles, contract.projectLimits.sources, bad);
});

const sha = (c) => require('node:crypto').createHash('sha256').update(c).digest('hex');
const planFor = (entries, { files = [], assets = [], env = {}, userId = 'u1' } = {}) => fi.plan({ userId, project: { id: 'p1', files, assets }, entries, destination: (rel) => `P/${rel}`, perFileCap: () => 25 * 1024 * 1024, env });

test('#1805: the plan accepts readable files, says why each other one is skipped, and enforces the caps in order', () => {
  const entries = [
    { path: 'b/readme.md', size: 10 }, { path: 'a/readme.md', size: 10 }, { path: 'a/deep/er/notes.md', size: 10 },
    { path: '.git/config', size: 5 }, { path: 'node_modules/x/i.js', size: 5 }, { path: 'tool.exe', size: 5 },
    { path: '../escape.md', size: 5 }, { path: 'empty.md', size: 0 }, { path: 'huge.md', size: 26 * 1024 * 1024 }, { path: 'a\\readme.md', size: 10 },
  ];
  const r = planFor(entries, { env: { FOLDER_IMPORT_MAX_FILES: '2' } });
  assert.match(r.importId, /^[a-f0-9]{32}$/);
  assert.deepEqual(r.limits, { maxFiles: 2, maxBytes: contract.maxBytes, projectSources: 60, projectDocuments: 60, projectImages: 12 });
  assert.deepEqual(r.accepted.map((a) => a.path), ['a/deep/er/notes.md', 'a/readme.md']);
  const why = Object.fromEntries(r.skipped.map((s) => [s.path, s.code]));
  assert.deepEqual(why, {
    '.git/config': 'system', 'node_modules/x/i.js': 'system', 'tool.exe': 'unsupported', '../escape.md': 'invalidPath', 'empty.md': 'empty',
    'huge.md': 'tooLarge', 'a/readme.md': 'duplicate', 'b/readme.md': 'fileLimit',
  });
  for (const s of r.skipped) assert.ok(s.reason && typeof s.reason === 'string', 'every skip has a reason');
  const bytes = planFor([{ path: 'a.md', size: 600 }, { path: 'b.md', size: 600 }], { env: { FOLDER_IMPORT_MAX_BYTES: '1000' } });
  assert.deepEqual(bytes.accepted.map((a) => a.path), ['a.md']);
  assert.deepEqual(bytes.skipped.map((s) => [s.path, s.code]), [['b.md', 'sizeLimit']]);
});

test('#1805: the plan marks a file unchanged by content hash, counts a changed one as an update, and keeps the project limit', () => {
  const files = [{ name: 'P/a.md', attachment: { id: sha('same') } }, { name: 'P/b.md', attachment: { id: sha('old') } }];
  const r = planFor([{ path: 'a.md', size: 4, sha256: sha('same') }, { path: 'b.md', size: 3, sha256: sha('new') }, { path: 'c.md', size: 3, sha256: sha('c') }], { files });
  assert.deepEqual(r.unchanged, [{ path: 'a.md' }]);
  assert.deepEqual(r.accepted.map((a) => [a.path, a.change]), [['b.md', 'changed'], ['c.md', 'new']]);
  const full = Array.from({ length: 60 }, (_, i) => ({ name: `P/f${i}.md`, attachment: { id: sha(String(i)) } }));
  const capped = planFor([{ path: 'f1.md', size: 3, sha256: sha('changed') }, { path: 'new.md', size: 3 }], { files: full });
  assert.deepEqual(capped.accepted.map((a) => a.path), ['f1.md'], 'an update still fits a full project');
  assert.deepEqual(capped.skipped.map((s) => [s.path, s.code]), [['new.md', 'projectLimit']]);
});

test('#1805: a ticket admits only its own accepted paths, for its own person and project, once, up to the declared size', () => {
  const r = planFor([{ path: 'a/x.md', size: 3 }, { path: 'a/y.md', size: 5 }, { path: 'tool.exe', size: 3 }]);
  assert.equal(fi.admit(r.importId, 'u1', 'p1', 'a/x.md', 3), null);
  assert.equal(fi.admit(r.importId, 'u2', 'p1', 'a/x.md', 3).code, 'importNotPlanned', 'another person');
  assert.equal(fi.admit(r.importId, 'u1', 'p2', 'a/x.md', 3).code, 'importNotPlanned', 'another project');
  assert.equal(fi.admit(r.importId, 'u1', 'p1', 'tool.exe', 3).code, 'importNotPlanned', 'a skipped path');
  assert.equal(fi.admit('nope', 'u1', 'p1', 'a/x.md', 3).code, 'importNotPlanned', 'an unknown import');
  assert.equal(fi.admit(r.importId, 'u1', 'p1', 'a/x.md', 4).code, 'sizeMismatch', 'more bytes than declared');
  fi.consume(r.importId, 'a/x.md', 3);
  assert.equal(fi.admit(r.importId, 'u1', 'p1', 'a/x.md', 3).code, 'importNotPlanned', 'used once');
  // The running total holds even if a ticket's room shrank (a cap lowered under an open import).
  fi._tickets.get(r.importId).maxBytes = 6;
  assert.equal(fi.admit(r.importId, 'u1', 'p1', 'a/y.md', 5).code, 'sizeLimit', 'the running byte total is enforced');
});

test('#1805: one person opening many imports retires only their own oldest, never another person\'s', () => {
  const mine = planFor([{ path: 'a.md', size: 1 }], { userId: 'alice' });
  const theirs = [];
  for (let i = 0; i < 100; i++) theirs.push(planFor([{ path: 'b.md', size: 1 }], { userId: 'mallory' }).importId);
  assert.equal(fi.admit(mine.importId, 'alice', 'p1', 'a.md', 1), null, 'alice\'s import survives');
  const open = theirs.filter((id) => fi._tickets.has(id));
  assert.deepEqual(open, theirs.slice(-fi.TICKETS_PER_USER), 'mallory keeps only their newest');
});

test('#1805: images count against the image limit, documents against theirs, all against the source limit', () => {
  const assets = Array.from({ length: 12 }, (_, i) => ({ id: `img-${i}` }));
  const img = planFor([{ path: 'pics/a.png', size: 10 }, { path: 'pics/huge.png', size: 9 * 1024 * 1024 }, { path: 'notes.md', size: 3 }], { assets });
  assert.deepEqual(img.skipped.map((s) => [s.path, s.code, s.max]), [['pics/a.png', 'imageLimit', 12]]);
  assert.deepEqual(img.accepted.map((a) => a.path), ['notes.md', 'pics/huge.png'], 'an image too large to be model input takes no image slot');
  const docs = planFor([{ path: 'a.pdf', size: 3 }, { path: 'b.docx', size: 3 }, { path: 'c.md', size: 3 }], { env: { PROJECT_DOCUMENT_LIMIT: '1' } });
  assert.deepEqual(docs.skipped.map((s) => [s.path, s.code]), [['b.docx', 'documentLimit']]);
  const many = planFor(Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.md`, size: 1 })), { env: { PROJECT_SOURCE_LIMIT: '3' } });
  assert.deepEqual(many.accepted.length, 3);
  assert.equal(many.limits.maxFiles, 3);
});

test('#1805: paths are NFC, and a path that differs only in case from another in the import or the project is refused', () => {
  assert.equal(fi.relativePath('cafe\u0301/note.md'), 'caf\u00e9/note.md');
  const r = planFor([{ path: 'docs/Readme.md', size: 1 }, { path: 'docs/readme.md', size: 1 }, { path: 'cafe\u0301.md', size: 1 }, { path: 'caf\u00e9.md', size: 1 }]);
  assert.deepEqual(r.accepted.map((a) => a.path), ['caf\u00e9.md', 'docs/Readme.md']);
  assert.deepEqual(r.skipped.map((s) => [s.path, s.code]).sort(), [['caf\u00e9.md', 'duplicate'], ['docs/readme.md', 'caseCollision']]);
  const existing = planFor([{ path: 'README.md', size: 1 }], { files: [{ name: 'P/readme.md', attachment: { id: 'x' } }] });
  assert.deepEqual(existing.skipped.map((s) => [s.path, s.code, s.existing]), [['README.md', 'caseCollision', 'P/readme.md']]);
});

test('#1805: listTree walks every subfolder breadth-first, skips the shared names, leaves nested attached folders out and stops at the bounds', async () => {
  const tree = {
    R: ['a', 'b', '.git', 'node_modules', 'top.md', 'nested'], 'R/a': ['readme.md', 'c'], 'R/a/c': ['deep.md'], 'R/b': ['readme.md'],
    'R/.git': ['config'], 'R/node_modules': ['x.js'], 'R/nested': ['own.md'],
  };
  const list = async (dir) => {
    if (dir === 'R/b') throw Object.assign(new Error('synthetic 500'), { status: 502 });
    return (tree[dir] || []).map((name) => ({ name, path: `${dir}/${name}`, isDir: !!tree[`${dir}/${name}`] }));
  };
  const failed = [];
  const r = await fi.listTree(list, 'R', { exclude: new Set(['R/nested']), onDirError: (d) => failed.push(d) });
  assert.deepEqual(r.files.map((f) => f.path), ['R/top.md', 'R/a/readme.md', 'R/a/c/deep.md']);
  assert.deepEqual(failed, ['R/b']);
  assert.deepEqual(r.limited, []);
  const shallow = await fi.listTree(list, 'R', { maxDepth: 2 });
  assert.deepEqual(shallow.limited, [{ path: 'R/a/c', code: 'depthLimit' }]);
  const few = await fi.listTree(list, 'R', { maxFolders: 2 });
  assert.ok(few.limited.some((l) => l.code === 'folderLimit'));
  await assert.rejects(fi.listTree(async () => { throw new Error('root down'); }, 'R'), /root down/, 'a failed root listing is the caller\'s failure');
});
