'use strict';
// #642: a model can open an uploaded project file by the name it is shown (the storage path) or by
// its bare name when that is unique, through read_project_file and the Project documents box alike.
// Resolution stays inside the requesting project's own files. Synthetic projects only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProjectFile, invalidReason } = require('./project-file-names.cjs');
const { createToolboxes } = require('./toolboxes.cjs');
const { createInternalTools } = require('./mcp-internal-tools.cjs');

const FOLDER = 'noevia projects/Synthetic QA';
const NOTES = `${FOLDER}/Text/synthetic-notes.md`;

// The shape uploads.ingest gives a connected upload: its storage path as the name, the project
// folder as its source, and an attachment record (uploads.cjs).
const upload = (group, base, content, attachment = {}) => ({ name: `${FOLDER}/${group}/${base}`, content, source: FOLDER,
  attachment: { id: 'a'.repeat(64), bytes: content.length, group, state: 'ready', ...attachment } });

function fixtures() {
  const a = {
    id: 'proj-a', projectFolder: FOLDER, sourceFolders: [FOLDER, 'Reference/Other'],
    files: [
      upload('Text', 'synthetic-notes.md', 'SYNTHETIC-NOTES-CANARY: the launch is on Thursday.'),
      upload('Text', 'plan.md', 'plan in the upload folder'),
      { name: 'Reference/Other/plan.md', content: 'plan from an attached folder', source: 'Reference/Other' },
      upload('Text', 'binary.txt', 'UNREADABLE-CANARY', { state: 'stored' }),
      { ...upload('Documents', 'broken.pdf', '', { state: 'failed' }), document: { state: 'failed' } },
      { name: 'local-upload.md', content: 'a local upload keeps its bare name' },
    ],
  };
  const b = { id: 'proj-b', projectFolder: 'noevia projects/Other Tenant', files: [{ name: 'noevia projects/Other Tenant/Text/secret.md', content: 'PROJECT-B-SECRET' }] };
  return { a, b };
}

function tools() {
  const { a, b } = fixtures();
  const projects = new Map([[a.id, a], [b.id, b]]);
  const { executeToolCall } = createToolboxes({
    getProject: (id) => projects.get(id) || null,
    documentSources: { notice: () => '', readPages: () => { throw new Error('no pages'); } },
  });
  const written = [];
  const internal = createInternalTools({
    getProject: (id) => projects.get(id) || null,
    diary: async () => ({}),
    // Wired exactly as index.cjs wires it: the MCP read delegates to the built-in reader.
    readProjectFile: (project, args) => executeToolCall(project, 'read_project_file', JSON.stringify(args), null),
    ragAvailable: () => false, search: async () => [],
    writeTextFile: async (project, name, text, expect) => { written.push({ project: project.id, name, text, ...(expect || {}) }); },
  });
  const read = (name, project = a) => executeToolCall(project, 'read_project_file', JSON.stringify({ name }), null);
  const mcpRead = (name, projectId = a.id) => internal.project_read_file.handler({ name }, { userId: 'alice', projectId });
  return { a, b, read, mcpRead, internal, written, executeToolCall };
}

test('an uploaded file resolves by its full stored name and by its bare name, in both readers', async () => {
  const { read, mcpRead } = tools();
  for (const name of [NOTES, 'synthetic-notes.md', 'Text/synthetic-notes.md', ` synthetic-notes.md `]) {
    for (const reader of [read, mcpRead]) {
      const out = await reader(name);
      assert.match(out, /SYNTHETIC-NOTES-CANARY/, `${name}: ${out}`);
      assert.ok(out.includes(`File "${NOTES}"`), 'the reply names the canonical file');
    }
  }
  // Composed and decomposed Unicode name the same file (a macOS keyboard sends NFD).
  const p = { files: [{ name: `${FOLDER}/Text/re\u0301sume\u0301.md`, content: 'x' }] };
  assert.equal(resolveProjectFile(p, 'r\u00e9sum\u00e9.md').file, p.files[0]);
});

