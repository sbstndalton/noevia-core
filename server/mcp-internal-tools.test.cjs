const test = require('node:test');
const assert = require('node:assert/strict');
const mcp = require('./mcp.cjs');
const { createInternalTools } = require('./mcp-internal-tools.cjs');

function harness(overrides = {}) {
  const project = {
    id: 'proj-a',
    files: [
      { name: 'notes.md', content: 'alpha\nbeta\nalpha\n' },
      { name: 'synced.md', content: 'from a folder', source: 'Documents/Shared' },
      { name: 'scan.pdf', content: 'page text', document: { pages: 2 } },
    ],
  };
  const written = [];
  const ports = {
    cap: 8000,
    getProject: (id) => (id === project.id ? project : null),
    diary: async () => ({}),
    readProjectFile: async (p, args) => `read ${args.name} from ${p.id}`,
    ragAvailable: () => true,
    search: async () => [],
    writeTextFile: async (p, name, text) => {
      written.push({ name, text });
      const existing = p.files.find((f) => f.name === name);
      if (existing) existing.content = text; else p.files.push({ name, content: text });
    },
    ...overrides,
  };
  return { tools: createInternalTools(ports), project, written, ports };
}

const CTX = { userId: 'alice', projectId: 'proj-a' };

test('a project tool outside a project says so instead of failing obscurely', async () => {
  const { tools } = harness();
  await assert.rejects(() => tools.project_list_files.handler({}, { userId: 'alice', projectId: null }),
    /not in a project/);
});

test('identity comes from the token, never from the arguments', async () => {
  const { tools } = harness();
  // Even asked for another project by name, the handler resolves ctx.projectId.
  const out = await tools.project_read_file.handler({ name: 'notes.md', projectId: 'proj-b', userId: 'bob' }, CTX);
  assert.equal(out, 'read notes.md from proj-a');
});

test('search filters stale index rows against the current file list', async () => {
  const { tools } = harness({ search: async () => [
    { file: 'notes.md', body: 'alpha' },
    { file: 'detached.md', body: 'should not surface' }, // index row outlived the file
  ] });
  const out = await tools.project_search.handler({ query: 'alpha' }, CTX);
  assert.match(out, /\[from notes\.md\] alpha/);
  assert.doesNotMatch(out, /detached\.md|should not surface/);
});

test('search without an index says so rather than returning nothing', async () => {
  const { tools } = harness({ ragAvailable: () => false, search: async () => { throw new Error('should not be called'); } });
  const out = await tools.project_search.handler({ query: 'alpha' }, CTX);
  assert.match(out, /not available on this deployment/);
});

test('replace requires the expected number of matches and never writes on a mismatch', async () => {
  const { tools, written, project } = harness();
  // "alpha" appears twice; the default expectation is one.
  await assert.rejects(() => tools.project_replace_text.handler({ name: 'notes.md', find: 'alpha', replace: 'A' }, CTX),
    /expected 1 match but found 2/);
  await assert.rejects(() => tools.project_replace_text.handler({ name: 'notes.md', find: 'nowhere', replace: 'A' }, CTX),
    /not in "notes\.md"/);
  assert.deepEqual(written, [], 'a mismatch must not write');
  assert.equal(project.files[0].content, 'alpha\nbeta\nalpha\n');

  const out = await tools.project_replace_text.handler({ name: 'notes.md', find: 'alpha', replace: 'A', expectedCount: 2 }, CTX);
  assert.match(out, /Replaced 2 occurrences/);
  assert.equal(project.files[0].content, 'A\nbeta\nA\n');
});

test('folder-derived and non-text files are refused rather than silently reverted', async () => {
  const { tools, written } = harness();
  // The sync loop owns folder files; writing here would be undone on next sync.
  for (const name of ['synced.md', 'scan.pdf']) {
    await assert.rejects(() => tools.project_append_file.handler({ name, text: 'x' }, CTX));
    await assert.rejects(() => tools.project_replace_text.handler({ name, find: 'a', replace: 'b' }, CTX));
  }
  assert.deepEqual(written, []);
});

test('create refuses to clobber, append keeps what is there', async () => {
  const { tools, project } = harness();
  await assert.rejects(() => tools.project_create_file.handler({ name: 'notes.md', text: 'new' }, CTX),
    /already exists/);
  await tools.project_create_file.handler({ name: 'fresh.md', text: 'hello' }, CTX);
  assert.equal(project.files.find((f) => f.name === 'fresh.md').content, 'hello');

  await tools.project_append_file.handler({ name: 'fresh.md', text: 'world' }, CTX);
  assert.equal(project.files.find((f) => f.name === 'fresh.md').content, 'hello\nworld');
});

