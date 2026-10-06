const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../src/source-status.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: exportsObject });
const { sourceStatus, sourceRefreshIssues, sourceRefreshEntries, skippedSignature, resolveSkippedToast, isUnreadableSource } = exportsObject;
test('source rows distinguish partial, new failure and stale text', () => {
  assert.match(sourceStatus({ document: { state: 'partial', pages: 2, pageStatus: [{number: 2, status:'ocr-needed'}] } }), /Partially extracted.*check pages 2/);
  assert.match(sourceStatus({ document: { state: 'failed', stale: false } }), /Not readable/);
  assert.match(sourceStatus({ document: { state: 'failed', stale: true } }), /using previous text/);
});
test('refresh errors name every affected file and only claim retention when true', () => {
  const text = sourceRefreshIssues([{folder:'f',file:'new.pdf',reason:'OCR needed',retained:false},{folder:'f',file:'old.pdf',reason:'unavailable',retained:true}]);
  assert.match(text, /new.pdf: OCR needed\nold.pdf: unavailable Previous readable text retained/);
});

const a = { folder: 'Notes', file: 'a.pdf', reason: 'Too large' };
const b = { folder: 'Notes', reason: 'Folder unreadable', retained: true };

test('sourceRefreshEntries renders one line per skipped source (for list rendering)', () => {
  assert.deepEqual(sourceRefreshEntries([a, b]), ['a.pdf: Too large', 'Notes: Folder unreadable Previous readable text retained.']);
  assert.equal(sourceRefreshIssues([a, b]), 'a.pdf: Too large\nNotes: Folder unreadable Previous readable text retained.');
});

test('skippedSignature is order-independent and empty for no entries', () => {
  assert.equal(skippedSignature([]), '');
  assert.equal(skippedSignature([a, b]), skippedSignature([b, a]));
  assert.notEqual(skippedSignature([a]), skippedSignature([b]));
});

test('resolveSkippedToast: same skipped set does not re-show the toast', () => {
  const sig = skippedSignature([a, b]);
  const msg = sourceRefreshIssues([a, b]);
  const r = resolveSkippedToast({ signature: sig, message: msg }, [a, b], msg);
  assert.equal(r.signature, sig);
  assert.equal(r.show, undefined);
});

test('resolveSkippedToast: a changed skipped set shows the new message', () => {
  const prevSig = skippedSignature([a]);
  const r = resolveSkippedToast({ signature: prevSig, message: sourceRefreshIssues([a]) }, [a, b], sourceRefreshIssues([a]));
  assert.equal(r.signature, skippedSignature([a, b]));
  assert.equal(r.show, sourceRefreshIssues([a, b]));
});

test('resolveSkippedToast: a clean refresh clears a previously-shown toast that is still the one on screen', () => {
  const prevSig = skippedSignature([a]);
  const prevMsg = sourceRefreshIssues([a]);
  const r = resolveSkippedToast({ signature: prevSig, message: prevMsg }, [], prevMsg);
  assert.equal(r.signature, '');
  assert.equal(r.show, null);
});

test('resolveSkippedToast: a clean refresh does NOT clear an unrelated error currently on screen', () => {
  const prevSig = skippedSignature([a]);
  const prevMsg = sourceRefreshIssues([a]);
  const r = resolveSkippedToast({ signature: prevSig, message: prevMsg }, [], 'Some unrelated project error.');
  assert.equal(r.show, undefined);
});

test('resolveSkippedToast: nothing to show and nothing previously shown is a no-op', () => {
  const r = resolveSkippedToast({ signature: '', message: '' }, [], null);
  assert.equal(r.signature, '');
  assert.equal(r.show, undefined);
});
test('#577: an accepted upload with no readable text is never reported as saved', () => {
  const { uploadUnreadableReason } = exportsObject;
  assert.match(uploadUnreadableReason({ attachment: { state: 'stored', group: 'Text', reason: 'This file is not readable as text' } }), /^Not readable · This file is not readable/);
  assert.match(uploadUnreadableReason({ document: { state: 'failed', error: 'worker refused' } }), /Not readable · worker refused/);
  assert.equal(uploadUnreadableReason({ attachment: { state: 'ready', group: 'Text' } }), '');
  assert.equal(uploadUnreadableReason({ attachment: { state: 'stored', group: 'Other' } }), '');
  assert.equal(uploadUnreadableReason({ attachment: { state: 'vision', group: 'Images' } }), '');
});

