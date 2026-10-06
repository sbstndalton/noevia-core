'use strict';
// #615 (round 9: the coding harness and the unavailable reasons), #634 (the Stopped placeholder is
// language-neutral), #635 (preferences are an external store), #636 (byte sizes in the locale's units)
// and #637 (the Diary in the phone-layout preview). Loads the real catalogues and the small pure modules
// from source, like locale-615-626-628.test.cjs. Everything read from disk is under apps/web.
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
const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

const core = load('i18n/core');
const FILES = { 'de-DE': 'DE_DE', 'es-ES': 'ES_ES', 'fr-FR': 'FR_FR', 'it-IT': 'IT_IT', 'nb-NO': 'NB_NO', 'nl-NL': 'NL_NL', 'pt-BR': 'PT_BR', 'sv-SE': 'SV_SE' };
for (const [locale, name] of Object.entries(FILES)) core.registerCatalogue(locale, load(`i18n/${locale}`)[name]);
const EN = load('i18n/en-GB').EN_GB;
const LOCALES = ['en-GB', ...Object.keys(FILES)];
const tFor = (locale) => Object.assign((key, params) => core.translate(locale, key, params), { locale });
const plain = (s) => s.replace(/[  ]/g, ' ');

// ── #615: the coding harness and the reasons, worded by code ────────────────────────────────────────
const { toolboxCopy, isInAppBox, toolReasonText, toolDescriptionText, TOOL_REASON_CODES, CODE_TOOL_NAMES, TOOLBOX_LABEL_IDS, TOOLBOX_DESCRIPTION_IDS } = load('toolbox-copy');

test('#615 the coding harness box is an in-app box, worded by id, even from a server that omits the flag', () => {
  assert.ok(TOOLBOX_LABEL_IDS.includes('code') && TOOLBOX_DESCRIPTION_IDS.includes('code'));
  assert.equal(isInAppBox({ source: 'code' }), true);
  assert.equal(isInAppBox({ source: 'code', inApp: false }), false, 'an explicit flag wins');
  const box = { id: 'code', label: 'Coding harness', description: 'Read, edit and run commands in a registered repository. Every edit and command asks first.', source: 'code', inApp: true };
  for (const locale of Object.keys(FILES)) {
    const copy = toolboxCopy(tFor(locale), box);
    assert.notEqual(copy.label, box.label, `${locale} label`);
    assert.notEqual(copy.description, box.description, `${locale} description`);
  }
});

test('#615 every reason the server sends has a code, and every code a catalogue string in every locale', () => {
  const { REASONS } = require('../../server/toolboxes-permitted.cjs');
  assert.deepEqual(Object.keys(REASONS).sort(), [...TOOL_REASON_CODES].sort(), 'the client knows exactly the codes the server sends');
  for (const code of TOOL_REASON_CODES) {
    assert.equal(EN[`tools.reason.${code}`], REASONS[code], `English catalogue text matches the server fallback for ${code}`);
    for (const locale of Object.keys(FILES)) assert.notEqual(core.translate(locale, `tools.reason.${code}`), EN[`tools.reason.${code}`], `${locale} ${code}`);
  }
  for (const name of CODE_TOOL_NAMES) for (const locale of Object.keys(FILES)) assert.ok(core.translate(locale, `toolbox.tool.${name}`) && core.translate(locale, `toolbox.tool.${name}`) !== `toolbox.tool.${name}`, `${locale} ${name}`);
});

test('#615 a reason is worded from its code; an unknown code or none keeps the server text; only the harness tools are re-worded', () => {
  const de = tFor('de-DE');
  assert.equal(toolReasonText(de, 'codeNeedsCowork', 'Switch this session to Cowork to use the coding harness.'), core.translate('de-DE', 'tools.reason.codeNeedsCowork'));
  assert.equal(toolReasonText(de, 'a-future-code', 'Server words'), 'Server words');
  assert.equal(toolReasonText(de, null, 'Server words'), 'Server words');
  assert.equal(toolReasonText(de, null, null), null);
  assert.equal(toolDescriptionText(de, 'code', true, 'edit_file', 'Change files on a task branch.'), core.translate('de-DE', 'toolbox.tool.edit_file'));
  assert.equal(toolDescriptionText(de, 'diary', true, 'diary_read', 'Server words'), 'Server words', 'an MCP tool keeps its server wording');
  assert.equal(toolDescriptionText(de, 'code', false, 'edit_file', 'Theirs'), 'Theirs', 'a box that is not in-app is never re-worded');
});