test('a path in a filename cannot escape the project', async () => {
  const { tools, project } = harness();
  await tools.project_create_file.handler({ name: '../../etc/passwd', text: 'x' }, CTX);
  assert.ok(project.files.some((f) => f.name === 'passwd'), 'the directory part must be stripped');
  assert.ok(!project.files.some((f) => f.name.includes('/')), 'no file name may contain a path');
});

test('a missing file names what the project does have', async () => {
  const { tools } = harness();
  await assert.rejects(() => tools.project_append_file.handler({ name: 'absent.md', text: 'x' }, CTX),
    /Available: notes\.md, synced\.md, scan\.pdf/);
});

test('diary reads pass through the sidecar shapes, and there is no diary write tool', async () => {
  const calls = [];
  const { tools } = harness({ diary: async (p) => {
    calls.push(p);
    if (p === '/day') return { day: '2026-09-15', today_log: 'wrote a thing', standing: 'remember this' };
    if (p.startsWith('/day?month=')) return { log: 'a whole month' };
    return { months: ['2026-08', '2026-09'] };
  } });
  assert.match(await tools.diary_read_today.handler({}, CTX), /Standing notes:\nremember this[\s\S]*wrote a thing/);
  assert.equal(await tools.diary_read_month.handler({ month: '2026-09' }, CTX), 'a whole month');
  assert.equal(await tools.diary_list_months.handler({}, CTX), '2026-08, 2026-09');
  assert.deepEqual(calls, ['/day', '/day?month=2026-09', '/months']);

  await assert.rejects(() => tools.diary_read_month.handler({ month: 'September' }, CTX), /2026-09/);
  // Without the D10 feature port the Diary box stays read-only.
  assert.deepEqual(Object.keys(tools).filter((n) => n.startsWith('diary_') && tools[n].write), []);
});

test('every tool converts for the model, and only the three writes are writes', () => {
  const { tools } = harness();
  for (const [name, d] of Object.entries(tools)) {
    const conv = mcp.convertTool({ name, description: d.description, inputSchema: d.schema });
    assert.ok(conv.ok, `${name}: ${conv.reason}`);
    assert.ok(d.description && d.description.length < 120, `${name}: description is too long for the token budget`);
  }
  assert.deepEqual(Object.entries(tools).filter(([, d]) => d.write).map(([n]) => n).sort(),
    ['project_append_file', 'project_create_file', 'project_replace_text']);
});

test('diary_append exists only with the feature port, is a write, and passes only text/title/timezone', async () => {
  const appended = [];
  const { tools } = harness({ diaryAppend: async (body) => { appended.push(body); return { day: '2026-09-17' }; } });
  assert.deepEqual(Object.keys(tools).filter((n) => n.startsWith('diary_') && tools[n].write), ['diary_append']);
  assert.equal(await tools.diary_append.handler({ text: '  a calm walk ', title: 'Walk', timezone: 'Europe/Berlin', day: '2020-01-01', xid: 'x' }, CTX), 'Added a note to the diary for 2026-09-17.');
  assert.deepEqual(appended, [{ text: 'a calm walk', title: 'Walk', timezone: 'Europe/Berlin' }]);
  await assert.rejects(() => tools.diary_append.handler({ text: '   ' }, CTX), /nothing to add/);
  const queued = harness({ diaryAppend: async () => ({ day: '2026-09-17', queued: true }) }).tools;
  assert.match(await queued.diary_append.handler({ text: 'x' }, CTX), /write queue/);
  await assert.rejects(() => tools.diary_append.handler({ text: 'x'.repeat(8001) }, CTX), /too long/);
  assert.deepEqual(Object.keys(tools.diary_append.schema.properties), ['text', 'title', 'timezone'], 'no day/xid argument to aim at');
});

test('isoWithOffset keeps the instant and uses the zone offset', () => {
  const { isoWithOffset } = require('./mcp-internal-tools.cjs');
  const when = new Date('2026-09-17T22:30:00Z');
  assert.equal(isoWithOffset(when, 'Europe/Berlin'), '2026-09-18T00:30:00+02:00');
  assert.equal(isoWithOffset(when, 'America/New_York'), '2026-09-17T18:30:00-04:00');
  assert.equal(new Date(isoWithOffset(when, 'Asia/Kolkata')).getTime(), when.getTime());
  assert.throws(() => isoWithOffset(when, 'Mars/Base'), /unknown IANA/);
});
