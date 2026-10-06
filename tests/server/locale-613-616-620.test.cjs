'use strict';
// #613 #614 #615 #616 #620 (live tester round 7): the words the interface printed in English on a
// German or French page, the French "1 définis" plural, and the label cut that lost a space.
// Loads the catalogues and the small pure modules from source, the way i18n.test.cjs does.
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
load('i18n/models/index');
core.registerCatalogue('de-DE', load('i18n/de-DE').DE_DE);
core.registerCatalogue('fr-FR', load('i18n/fr-FR').FR_FR);
core.registerSegment('models', 'de-DE', load('i18n/models/de-DE').DE_DE_MODELS);
core.registerSegment('models', 'fr-FR', load('i18n/models/fr-FR').FR_FR_MODELS);
const EN = load('i18n/en-GB').EN_GB;
const EN_MODELS = load('i18n/models/en-GB').EN_GB_MODELS;
const tFor = (locale) => (key, params) => core.translate(locale, key, params);
const { splitMiddle, TAIL } = load('middle-split');
const { describeBackendError, backendErrorId } = load('components/models/backend-errors');
const { toolboxCopy, TOOLBOX_DESCRIPTION_IDS, TOOLBOX_LABEL_IDS } = load('toolbox-copy');
const { routeDescription, ROUTE_ROLE_IDS } = load('routing-copy');
const { formatNumber } = load('number-format');

test('#620 a label is cut without losing the space at the cut', () => {
  const label = 'Compagnon de journal';
  const parts = splitMiddle(label);
  assert.equal(parts.head + parts.tail, label, 'head and tail always join back into the label');
  assert.equal(parts.tail.length, TAIL);
  // The tester's case: the cut falls on the space between "Compagnon" and "de journal".
  assert.equal(parts.head, 'Compagnon ');
  assert.equal(parts.tail, 'de journal');
  // A space at the start of the tail as well as the end of the head.
  for (const text of ['Modèle de langue local rapide', 'A very long model name with spaces here', 'Assistant du journal intime']) {
    const p = splitMiddle(text);
    assert.equal(p.head + p.tail, text);
  }
  assert.equal(splitMiddle('Diary companion'), null, 'a short label is shown whole');
  assert.equal(splitMiddle('x'.repeat(TAIL + 6)), null);
  assert.notEqual(splitMiddle('x'.repeat(TAIL + 7)), null);
});

test('#620 the stylesheet keeps the space at the cut visible (flex items collapse edge whitespace otherwise)', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles/phone.css'), 'utf8');
  for (const selector of ['.mid-trunc-head', '.mid-trunc-tail']) {
    const rule = css.split('\n').find((l) => l.startsWith(selector + ' {'));
    assert.ok(rule, `${selector} rule exists`);
    assert.match(rule, /white-space:\s*pre\b/, `${selector} must keep the space: ${rule}`);
  }
  const component = fs.readFileSync(path.join(SRC, 'components/MiddleTruncate.tsx'), 'utf8');
  assert.match(component, /splitMiddle\(text\)/);
});