test('#615 the composer menu words the boxes and reasons through the shared helpers', () => {
  const src = read('src/components/ToolCatalogue.tsx');
  assert.match(src, /toolReasonText\(t, box\.reasonCode, box\.reason\)/);
  assert.match(src, /toolDescriptionText\(/);
  assert.match(read('src/tool-catalogue.ts'), /inApp\?: boolean/);
});

// ── #634: the Stopped placeholder ────────────────────────────────────────────────────────────────
const { STOPPED_SENDER, LEGACY_STOPPED_BODIES, isStoppedPlaceholder, messageBodyText, senderLabelText } = load('chat-labels');

test('#634 a stopped reply is stored as a token and worded when drawn, in the language active then', () => {
  const stopped = { role: 'assistant', senderLabel: STOPPED_SENDER, content: '' };
  assert.equal(STOPPED_SENDER, 'Stopped');
  assert.equal(isStoppedPlaceholder(stopped), true);
  for (const locale of LOCALES) assert.equal(messageBodyText(tFor(locale), stopped), core.translate(locale, 'chat.stopped.content'), locale);
  assert.equal(messageBodyText(tFor('en-GB'), stopped), 'Stopped before a reply was written.');
  // The same stored reply reads differently in each language, with nothing language-specific stored.
  assert.notEqual(messageBodyText(tFor('de-DE'), stopped), messageBodyText(tFor('en-GB'), stopped));
});

test('#634 a reply saved by the old build (the sentence itself as the body) is recognised in every locale', () => {
  for (const locale of LOCALES) {
    const saved = { role: 'assistant', senderLabel: STOPPED_SENDER, content: core.translate(locale, 'chat.stopped.content') };
    assert.equal(isStoppedPlaceholder(saved), true, `${locale} row`);
    assert.equal(messageBodyText(tFor('fr-FR'), saved), core.translate('fr-FR', 'chat.stopped.content'), `${locale} row drawn in French`);
    assert.ok(LEGACY_STOPPED_BODIES.includes(core.translate(locale, 'chat.stopped.content')), `${locale}: the list must hold the catalogue's sentence — keep the old one when the text changes`);
  }
});

test('#634 only a stopped assistant reply with no real content is a placeholder', () => {
  const t = tFor('de-DE');
  assert.equal(isStoppedPlaceholder({ role: 'assistant', senderLabel: 'Assistant · Stopped', content: '' }), true);
  assert.equal(isStoppedPlaceholder({ role: 'assistant', senderLabel: STOPPED_SENDER, content: 'A partial answer the model had written.' }), false);
  assert.equal(isStoppedPlaceholder({ role: 'assistant', senderLabel: STOPPED_SENDER, content: '', reasoning: 'thought before Stop' }), false);
  assert.equal(isStoppedPlaceholder({ role: 'assistant', senderLabel: 'Auto (fast)', content: '' }), false, 'an empty reply that was not stopped is not one');
  assert.equal(isStoppedPlaceholder({ role: 'user', senderLabel: STOPPED_SENDER, content: '' }), false);
  assert.equal(isStoppedPlaceholder({ role: 'assistant', senderLabel: STOPPED_SENDER, content: 'x', error: true }), false);
  assert.equal(messageBodyText(t, { role: 'assistant', senderLabel: 'Auto (fast)', content: 'Hello' }), 'Hello');
  assert.equal(senderLabelText(t, STOPPED_SENDER), core.translate('de-DE', 'chat.stopped.sender'), 'the sender label still maps through the catalogue');
});

test('#634 Stop no longer writes a translated sentence into the message, and the transcript draws through the helper', () => {
  const app = read('src/App.tsx');
  assert.match(app, /senderLabel: STOPPED_SENDER/);
  assert.doesNotMatch(app, /translateNow\('chat\.stopped\.content'\)/);
  const view = read('src/components/ChatView.tsx');
  assert.match(view, /messageBodyText\(t, m\)/);
  // The saved history the server replays to the model drops an empty body, so a stopped reply is no longer replayed as a sentence.
  assert.match(read('server/chat.cjs'), /typeof h\.content === 'string' && h\.content\)/);
});

