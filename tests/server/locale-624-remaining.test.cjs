'use strict';
// #624: what the server supplies in English (chat status lines, Drive copy refusals, decision-service
// reasons and test messages) is worded from the catalogue by a stable id, and the chat's own lines
// (the Effort line, route names) follow the interface language. Loads the real catalogues and the
// small pure modules from source, like locale-615-626-628.test.cjs. Everything read from disk is
// under apps/web, since the Docker image holds nothing else; the server files are read as text to
// prove every id they send has a catalogue key, so a new id cannot ship untranslated.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');

const SRC = path.join(__dirname, '../../src');
const cache = {};
function load(file) {
  file = path.posix.normalize(file);
  if (cache[file]) return cache[file];
  const exports_ = {}; cache[file] = exports_;
  const code = ts.transpileModule(fs.readFileSync(path.join(SRC, file + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const here = path.posix.dirname(file);
  vm.runInNewContext(code, { exports: exports_, Intl, Map, Number, Object, console, Promise,
    require: (m) => { if (!/^\.\.?\//.test(m)) throw Error('unexpected import ' + m); return load(path.posix.join(here, m)); } });
  return exports_;
}

const core = load('i18n/core');
const FILES = { 'de-DE': 'DE_DE', 'es-ES': 'ES_ES', 'fr-FR': 'FR_FR', 'it-IT': 'IT_IT', 'nb-NO': 'NB_NO', 'nl-NL': 'NL_NL', 'pt-BR': 'PT_BR', 'sv-SE': 'SV_SE' };
load('i18n/settings/index');
for (const [locale, name] of Object.entries(FILES)) {
  core.registerCatalogue(locale, load(`i18n/${locale}`)[name]);
  core.registerSegment('settings', locale, load(`i18n/settings/${locale}`)[`${name}_SETTINGS`]);
}
const tFor = (locale) => Object.assign((key, params) => core.translate(locale, key, params), { locale, plural: (key, count, params) => core.translatePlural(locale, key, count, params) });
const { effortLineText, statusLineText, routeRoleName, senderLabelText } = load('chat-labels');
const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const has = (locale, key) => { const text = core.translate(locale, key); return !!text && text !== key; };

test('the Effort line is worded in the interface language, with the effort and its basis', () => {
  assert.equal(effortLineText(tFor('en-GB'), 'high', 'real'), 'Effort: high · provider parameter');
  assert.equal(effortLineText(tFor('en-GB'), 'low', 'hint'), 'Effort: low · best-effort hint');
  assert.equal(effortLineText(tFor('de-DE'), 'high', 'real'), 'Aufwand: hoch · Anbieterparameter');
  assert.equal(effortLineText(tFor('fr-FR'), 'default', 'hint'), 'Effort : par défaut · indication au mieux');
  assert.equal(effortLineText(tFor('de-DE'), 'turbo', 'hint'), 'Aufwand: turbo · Best-Effort-Hinweis', 'an effort this build does not know stays as the server wrote it');
});

test('a status line is worded by its id; an unknown id and an older server keep the English text', () => {
  const de = tFor('de-DE');
  assert.equal(statusLineText(de, 'generating', 'Generating response…'), 'Antwort wird erstellt …');
  assert.equal(statusLineText(de, 'loadingModel', 'Loading the selected model and checking its context allocation…'), 'Das gewählte Modell wird geladen und seine Kontextzuteilung geprüft …');
  assert.equal(statusLineText(tFor('fr-FR'), 'preparing', 'Preparing response…'), 'Préparation de la réponse…');
  assert.equal(statusLineText(de, 'somethingNew', 'Doing something new…'), 'Doing something new…', 'an id from a newer server');
  assert.equal(statusLineText(de, undefined, 'Doing something old…'), 'Doing something old…', 'an older server sends no id');
  assert.equal(statusLineText(de, undefined, undefined), '');
});

test('routes are named by their role in the interface language, not by the raw id', () => {
  assert.equal(routeRoleName(tFor('de-DE'), 'fast'), 'Schnell');
  assert.equal(routeRoleName(tFor('fr-FR'), 'smart'), core.translate('fr-FR', 'chat.route.name.smart'));
  assert.equal(routeRoleName(tFor('fr-FR'), 'code'), 'Code');
  assert.equal(routeRoleName(tFor('de-DE'), 'vision'), 'vision', 'a role it has no name for stays as it is');
  // The sender label and the route summary agree on the name.
  assert.equal(senderLabelText(tFor('de-DE'), 'Assistant · Auto (fast)'), `Auto (${routeRoleName(tFor('de-DE'), 'fast')})`);
  for (const l of Object.keys(FILES)) for (const role of ['fast', 'smart', 'code']) assert.notEqual(routeRoleName(tFor(l), role), '', `${l} ${role}`);
});

test('every status id the server sends has a catalogue key in every locale', () => {
  const ids = new Set();
  const chat = read('server/chat.cjs'), ctx = read('server/chat-context.cjs');
  for (const m of chat.matchAll(/type: 'status', id: (?:[^'?]*\? )?'(\w+)'(?: : '(\w+)')?/g)) { ids.add(m[1]); if (m[2]) ids.add(m[2]); }
  for (const m of ctx.matchAll(/onStatus\('[^']*','(\w+)'\)/g)) ids.add(m[1]);
  assert.deepEqual([...ids].sort(), ['compactingOlder', 'compactingTools', 'generating', 'loadingModel', 'preparing', 'readingImages']);
  for (const id of ids) for (const l of ['en-GB', ...Object.keys(FILES)]) assert.ok(has(l, `chat.statusId.${id}`), `${l} chat.statusId.${id}`);
  // The English catalogue text is the text the server sends, so an older client and a newer one read the same.
  const en = tFor('en-GB');
  for (const [id, text] of [['generating', 'Generating response…'], ['preparing', 'Preparing response…'], ['loadingModel', 'Loading the selected model and checking its context allocation…'],
    ['compactingTools', 'Compacting context before the next tool step… Your full transcript stays available.'], ['compactingOlder', 'Compacting older messages… Your full transcript stays available.']]) {
    assert.equal(en(`chat.statusId.${id}`), text, id);
    assert.ok(chat.includes(text) || ctx.includes(text), `the server still sends "${text}"`);
  }
});

test('every Drive copy message id the server names has a catalogue key with the params it sends', () => {
  const gdrive = read('server/gdrive.cjs');
  const seen = new Map();
  for (const m of gdrive.matchAll(/fail\([^\n]*?, (?:\d{3}|r\.status === 404 \? 404 : 502), (?:r\.status === 404 \? undefined : )?'(\w+)'(?:, (\{[^}]*\}))?\)/g)) seen.set(m[1], m[2] || '');
  assert.deepEqual([...seen.keys()].sort(), ['differentStore', 'driveAnswered', 'fileDiffers', 'staleShare', 'storeEmpty', 'tooManyStale', 'waitingFirstBackup']);
  for (const [id, params] of seen) for (const l of ['en-GB', ...Object.keys(FILES)]) {
    const text = core.translate(l, `gdrive.msg.${id}`);
    assert.notEqual(text, `gdrive.msg.${id}`, `${l} gdrive.msg.${id}`);
    for (const name of (params.match(/\b(\w+):/g) || []).map((s) => s.slice(0, -1))) assert.ok(text.includes(`{${name}}`) || id === 'staleShare' && ['stale', 'total'].includes(name) || id === 'tooManyStale' && name === 'max', `${l} ${id} uses {${name}}`);
  }
  for (const id of ['didNotFinish', 'stale']) for (const l of ['en-GB', ...Object.keys(FILES)]) assert.ok(has(l, `gdrive.msg.${id}`), `${l} gdrive.msg.${id}`);
  const de = tFor('de-DE');
  assert.equal(de('gdrive.msg.staleShare', { stale: 9, total: 20 }), 'Kopiert, aber 9 der 20 Dateien auf Drive fehlen im lokalen Speicher; zur Sicherheit wurde nichts entfernt.');
  assert.match(tFor('fr-FR')('gdrive.msg.driveAnswered', { status: 502 }), /502/);
  // The English catalogue is the English the server sends.
  assert.ok(gdrive.includes(core.translate('en-GB', 'gdrive.msg.storeEmpty')));
  assert.ok(gdrive.includes(core.translate('en-GB', 'gdrive.msg.waitingFirstBackup')));
  assert.ok(gdrive.includes(core.translate('en-GB', 'gdrive.msg.differentStore')));
});

test('decision-service reasons, test messages and refusals have a key in every locale, and the English is the server’s', () => {
  const features = read('server/features.cjs'), settings = read('server/decision-settings.cjs'), endpoint = read('server/decision-endpoint.cjs'), router = read('server/system-one-router.cjs');
  const ids = ['decisionUrl', 'decisionSetup', 'systemOneUrl'];
  for (const id of ids) assert.ok(features.includes(`'${id}'`), `features.cjs names ${id}`);
  for (const id of ids) for (const l of ['en-GB', ...Object.keys(FILES)]) assert.ok(has(l, `features.unavailable.${id}`), `${l} features.unavailable.${id}`);
  assert.ok(endpoint.includes(core.translate('en-GB', 'features.unavailable.decisionUrl')));
  assert.ok(settings.includes(core.translate('en-GB', 'features.unavailable.decisionSetup')));
  assert.ok(router.includes(core.translate('en-GB', 'features.unavailable.systemOneUrl')));
  const messageIds = [...settings.matchAll(/messageId:'(\w+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(messageIds, ['invalidInput', 'invalidUrl', 'notReady', 'ready']);
  for (const id of messageIds) {
    for (const l of ['en-GB', ...Object.keys(FILES)]) assert.ok(has(l, `decision.msg.${id}`), `${l} decision.msg.${id}`);
    assert.ok(settings.includes(core.translate('en-GB', `decision.msg.${id}`)), `the server's English for ${id} is the catalogue's`);
  }
  assert.equal(core.translate('de-DE', 'decision.msg.ready'), 'Der Entscheidungsdienst ist bereit. Es wurde keine Inferenz ausgeführt.');
});

test('the tool approval card, Code task cards and the sidebar note are catalogue text, not literals', () => {
  const tools = read('src/components/ToolCalls.tsx');
  for (const literal of ['Approval required for', 'This changes data in your account', 'Could not send the decision']) assert.ok(!tools.includes(literal), `ToolCalls.tsx still holds "${literal}"`);
  assert.doesNotMatch(tools, /\n\s+(?:Allow once|Decline|Allow for this chat)\n/, 'the three buttons are catalogue text');
  const code = read('src/components/code/CodePanel.tsx');
  for (const literal of ['Last reported plan', 'Reported plan', 'Assistant output', 'Showing the first 32 KiB', 'Not reviewed by the Planner', 'The Planner suggests accepting', 'Accept change', 'You accepted this change', 'Nobody answered in time', 'Network: nothing was requested', 'Not reported by this harness', 'tool calls ·'])
    assert.ok(!code.includes(literal), `CodePanel.tsx still holds "${literal}"`);
  assert.ok(!read('src/components/code/useActiveCodeTasks.ts').includes('setError(cause'), 'the hook no longer stores an English message');
  assert.ok(!read('src/components/Sidebar.tsx').includes('{codeTasks.error}'), 'the sidebar words its own note');
  assert.equal(core.translate('de-DE', 'code.sidebar.statusUnavailable'), 'Aufgabenstatus nicht verfügbar');
  assert.equal(core.translate('fr-FR', 'chat.approval.ask'), 'Autoriser l’exécution de {name} ? Cela modifie des données de votre compte.');
  assert.equal(core.translate('de-DE', 'chat.approval.ask'), '{name} ausführen lassen? Das ändert Daten in deinem Konto.');
  assert.equal(core.translatePlural('de-DE', 'code.task.result.tools', 1, { count: '1' }), '1 Werkzeugaufruf');
  assert.equal(core.translate('de-DE', 'code.task.result', { tools: '3 Werkzeugaufrufe', allowed: 3, declined: 0, refused: 1 }), '3 Werkzeugaufrufe · 3 erlaubt · 0 abgelehnt · 1 von noevia verweigert');
});
