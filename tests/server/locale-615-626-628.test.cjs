'use strict';
// #615 (reopened, round 8), #624 item 1, #626, #627, #628: the in-app toolsets are worded from the
// catalogue by id whatever the server's `source` says, the reply's "Using:" list and chat chrome
// follow the interface language, and the backup size uses the locale's byte units. Loads the real
// catalogues and the small pure modules from source, like locale-613-616-620.test.cjs. Everything
// read from disk is under apps/web, since the Docker image holds nothing else.
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
for (const [locale, name] of Object.entries(FILES)) core.registerCatalogue(locale, load(`i18n/${locale}`)[name]);
const EN = load('i18n/en-GB').EN_GB;
const LOCALES = ['en-GB', ...Object.keys(FILES)];
const tFor = (locale) => Object.assign((key, params) => core.translate(locale, key, params), { locale, plural: (key, count, params) => core.translatePlural(locale, key, count, params) });
const { toolboxCopy, isInAppBox, TOOLBOX_DESCRIPTION_IDS, TOOLBOX_LABEL_IDS } = load('toolbox-copy');
const { senderLabelText, toolScopeText } = load('chat-labels');
const { formatBytes } = load('number-format');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
// The English wording each in-app box has on the server, straight from the files that define it.
function serverBoxes() {
  const out = [{ id: 'core', label: 'Core', description: "Always-safe built-ins: the server clock, and full reads of this project's knowledge files." }];
  const manifest = read('server/mcp-toolbox-manifest.cjs');
  for (const m of manifest.matchAll(/^ {4}id: '([\w-]+)',[\s\S]*?^ {4}label: '([^']*)',[\s\S]*?^ {4}description: (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),/gm)) out.push({ id: m[1], label: m[2], description: (m[3] ?? m[4]).replace(/\\'/g, "'") });
  const kiwix = /box: \{ id: ID, label: '([^']*)', description: '([^']*)'/.exec(read('server/kiwix.cjs'));
  out.push({ id: 'offline-wikipedia', label: kiwix[1], description: kiwix[2] });
  const drive = /id: 'gdrive', label: '([^']*)', source: 'builtin',\s*description: '([^']*)'/.exec(read('server/gdrive-tools.cjs'));
  out.push({ id: 'gdrive', label: drive[1], description: drive[2] });
  return out;
}

test('#615 every in-app toolset the server defines is worded from the catalogue, whatever its source says', () => {
  const boxes = serverBoxes();
  assert.ok(boxes.length >= 27, `found ${boxes.length} in-app boxes`);
  for (const b of boxes) {
    assert.ok(TOOLBOX_DESCRIPTION_IDS.includes(b.id), `${b.id} has a description key`);
    assert.equal(EN[`toolbox.desc.${b.id}`], b.description, `English toolbox.desc.${b.id} is the server text`);
    if (TOOLBOX_LABEL_IDS.includes(b.id)) assert.equal(EN[`toolbox.label.${b.id}`], b.label, `English toolbox.label.${b.id} is the server label`);
    for (const locale of Object.keys(FILES)) {
      const t = tFor(locale);
      // The two shapes the server sends: `builtin`, and `mcp` flagged inApp (the diary, web and Nextcloud toolsets).
      for (const shape of [{ source: 'builtin' }, { source: 'mcp', inApp: true }, { source: 'mcp', inApp: true, connector: true }]) {
        const copy = toolboxCopy(t, { ...b, ...shape });
        assert.equal(copy.description, t(`toolbox.desc.${b.id}`), `${locale} ${b.id} description`);
        assert.notEqual(copy.description, b.description, `${locale} ${b.id} description is not the English server text`);
        assert.equal(copy.label, TOOLBOX_LABEL_IDS.includes(b.id) ? t(`toolbox.label.${b.id}`) : b.label, `${locale} ${b.id} label`);
        if (TOOLBOX_LABEL_IDS.includes(b.id) && !(locale === 'nl-NL' && b.id === 'offline-wikipedia')) assert.notEqual(copy.label, b.label, `${locale} ${b.id} label is translated`);
      }
    }
  }
  // The names the tester listed, in German and French.
  const de = tFor('de-DE'), fr = tFor('fr-FR');
  const mcp = (id) => ({ ...boxes.find((b) => b.id === id), source: 'mcp', inApp: true });
  assert.equal(toolboxCopy(de, mcp('diary')).label, 'Tagebuch');
  assert.equal(toolboxCopy(fr, mcp('web-search')).label, 'Recherche web');
  assert.equal(toolboxCopy(de, mcp('offline-wikipedia')).label, 'Offline-Wikipedia');
  assert.equal(toolboxCopy(fr, mcp('offline-wikipedia')).label, 'Wikipédia hors ligne');
  assert.equal(toolboxCopy(de, { ...mcp('gdrive'), source: 'builtin' }).label, 'Google Drive', 'a product name stays');
});

test('#615 a third party’s box keeps the name and description it sent, even under a built-in id', () => {
  const de = tFor('de-DE');
  const sent = { label: 'Their Diary', description: 'Their own wording.' };
  for (const box of [{ id: 'diary', source: 'mcp', ...sent }, { id: 'diary', source: 'mcp', inApp: false, ...sent }, { id: 'diary', source: 'builtin', inApp: false, ...sent }, { id: 'their-box', source: 'mcp', inApp: true, ...sent }]) {
    assert.deepEqual({ ...toolboxCopy(de, box) }, box.id === 'their-box' ? sent : sent, JSON.stringify(box));
  }
  assert.equal(isInAppBox({ source: 'builtin' }), true);
  assert.equal(isInAppBox({ source: 'mcp' }), false);
  assert.equal(isInAppBox({ source: 'mcp', inApp: true }), true);
});

test('#615 the composer, popup and catalogue read the server’s inApp flag through toolboxCopy', () => {
  assert.match(read('src/types.ts'), /inApp\?: boolean/);
  // #1006: the model dialog no longer lists toolsets; the composer's + menu does.
  for (const file of ['ComposerActions', 'ToolCatalogue']) assert.match(read(`src/components/${file}.tsx`), /toolboxCopy\(t, /, file);
  // Spread first, so the flag reaches toolboxCopy from the server's summary.
  assert.match(read('src/components/ToolCatalogue.tsx'), /toolboxCopy\(t, box\)/);
});

test('#624 the "Using:" list is worded per box id, and falls back to the server label', () => {
  const boxes = [{ id: 'core', label: 'Core', inApp: true }, { id: 'diary', label: 'Diary', inApp: true }, { id: 'nextcloud-notes', label: 'Nextcloud Notes', inApp: true }, { id: 'third', label: 'Third party', inApp: false }];
  assert.equal(toolScopeText(tFor('de-DE'), boxes), 'Kern, Tagebuch, Nextcloud Notes, Third party');
  assert.equal(toolScopeText(tFor('fr-FR'), boxes), 'Base, Journal, Nextcloud Notes, Third party');
  assert.equal(toolScopeText(tFor('en-GB'), boxes), 'Core, Diary, Nextcloud Notes, Third party');
  assert.equal(tFor('de-DE')('chat.scope.using', { tools: toolScopeText(tFor('de-DE'), boxes.slice(0, 2)) }), 'Verwendet: Kern, Tagebuch');
  const chat = read('src/components/ChatView.tsx'), app = read('src/App.tsx');
  assert.match(chat, /toolScopeText\(t, m\.toolScopeBoxes\)/);
  assert.match(app, /toolScopeBoxes: ev\.boxes/);
});

test('#626 the reply’s sender label, tool-call counts and status words follow the interface language', () => {
  const en = tFor('en-GB'), de = tFor('de-DE'), fr = tFor('fr-FR');
  assert.equal(senderLabelText(en, 'Assistant · Auto (fast)'), 'Auto (Fast)');
  assert.equal(senderLabelText(de, 'Assistant · Auto (fast)'), 'Auto (Schnell)');
  assert.equal(senderLabelText(fr, 'Assistant · Auto (smart)'), 'Auto (Intelligent)');
  assert.equal(senderLabelText(de, 'Auto (code)'), 'Auto (Code)');
  assert.equal(senderLabelText(de, 'Assistant · Auto (custom-role)'), 'Auto (custom-role)', 'an unknown route id is shown as sent');
  assert.equal(senderLabelText(de, 'Stopped'), 'Gestoppt');
  assert.equal(senderLabelText(fr, 'Stopped'), 'Arrêté');
  assert.equal(senderLabelText(de, 'Qwen 3.5 9B'), 'Qwen 3.5 9B', 'a model name is never touched');
  // Plural pairs, chosen by Intl.PluralRules per locale: French counts 0 and 1 as singular.
  const counts = (t, n) => t.plural('chat.toolCalls.count', n, { count: n });
  assert.deepEqual([0, 1, 2].map((n) => counts(en, n)), ['0 tool calls', '1 tool call', '2 tool calls']);
  assert.deepEqual([0, 1, 2].map((n) => counts(de, n)), ['0 Werkzeugaufrufe', '1 Werkzeugaufruf', '2 Werkzeugaufrufe']);
  assert.deepEqual([0, 1, 2].map((n) => counts(fr, n)), ['0 appel d’outil', '1 appel d’outil', '2 appels d’outils']);
  assert.equal(de('chat.status.thinking'), 'denkt nach…');
  assert.equal(fr('chat.status.generating'), 'génération…');
  assert.equal(de('chat.stopped.content'), 'Gestoppt, bevor eine Antwort geschrieben wurde.');
  assert.equal(fr('chat.cowork.starting'), 'démarrage d’une tâche…');
  assert.equal(fr('chat.cowork.failed', { reason: 'HTTP 500' }), 'La tâche Cowork n’a pas démarré — HTTP 500');
  assert.equal(de('chat.cowork.startedBranch', { repo: 'demo', branch: 'main' }), 'Cowork-Aufgabe in **demo** auf Branch `main` gestartet.');
  const calls = read('src/components/ToolCalls.tsx'), chat = read('src/components/ChatView.tsx'), app = read('src/App.tsx');
  for (const english of ["'thinking…'", "'generating…'", "'call' : 'calls'", 'awaiting approval`']) assert.ok(!chat.includes(english) && !calls.includes(english), `still hard-coded: ${english}`);
  for (const english of ["'Stopped before a reply was written.'", "'starting a task…'", 'Cowork task did not start —']) assert.ok(!app.includes(english), `App still hard-codes ${english}`);
  assert.match(calls, /t\.plural\('chat\.toolCalls\.count'/);
});

test('#627 the Code tab’s architect options and their reasons have catalogue keys in every locale', () => {
  for (const id of ['direct', 'local', 'frontier']) for (const part of ['label', 'reason']) for (const locale of LOCALES) assert.ok(core.translate(locale, `code.prep.${id}.${part}`) !== `code.prep.${id}.${part}`, `${locale} code.prep.${id}.${part}`);
  assert.equal(tFor('de-DE')('code.prep.local.label'), 'Lokaler Architekt');
  assert.equal(tFor('fr-FR')('code.prep.frontier.label'), 'Architecte frontière');
  // Those are the server's own labels; the catalogue is keyed by their ids.
  const service = read('server/code-service.cjs');
  for (const [id, label] of [['local', 'Local architect'], ['frontier', 'Frontier architect']]) assert.ok(service.includes(`id: '${id}', label: '${label}'`), id);
  assert.equal(EN['code.prep.local.label'], 'Local architect');
  assert.equal(EN['code.prep.frontier.label'], 'Frontier architect');
});

test('#628 the backup size goes through formatBytes, so French says ko/Mo like the rest of the app', () => {
  assert.match(formatBytes(652 * 1024, 'fr-FR').replace(/\s/g, ' '), /^652 ko$/);
  assert.match(formatBytes(3 * 1024 * 1024, 'fr-FR').replace(/\s/g, ' '), /^3,0 Mo$|^3 Mo$/);
  assert.match(formatBytes(652 * 1024, 'en-GB'), /^652 kB$/);
  const src = read('src/components/offsite-backup/OffsiteBackupSettings.tsx');
  assert.match(src, /formatBytes\(n, appLocale\(\)\)/);
  assert.doesNotMatch(src, /KB`|MB`/);
});

test('every new key exists in every locale with its placeholders', () => {
  const keys = Object.keys(EN).filter((k) => /^(chat\.toolCalls\.|chat\.route\.(auto|name)|chat\.status\.|chat\.stopped\.|chat\.cowork\.|sidebar\.mcp(Tools|ServersAllAdded|Unavailable|Down)|code\.prep\.(local|frontier)|toolbox\.(label|desc)\.(offline-wikipedia|gdrive))/.test(k));
  assert.ok(keys.length >= 40, `found ${keys.length}`);
  const holders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const locale of Object.keys(FILES)) for (const k of keys) {
    const text = core.CATALOGUES[locale][k];
    assert.ok(text, `${locale} ${k}`);
    assert.equal(holders(text), holders(EN[k]), `${locale} ${k} placeholders`);
  }
});