// ── #635: every component re-reads the preferences ──────────────────────────────────────────────
test('#635 useAccountPreferences reads an external store, so no component can miss the account\'s answer', () => {
  const src = read('src/user-preferences.ts');
  assert.match(src, /useSyncExternalStore\(subscribePreferences, currentPreferences, currentPreferences\)/);
  assert.doesNotMatch(src, /useState\(/, 'a useState copy taken at render is what missed the update');
  assert.match(src, /export function currentPreferences\(\): AccountPreferences \{ return current; \}/, 'the snapshot is the stored object, stable until the preferences change');
});

// ── #636: byte sizes ────────────────────────────────────────────────────────────────────────────
const nf = load('number-format');

test('#636 binary units have locale names: Kio/Mio/Gio/Tio in French, IEC symbols elsewhere', () => {
  for (const [locale, gib, kib] of [['fr-FR', 'Gio', 'Kio'], ['fr-CA', 'Gio', 'Kio'], ['de-DE', 'GiB', 'KiB'], ['en-GB', 'GiB', 'KiB'], ['es-ES', 'GiB', 'KiB'], [undefined, 'GiB', 'KiB']]) {
    assert.equal(nf.binaryUnitLabel('GiB', locale), gib, String(locale));
    assert.equal(nf.binaryUnitLabel('KiB', locale), kib, String(locale));
  }
  assert.equal(nf.binaryUnitLabel('B', 'fr-FR'), 'o');
  assert.equal(plain(nf.formatBinaryUnit(6.64, 'GiB', 'fr-FR')), '6,64 Gio');
  assert.equal(plain(nf.formatBinaryUnit(6.64, 'GiB', 'de-DE')), '6,64 GiB');
  assert.equal(nf.formatBinaryUnit(6.64, 'GiB', 'en-GB'), '6.64 GiB');
  assert.equal(plain(nf.formatBinaryUnit(32, 'KiB', 'fr-FR', 0)), '32 Kio');
  assert.equal(plain(nf.formatBinaryUnit(14, 'GiB', 'fr-FR', { max: 2 })), '14 Gio');
  assert.equal(plain(nf.formatBinaryBytes(1.5 * 1024 ** 3, 'fr-FR')), '1,5 Gio');
  assert.equal(plain(nf.formatBinaryBytes(2 * 1024, 'de-DE')), '2 KiB');
  assert.equal(plain(nf.formatBinaryBytes(0, 'en-GB')), '0 B');
});

test('#636 decimal sizes use the locale unit, and formatBytes reaches terabytes', () => {
  assert.equal(plain(nf.formatSizeUnit(3.3, 'GB', 'fr-FR', 1)), '3,3 Go');
  assert.equal(plain(nf.formatSizeUnit(3.3, 'GB', 'de-DE', 1)), '3,3 GB');
  assert.equal(plain(nf.formatSizeUnit(5.3, 'TB', 'fr-FR', 1)), '5,3 To');
  assert.equal(plain(nf.formatBytes(5.3 * 1024 ** 4, 'fr-FR')), '5,3 To');
  assert.equal(plain(nf.formatBytes(7.3 * 1024 ** 4, 'de-DE')), '7,3 TB');
  assert.equal(plain(nf.formatBytes(5.3 * 1024 ** 4, 'en-GB')), '5.3 TB');
});

test('#636 a size the server only sent as text is localised as a fallback: number and unit', () => {
  const s = (text, locale) => plain(nf.localizeSizeText(text, locale));
  assert.equal(s('5.3 TB', 'fr-FR'), '5,3 To');
  assert.equal(s('139.7 GB', 'fr-FR'), '139,7 Go');
  assert.equal(s('652 KB', 'fr-FR'), '652 ko');
  assert.equal(s('10.5 MB/s', 'fr-FR'), '10,5 Mo/s');
  assert.equal(s('14 GiB', 'fr-FR'), '14 Gio');
  assert.equal(s('512 B', 'fr-FR'), '512 o');
  assert.equal(s('5.3 TB', 'de-DE'), '5,3 TB');
  assert.equal(s('5.3 TB', 'en-GB'), '5.3 TB');
  assert.equal(s('1m', 'fr-FR'), '1m', 'a duration keeps going through the leading-number path');
  assert.equal(s('—', 'fr-FR'), '—');
  assert.equal(s('3 GBs', 'fr-FR'), '3 GBs', 'only a whole unit word counts');
});

test('#636 no models-segment string prints a byte unit after a placeholder: the code formats the whole size', () => {
  const models = ['en-GB', ...Object.keys(FILES)];
  for (const locale of models) {
    const src = read(`src/i18n/models/${locale}.ts`);
    const bad = [...src.matchAll(/\{\w+\}[\s  ]*(?:GiB|GB|TB|MB|KiB)\b/g)].map((m) => m[0]);
    assert.deepEqual(bad, [], `${locale}: ${bad}`);
  }
  // The two static labels that name their unit in brackets follow the locale.
  assert.match(read('src/i18n/models/fr-FR.ts'), /'mm\.filters\.size': "Taille du fichier \(Go\)"/);
  assert.match(read('src/i18n/models/fr-FR.ts'), /'mm\.fit\.memory': "Mémoire disponible \(Gio\)"/);
  // The skill upload hint carries the limit as a parameter in every locale.
  for (const locale of LOCALES) assert.match(read(`src/i18n/${locale}.ts`), /'projects\.skills\.addOptional': .*\{limit\}/, locale);
  assert.doesNotMatch(read('src/i18n/fr-FR.ts'), /32 KiB/);
});

test('#636 the Models, Tune and Skill screens format sizes through the shared helpers', () => {
  const mm = read('src/components/models/mm.ts');
  assert.match(mm, /export const gib = .*formatBinaryUnit\(n, 'GiB', appLocale\(\), digits\)/);
  assert.match(mm, /export const human = \(text: string\) => localizeSizeText\(text, appLocale\(\)\)/);
  assert.match(read('src/components/InstructionSkills.tsx'), /formatBinaryUnit\(SKILL_LIMIT_KIB, 'KiB', t\.locale, 0\)/);
  assert.match(read('src/components/models/LibraryTab.tsx'), /size\(disk\.free\)/);
  assert.match(read('src/components/models/GuidedOptimize.tsx'), /gb\(roundModelSizeGB\(sizeGB\)\)/);
  assert.doesNotMatch(read('src/components/models/GuidedOptimize.tsx'), /\} GiB|\)\} GB/);
  assert.doesNotMatch(read('src/components/models/ConfigureTab.tsx'), /\)\} GiB/);
  assert.match(read('src/components/StorageFileBrowser.tsx'), /formatBytes\(size, appLocale\(\)\)/);
  // The chart units come out in the locale too.
  assert.match(read('src/components/models/TimeChart.tsx'), /unitLabel\(unit\)/);
});

