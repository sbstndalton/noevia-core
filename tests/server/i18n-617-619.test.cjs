// #617/#618: the Code landing and project Code tab, and the Web address, Features, Experimental and
// Backups pages, read from the catalogue in every locale. The generic completeness and
// placeholder checks live in i18n.test.cjs; this file pins what those new keys must cover.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const dir = path.join(__dirname, '../../src/i18n');
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const exports = {}; cache[name] = exports;
  const code = ts.transpileModule(fs.readFileSync(path.join(dir, name + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const here = path.posix.dirname(name);
  vm.runInNewContext(code, { exports, Intl, console, Promise, require: (m) => load(path.posix.normalize(path.posix.join(here, m))) });
  return exports;
}
const FILES = { 'de-DE': 'DE_DE', 'es-ES': 'ES_ES', 'fr-FR': 'FR_FR', 'it-IT': 'IT_IT', 'nb-NO': 'NB_NO', 'nl-NL': 'NL_NL', 'pt-BR': 'PT_BR', 'sv-SE': 'SV_SE' };
const EN = load('en-GB').EN_GB;
const EN_SETTINGS = load('settings/en-GB').EN_GB_SETTINGS;
const base = (l) => load(l)[FILES[l]];
const settings = (l) => load('settings/' + l)[FILES[l] + '_SETTINGS'];
const src = (p) => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');
const { REGISTRY } = require('../../server/features.cjs');

// Words that are the same in every one of these languages (product terms and loanwords).
const SAME_EVERYWHERE = /^(Auto|Harness|Code|Terminal|Worktrees|Hooks|Google Drive)$/;

test('every server-registered feature has a translatable label and description (#618)', () => {
  for (const id of Object.keys(REGISTRY)) {
    for (const part of ['label', 'description']) assert.ok(EN_SETTINGS[`features.item.${id}.${part}`], `features.item.${id}.${part} is not in the English catalogue`);
  }
  // No orphan: a catalogue row for a feature the registry no longer has is dead text.
  const ids = new Set(Object.keys(REGISTRY));
  for (const k of Object.keys(EN_SETTINGS).filter((k) => k.startsWith('features.item.'))) assert.ok(ids.has(k.split('.')[2]), `${k} names no registered feature`);
});

test('the English catalogue says what the server registry says, apart from spelling (#618)', () => {
  const spell = (s) => s.replace(/behaviour/g, 'behavior');
  for (const [id, spec] of Object.entries(REGISTRY)) {
    assert.equal(spell(EN_SETTINGS[`features.item.${id}.label`]), spec.label, id);
    assert.equal(spell(EN_SETTINGS[`features.item.${id}.description`]), spec.description, id);
  }
});

test('every reason id the server can send has a translation (#618)', () => {
  const ids = [...src('../server/features.cjs').matchAll(/\? '([a-zA-Z]+)' :/g)].map((m) => m[1]);
  assert.ok(ids.includes('browserPlaywright') && ids.includes('trustProxy') && ids.includes('notUsed'), ids.join());
  for (const id of new Set(ids)) assert.ok(EN_SETTINGS[`features.unavailable.${id}`], id);
});

test('the Code panel has a status word and an action label for everything the server can send (#617)', () => {
  const api = src('components/code/api.ts');
  const status = api.match(/id: string; status: ([^;]+);/)[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1));
  assert.ok(status.includes('waiting_approval') && status.includes('interrupted'), status.join());
  for (const s of status) assert.ok(EN[`code.status.${s}`], `code.status.${s}`);
  const actions = api.match(/export type CodeAction = ([^;]+);/)[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1));
  assert.ok(actions.length >= 10, actions.join());
  for (const a of actions) assert.ok(EN[`code.action.${a}`], `code.action.${a}`);
  assert.ok(EN['code.prep.direct.label'] && EN['code.prep.direct.reason']);
});

test('every catalogue key the Code landing, Code panel and Backups page name exists (#617, #618)', () => {
  const known = (k) => k in EN || k in EN_SETTINGS || `${k}.one` in EN || `${k}.one` in EN_SETTINGS || /^settings\.section\./.test(k) || /^(sidebar\.|common\.)/.test(k);
  for (const file of ['components/CodingWorkspace.tsx', 'components/code/CodePanel.tsx', 'components/features/FeatureSettings.tsx', 'components/features/DecisionServiceSettings.tsx',
    'components/web-address/WebAddressSettings.tsx', 'components/offsite-backup/OffsiteBackupSettings.tsx', 'components/offsite-backup/GoogleDriveSetup.tsx']) {
    const keys = [...src(file).matchAll(/'((?:code|gdrive|features|decision|webAddress|backups|admin)\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]);
    assert.ok(keys.length > 0, file);
    for (const k of keys) assert.ok(known(k), `${file} uses ${k}, which is not in the catalogue`);
  }
});

test('the new Code and Google Drive strings live in the base catalogue, the page strings in the Settings segment (#617, #618)', () => {
  // Code renders inside the project view (first-load bundle) and Google Drive inside the setup wizard.
  assert.ok(Object.keys(EN).some((k) => k.startsWith('code.landing.')) && Object.keys(EN).some((k) => k.startsWith('gdrive.')));
  for (const prefix of ['features.', 'decision.', 'webAddress.', 'backups.', 'admin.']) {
    assert.ok(Object.keys(EN_SETTINGS).some((k) => k.startsWith(prefix)), prefix);
    assert.ok(!Object.keys(EN).some((k) => k.startsWith(prefix)), `${prefix} belongs in the Settings segment`);
  }
});

for (const locale of Object.keys(FILES)) {
  test(`${locale}: the new keys are translated, not copies of the English (#617, #618)`, () => {
    const mine = [...Object.keys(EN).filter((k) => /^(code\.(landing|picker|panel|prep|status|action|task|approval)|gdrive)\./.test(k)).map((k) => [k, EN[k], base(locale)[k]]),
      ...Object.keys(EN_SETTINGS).filter((k) => /^(features\.|decision\.|webAddress\.|backups\.|admin\.)/.test(k)).map((k) => [k, EN_SETTINGS[k], settings(locale)[k]])];
    assert.ok(mine.length > 200, `only ${mine.length} new keys found`);
    const untranslated = mine.filter(([, en, own]) => !own || (own === en && !SAME_EVERYWHERE.test(en)));
    // A few short words (Direct, Command, Arguments, Repository, Terminal...) are legitimately the same word.
    const allowed = /^(Direct|Command|Arguments|Repository|Files|Terminal|Note|Schedule|Destination|Retention|Auto|Harness|Hooks|Worktrees|Code|Google Drive|Artifacts|Environments|Workspace|Tasks|Retry|Terminal|Test connection|Update|Backups|Offline Wikipedia|Open pull requests)$/;
    const bad = untranslated.filter(([, en]) => !allowed.test(en));
    assert.deepEqual(bad.map(([k]) => k), [], `${locale} has English text under: ${bad.map(([k]) => k).join(', ')}`);
  });
}

test('the interface locale, not the browser, chooses the words: German and French read differently (#617, #618)', () => {
  assert.equal(base('de-DE')['code.picker.open'], 'Code öffnen');
  assert.equal(base('fr-FR')['code.picker.open'], 'Ouvrir Code');
  assert.equal(settings('de-DE')['webAddress.earlier'], 'Frühere Adressen');
  assert.equal(settings('fr-FR')['webAddress.earlier'], 'Anciennes adresses');
  assert.equal(settings('fr-FR')['features.item.previews.label'], 'Surfaces en aperçu');
  assert.equal(settings('de-DE')['backups.snapshots'], 'Aufbewahrte Snapshots');
});