test('isUnreadableSource mirrors the server predicate (#586)', () => {
  const serverSide = require('../../server/source-readability.cjs').isUnreadable;
  const cases = [
    { name: 'b.txt', content: '', attachment: { state: 'stored', group: 'Text', bytes: 4 } },
    { name: 'ok.txt', content: 'x', attachment: { state: 'ready', group: 'Text', bytes: 1 } },
    { name: 'a.pdf', content: '', document: { state: 'failed' } },
    { name: 'a.pdf', content: 'earlier', document: { state: 'failed', stale: true } },
    { name: 'i.png', content: '', attachment: { state: 'vision', group: 'Images', bytes: 1 } },
    { name: 'legacy.md', content: 'text' },
  ];
  for (const c of cases) assert.equal(isUnreadableSource(c), serverSide(c), c.name);
  assert.equal(isUnreadableSource(cases[0]), true);
});

test('Sources lists unreadable originals apart from Text and leaves them out of the count (#586)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/components/ProjectView.tsx'), 'utf8');
  assert.match(src, /const readableFiles = project\.files\.filter\(\(f\) => !isUnreadableSource\(f\)\)/);
  assert.match(src, /const sourceCount = readableFiles\.length/);
  assert.match(src, /readableFiles\.filter\(f => fileGroup\(f\) === group\)/);
  assert.match(src, /unreadableFiles\.map\(renderFile\)/);
});

test('Sources notice and disclosure summaries use the caption token, not the 16px default (#588)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/styles/noevia.css'), 'utf8');
  const rule = /\.project-sources summary,[^{]*\.instruction-skills p[^{]*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'rule present');
  assert.match(rule[1], /font-size:\s*var\(--text-caption\)/);
});

test('a not-readable reason is worded by the catalogue from its id, and old files still translate (#607)', () => {
  const { uploadUnreadableReason, attachmentReason, documentError } = exportsObject;
  const t = (key, params) => `[${key}${params ? JSON.stringify(params) : ''}]`;
  assert.equal(uploadUnreadableReason({ attachment: { state: 'stored', group: 'Text', reason: 'English text', reasonId: 'binaryText' } }, t), '[projects.view.notReadable] · [projects.view.reason.binaryText]');
  // Stored before ids existed: only the exact sentence noevia wrote is recognised.
  assert.equal(attachmentReason({ reason: 'This file is not readable as text — it looks like binary data despite its extension. The original is kept.' }, t), '[projects.view.reason.binaryText]');
  assert.equal(attachmentReason({ reason: 'Not valid UTF-8; read as windows-1252. Characters outside that encoding may be wrong — re-save the file as UTF-8 if anything looks mangled.' }, t), '[projects.view.reason.encoding{"encoding":"windows-1252"}]');
  assert.equal(attachmentReason({ reasonId: 'docxPartialLimit', reason: 'x' }, t), '[projects.view.reason.docxPartial] [projects.view.reason.limitReached]');
  // Text from a library or another service has no id: it is shown as sent.
  assert.equal(attachmentReason({ reason: 'zip exploded' }, t), 'zip exploded');
  assert.equal(attachmentReason({ reasonId: 'someFutureId', reason: 'zip exploded' }, t), 'zip exploded');
  assert.equal(documentError({ error: 'x', errorId: 'noOcrText' }, t), '[projects.view.reason.noOcrText]');
  assert.equal(uploadUnreadableReason({ document: { state: 'failed', error: 'worker refused' } }, t), '[projects.view.notReadable] · worker refused');
  assert.match(sourceStatus({ document: { state: 'failed', errorId: 'noNativeText', error: 'x' } }, t), /^\[projects\.view\.notReadable\] · \[projects\.view\.reason\.noNativeText\]/);
  // Without a translator nothing changes for English callers.
  assert.equal(attachmentReason({ reason: 'English text', reasonId: 'binaryText' }), 'English text');
});

test('a native-text fallback page shows the document as partially extracted, with the reason (#700)', () => {
  const t = (key, params) => `[${key}${params ? JSON.stringify(params) : ''}]`;
  const doc = { state: 'partial', pages: 3, pageStatus: [{ number: 1, status: 'native' }, { number: 2, status: 'degraded', reason: 'native-fallback' }, { number: 3, status: 'blank' }] };
  const english = sourceStatus({ document: doc });
  assert.match(english, /^Partially extracted · 3 pages · check pages 2 · pages 2: layout analysis found no text, so the PDF's own text layer was used/);
  assert.doesNotMatch(english, /ready/i, 'never plain ready');
  assert.equal(sourceStatus({ document: doc }, t), '[projects.view.partiallyExtracted] · 3 pages · check pages 2 · [projects.view.reason.nativeFallback{"pages":"2"}]');
  // A server that cached state 'ready' alongside a degraded page still reads as partial.
  assert.match(sourceStatus({ document: { ...doc, state: 'ready' } }, t), /^\[projects\.view\.partiallyExtracted\]/);
  // Blank pages alone are complete: the document stays ready and gets no fallback note.
  const blankOnly = sourceStatus({ document: { state: 'ready', pages: 2, pageStatus: [{ number: 1, status: 'native' }, { number: 2, status: 'blank' }] } }, t);
  assert.equal(blankOnly, 'Native text ready · 2 pages');
});