test('#636 the skill limit shown is the server limit', () => {
  assert.match(read('server/instruction-skills.cjs'), /const MAX_BODY = 32768;/);
  assert.match(read('src/components/InstructionSkills.tsx'), /const SKILL_LIMIT_KIB = 32;/);
});

// ── #637: the Diary in the phone preview ─────────────────────────────────────────────────────────
test('#637 the Diary follows data-layout="mobile", and the Layout note says so in every locale', () => {
  const css = read('src/styles/noevia.css');
  for (const rule of [/:root\[data-layout="mobile"\] \.diary-layout \{[^}]*flex-direction: column/, /:root\[data-layout="mobile"\] \.diary-context \{[^}]*border-left: 0/, /:root\[data-layout="mobile"\] \.diary-composer-dock/, /:root\[data-layout="mobile"\] \.calendar-day/]) assert.match(css, rule);
  const words = { 'en-GB': /Models and the Diary/, 'de-DE': /Modelle und Tagebuch/, 'es-ES': /el Diario/, 'fr-FR': /le Journal/, 'it-IT': /il Diario/, 'nb-NO': /og Dagbok/, 'nl-NL': /en Dagboek/, 'pt-BR': /o Diário/, 'sv-SE': /och Dagbok/ };
  for (const [locale, re] of Object.entries(words)) assert.match(read(`src/i18n/settings/${locale}.ts`), new RegExp(`'appearance\\.layout\\.descDesktop': [^\\n]*${re.source}`), locale);
});