test('a bare name shared by two files is refused with every candidate listed', async () => {
  const { read, mcpRead } = tools();
  for (const reader of [read, mcpRead]) {
    const out = await reader('plan.md');
    assert.match(out, /^ERROR: "plan\.md" matches more than one project file/);
    assert.ok(out.includes(`${FOLDER}/Text/plan.md`) && out.includes('Reference/Other/plan.md'), out);
    assert.doesNotMatch(out, /plan in the upload folder|plan from an attached folder/, 'no content on ambiguity');
    // The full name, or enough of it to be unique, reaches the one meant.
    assert.match(await reader(`${FOLDER}/Text/plan.md`), /plan in the upload folder/);
    assert.match(await reader('Other/plan.md'), /plan from an attached folder/);
  }
  const r = resolveProjectFile(fixtures().a, 'plan.md');
  assert.equal(r.code, 'ambiguous');
  assert.deepEqual(r.candidates, [`${FOLDER}/Text/plan.md`, 'Reference/Other/plan.md']);
});

test('traversal-shaped names are refused before any lookup, in the readers and the write tools', async () => {
  const { read, mcpRead, internal, written } = tools();
  const attempts = [
    '../synthetic-notes.md', `${FOLDER}/Text/../Text/synthetic-notes.md`, `${FOLDER}/./Text/synthetic-notes.md`,
    `/${NOTES}`, '/etc/passwd', 'C:/synthetic-notes.md', 'Text\\synthetic-notes.md', '..\\..\\synthetic-notes.md',
    '..%2Fsynthetic-notes.md', '%2e%2e/synthetic-notes.md', 'Text%5Csynthetic-notes.md', 'synthetic-notes.md%00',
    `${FOLDER}//Text/synthetic-notes.md`, 'synthetic-notes.md\u0000', 'Text/\nsynthetic-notes.md', '', '   ',
  ];
  for (const name of attempts) {
    assert.ok(invalidReason(name), `accepted ${JSON.stringify(name)}`);
    for (const reader of [read, mcpRead]) {
      const out = await reader(name);
      assert.match(out, /^ERROR: /, `${JSON.stringify(name)} -> ${out}`);
      assert.doesNotMatch(out, /SYNTHETIC-NOTES-CANARY/);
    }
    await assert.rejects(() => internal.project_append_file.handler({ name, text: 'x' }, { userId: 'alice', projectId: 'proj-a' }));
    await assert.rejects(() => internal.project_replace_text.handler({ name, find: 'launch', replace: 'x' }, { userId: 'alice', projectId: 'proj-a' }));
  }
  for (const bad of [null, 42, { name: 'x' }, ['synthetic-notes.md']]) {
    assert.match(await tools().executeToolCall(fixtures().a, 'read_project_file', JSON.stringify({ name: bad }), null), /^ERROR: .*file name is required/);
  }
  assert.deepEqual(written, [], 'nothing was written');
});

test("another project's file is not reachable by its full name or its bare name", async () => {
  const { a, read, mcpRead } = tools();
  for (const name of ['noevia projects/Other Tenant/Text/secret.md', 'secret.md', 'Text/secret.md']) {
    for (const out of [await read(name), await mcpRead(name)]) {
      assert.match(out, /^ERROR: no project file named/, out);
      assert.doesNotMatch(out, /PROJECT-B-SECRET/);
    }
  }
  // The MCP handler takes its project from the token context only; an injected argument is ignored.
  const out = await tools().internal.project_read_file.handler({ name: 'secret.md', projectId: 'proj-b' }, { userId: 'alice', projectId: a.id });
  assert.match(out, /^ERROR: no project file named/);
  assert.match(await mcpRead('secret.md', 'proj-b'), /PROJECT-B-SECRET/, 'control: the owner of project B reaches it');
});

test('unreadable files (#586) resolve by bare name but their contents are never returned', async () => {
  const { read, mcpRead } = tools();
  for (const reader of [read, mcpRead]) {
    const stored = await reader('binary.txt');
    assert.match(stored, /readable contents are unavailable/);
    assert.doesNotMatch(stored, /UNREADABLE-CANARY/);
    const failed = await reader('broken.pdf');
    assert.match(failed, /could not be read when it was added; its contents are unavailable/);
  }
});