test('#613 French and other singular forms of the Advanced group counter', () => {
  assert.equal(core.translatePlural('fr-FR', 'mm.editor.set', 1), '1 défini');
  assert.equal(core.translatePlural('fr-FR', 'mm.editor.set', 0), '0 défini', 'French treats 0 as singular');
  assert.equal(core.translatePlural('fr-FR', 'mm.editor.set', 2), '2 définis');
  assert.equal(core.translatePlural('de-DE', 'mm.editor.set', 1), '1 gesetzt');
  assert.equal(core.translatePlural('en-GB', 'mm.editor.set', 1), '1 set');
  assert.ok(!('mm.editor.set' in EN_MODELS), 'the old single form is gone');
  const source = fs.readFileSync(path.join(SRC, 'components/models/ConfigureTab.tsx'), 'utf8');
  assert.match(source, /t\.plural\('mm\.editor\.set'/);
});

test('#613 a stopped engine\'s raw service notes read in the interface language; unknown ones stay raw', () => {
  const de = tFor('de-DE'), fr = tFor('fr-FR');
  assert.equal(describeBackendError(de, 'container is exited'), 'Container ist beendet');
  assert.equal(describeBackendError(fr, 'container is exited'), 'le conteneur est arrêté');
  assert.equal(describeBackendError(de, 'connection refused'), 'Verbindung abgelehnt');
  assert.equal(describeBackendError(fr, 'HTTP 503'), 'erreur HTTP 503');
  assert.equal(describeBackendError(fr, 'warming up…'), 'préparation…');
  assert.equal(describeBackendError(de, 'sampler error: boom'), 'sampler error: boom', 'an unknown message is shown as sent');
  assert.equal(describeBackendError(de, 'container is teleporting'), 'container is teleporting');
  assert.equal(describeBackendError(de, null), '');
  assert.equal(backendErrorId('container is dead'), 'container.dead');
  // Every state the model manager can send has wording, in every locale that ships.
  const states = ['exited', 'created', 'paused', 'restarting', 'dead', 'removing'];
  for (const state of states) for (const locale of ['de-DE', 'fr-FR']) {
    const text = describeBackendError(tFor(locale), `container is ${state}`);
    assert.doesNotMatch(text, /^container is/, `${locale} ${state}`);
  }
  // The strings the service sends today. The list is a fixture (the web image has no services/ folder);
  // services/model-manager/tests/test_api.py keeps it equal to hw.py and services.py.
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/model-manager-backend-notes.json'), 'utf8'));
  assert.ok(fixture.notes.length >= 9);
  for (const raw of fixture.notes) {
    assert.notEqual(backendErrorId(raw), null, raw);
    assert.notEqual(describeBackendError(de, raw), raw, `${raw} is translated`);
  }
  for (const soft of fixture.soft) assert.equal(backendErrorId(soft), null, `${soft} is a soft note, shown as sent`);
});

test('#613 the hardware and overview tabs go through describeBackendError', () => {
  const hardware = fs.readFileSync(path.join(SRC, 'components/models/HardwareTab.tsx'), 'utf8');
  assert.match(hardware, /describeBackendError\(t, b\.stats\.error\)/);
  assert.match(hardware, /describeBackendError\(t, b\.probe_error\)/);
  assert.doesNotMatch(hardware, /error: b\.stats\.error \?\? ''/);
  const overview = fs.readFileSync(path.join(SRC, 'components/models/OverviewTab.tsx'), 'utf8');
  assert.match(overview, /describeBackendError\(t, b\.probe_error\)/);
});

test('#616 route descriptions come from the catalogue by role id; scores use the locale decimal separator', () => {
  const de = tFor('de-DE'), fr = tFor('fr-FR');
  for (const id of ROUTE_ROLE_IDS) {
    assert.ok(`chat.route.desc.${id}` in EN, `English has chat.route.desc.${id}`);
    assert.notEqual(routeDescription(de, id, 'server text'), 'server text');
    assert.notEqual(routeDescription(de, id, 'x'), EN[`chat.route.desc.${id}`], `${id} is not English in German`);
    assert.notEqual(routeDescription(fr, id, 'x'), EN[`chat.route.desc.${id}`], `${id} is not English in French`);
  }
  assert.equal(routeDescription(de, 'fast', 'Greetings, thanks, or a one-line factual answer'), 'Begrüßungen, Dank oder eine einzeilige sachliche Antwort');
  assert.equal(routeDescription(de, 'custom-role', 'Server text'), 'Server text', 'an unknown id keeps the server text');
  assert.equal(formatNumber(0.5894, 'de-DE', { max: 4 }), '0,5894');
  assert.equal(formatNumber(0.1361, 'fr-FR', { max: 4 }), '0,1361');
  assert.equal(formatNumber(0.5894, 'en-GB', { max: 4 }), '0.5894');
  const chat = fs.readFileSync(path.join(SRC, 'components/ChatView.tsx'), 'utf8');
  assert.match(chat, /formatNumber\(scores\[option\.id\], t\.locale, \{ max: 4 \}\)/);
  assert.doesNotMatch(chat, /String\(scores\[option\.id\]\)/);
  // The server sends these ids with English descriptions; the ids are what the client keys on.
  const router = fs.readFileSync(path.join(__dirname, '../../server/system-one-router.cjs'), 'utf8');
  for (const id of ROUTE_ROLE_IDS) assert.match(router, new RegExp(`id: '${id}'`));
});

test('#615 built-in toolsets are worded from the catalogue by box id; third-party boxes keep the server text', () => {
  const fr = tFor('fr-FR'), de = tFor('de-DE');
  const core_ = { id: 'core', source: 'builtin', label: 'Core', description: "Always-safe built-ins: the server clock, and full reads of this project's knowledge files." };
  assert.equal(toolboxCopy(de, core_).label, 'Kern');
  assert.match(toolboxCopy(fr, core_).description, /horloge du serveur/);
  assert.equal(toolboxCopy(tFor('en-GB'), core_).description, core_.description, 'English is the server text');
  const mcp = { id: 'core', source: 'mcp', label: 'Core', description: 'A third-party server described it this way.' };
  assert.deepEqual({ ...toolboxCopy(de, mcp) }, { label: mcp.label, description: mcp.description });
  const unknown = { id: 'brand-new-box', source: 'builtin', label: 'Brand new', description: 'Not in the catalogue yet.' };
  assert.deepEqual({ ...toolboxCopy(de, unknown) }, { label: 'Brand new', description: 'Not in the catalogue yet.' });
  const nc = { id: 'nextcloud-notes', source: 'builtin', label: 'Nextcloud Notes', description: 'Search, read, create and edit notes.' };
  assert.equal(toolboxCopy(de, nc).label, 'Nextcloud Notes', 'a product name is not translated');
  assert.equal(toolboxCopy(de, nc).description, 'Notizen durchsuchen, lesen, erstellen und bearbeiten.');
  for (const id of TOOLBOX_DESCRIPTION_IDS) assert.ok(`toolbox.desc.${id}` in EN, `toolbox.desc.${id}`);
  for (const id of TOOLBOX_LABEL_IDS) assert.ok(`toolbox.label.${id}` in EN, `toolbox.label.${id}`);
});

test('#615 every built-in toolbox the server defines has a translated description, and English matches the server text', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '../../server/mcp-toolbox-manifest.cjs'), 'utf8');
  const toolboxes = fs.readFileSync(path.join(__dirname, '../../server/toolboxes.cjs'), 'utf8');
  const ids = [...manifest.matchAll(/^ {4}id: '([\w-]+)',/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 20, `found ${ids.length} manifest boxes`);
  for (const id of [...ids, 'core']) assert.ok(TOOLBOX_DESCRIPTION_IDS.includes(id), `${id} has no description key`);
  for (const [id, label] of [...manifest.matchAll(/^ {4}id: '([\w-]+)',[\s\S]*?^ {4}label: '([^']*)',[\s\S]*?^ {4}description: (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),/gm)].map((m) => [m[1], m[3] ?? m[4]])) {
    assert.equal(EN[`toolbox.desc.${id}`], label.replace(/\\'/g, "'"), `English toolbox.desc.${id} matches the server description`);
  }
  assert.match(toolboxes, /description: 'Always-safe built-ins: the server clock, and full reads of this project\\'s knowledge files\.'/);
  assert.equal(EN['toolbox.desc.core'], "Always-safe built-ins: the server clock, and full reads of this project's knowledge files.");
});

test('#615 the chat message controls, offline banner, scope line and tools menu use the catalogue', () => {
  const chat = fs.readFileSync(path.join(SRC, 'components/ChatView.tsx'), 'utf8');
  for (const english of ['Save &amp; re-run', '>Cancel<', 'Everything after this message is replaced.', 'Edit this message and re-run', 'Inference is unreachable',
    'What noevia gave the model', 'Using: {m', 'Skill: {m', 'aria-label="Edit']) assert.ok(!chat.includes(english), `ChatView still hard-codes ${english}`);
  for (const key of ['chat.edit.save', 'chat.edit.note', 'chat.edit.title', 'chat.edit.aria', 'chat.edit.inputAria', 'chat.offline.text', 'chat.offline.check', 'chat.scope.title', 'chat.scope.using', 'chat.scope.skill'])
    assert.ok(chat.includes(`'${key}'`), `ChatView uses ${key}`);
  for (const file of ['ComposerActions', 'ToolCatalogue', 'ModelPopup'])
    assert.match(fs.readFileSync(path.join(SRC, `components/${file}.tsx`), 'utf8'), /toolboxCopy\(t, /, `${file} words toolsets from the catalogue`);
  // The offline sentence keeps the Settings link where the language puts it.
  for (const locale of ['de-DE', 'fr-FR', 'en-GB']) assert.match(core.translate(locale, 'chat.offline.check', { settings: '@@' }), /@@/);
  // The Auto pill.
  assert.equal(core.translate('de-DE', 'composer.autoFastSmart'), 'Auto (Schnell/Smart)');
  assert.match(fs.readFileSync(path.join(SRC, 'components/ComposerModel.tsx'), 'utf8'), /t\('composer\.autoFastSmart'\)/);
});

test('#614 the Instruction Skills block has no hard-coded English left', () => {
  const source = fs.readFileSync(path.join(SRC, 'components/InstructionSkills.tsx'), 'utf8');
  for (const english of ['Review required', 'Needs correction', 'Add an instruction skill', 'Reusable Markdown instructions', 'Enable this version',
    'Reviewed versions apply', 'Reload current version', 'Uploaded to this project', 'Required toolboxes not selected', 'Some instruction files need review'])
    assert.ok(!source.includes(english), `InstructionSkills still hard-codes "${english}"`);
  assert.match(source, /useT\(\)/);
  const keys = [...source.matchAll(/'(projects\.skills\.[\w.]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 25);
  for (const key of new Set(keys)) assert.ok(key in EN, `${key} is in the English catalogue`);
  for (const key of Object.keys(EN).filter((k) => k.startsWith('projects.skills.') && !k.startsWith('projects.skills.status.'))) assert.ok(keys.includes(key) || source.includes(key.slice(0, key.lastIndexOf('.'))), `${key} is used`);
  const de = tFor('de-DE');
  assert.equal(de('projects.skills.heading', { count: 1 }), 'Anweisungs-Skills (1)');
  assert.equal(de('projects.skills.status.review'), 'Prüfung erforderlich');
  assert.equal(de('projects.skills.origin.publishedOn', { publisher: 'X', path: ' (a/b)', date: '2026-09-01' }), 'Veröffentlicht von X (a/b), am 2026-09-01 kopiert');
  assert.equal(tFor('fr-FR')('projects.skills.disable'), 'Désactiver');
});