test('the write tools edit a connected upload in place (#648) and keep refusing other path-named files', async () => {
  const { internal, written, a, read, mcpRead } = tools();
  const ctx = (stored) => ({ userId: 'alice', projectId: a.id, editTarget: require('./project-edit-target.cjs').targetDigest(stored) });
  // A connected upload, by bare name: written as its plain name with the stored path pinned, which
  // the write path turns into exactly that storage object (project-edit-in-place.test.cjs).
  await internal.project_append_file.handler({ name: 'synthetic-notes.md', text: 'Appended.' }, ctx(NOTES));
  assert.deepEqual(written.pop(), { project: a.id, name: 'synthetic-notes.md', text: 'SYNTHETIC-NOTES-CANARY: the launch is on Thursday.\nAppended.', expectName: NOTES, expectContent: 'SYNTHETIC-NOTES-CANARY: the launch is on Thursday.', expectAttachment: 'a'.repeat(64) });
  assert.match(await read('synthetic-notes.md'), /SYNTHETIC-NOTES-CANARY/, 'reading by bare name still works');
  assert.match(await mcpRead('synthetic-notes.md'), /SYNTHETIC-NOTES-CANARY/);
  // A file synced from an attached folder keeps its own message, whichever name reaches it.
  await assert.rejects(() => internal.project_append_file.handler({ name: 'Other/plan.md', text: 'x' }, ctx('Reference/Other/plan.md')), /comes from the attached folder "Reference\/Other"/);
  // A path-named file of no known origin is refused rather than written under another name.
  const odd = { id: 'odd', projectFolder: FOLDER, files: [{ name: 'Elsewhere/odd.md', content: 'x' }] };
  const t = createInternalTools({ getProject: () => odd, writeTextFile: async () => { throw new Error('must not write'); } });
  await assert.rejects(() => t.project_append_file.handler({ name: 'odd.md', text: 'y' }, { projectId: 'odd', editTarget: require('./project-edit-target.cjs').targetDigest('Elsewhere/odd.md') }), /stored under a folder path; editing it with tools isn't supported yet/);
  // Unreadable (#586) and stored-only uploads are resolved but never edited.
  await assert.rejects(() => internal.project_append_file.handler({ name: 'binary.txt', text: 'x' }, ctx(`${FOLDER}/Text/binary.txt`)), /stored in its original format/);
  await assert.rejects(() => internal.project_replace_text.handler({ name: 'broken.pdf', find: 'a', replace: 'b' }, ctx(`${FOLDER}/Documents/broken.pdf`)), /could not be read|extracted document|original format/);
  assert.deepEqual(written, [], 'nothing else was written');
  // A local upload (plain name, no storage) is still edited in place under its own name.
  await internal.project_append_file.handler({ name: 'local-upload.md', text: 'more' }, ctx('local-upload.md'));
  assert.deepEqual(written.map((w) => [w.name, w.expectName]), [['local-upload.md', 'local-upload.md']]);
  // Creating a bare name that already exists as an upload would overwrite it; refused.
  await assert.rejects(() => internal.project_create_file.handler({ name: 'synthetic-notes.md', text: 'x' }, ctx(NOTES)), /already exists/);
});

test('the tool descriptions tell the model to pass the listed name or a unique bare name', async () => {
  const core = require('./toolboxes.cjs').CORE_TOOLS.find((t) => t.function.name === 'read_project_file');
  assert.match(core.function.description, /name as listed/);
  assert.match(core.function.parameters.properties.name.description, /as listed.*if unique/);
  const { internal, a } = tools();
  assert.match(internal.project_read_file.description, /listed name .*if unique/);
  const listing = await internal.project_list_files.handler({}, { userId: 'alice', projectId: a.id });
  assert.ok(listing.includes(`${NOTES} — `), 'the listing shows the name the reader accepts verbatim');
  assert.match(listing, /exactly as shown/);
});
