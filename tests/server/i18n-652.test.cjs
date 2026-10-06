// #652: wording leftovers in French (and, for the Smart term, every locale). The generic completeness and
// placeholder checks live in i18n.test.cjs; this file pins what these keys must say.
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
const FILES = { 'en-GB': 'EN_GB', 'de-DE': 'DE_DE', 'es-ES': 'ES_ES', 'fr-FR': 'FR_FR', 'it-IT': 'IT_IT', 'nb-NO': 'NB_NO', 'nl-NL': 'NL_NL', 'pt-BR': 'PT_BR', 'sv-SE': 'SV_SE' };
const catalogue = (l) => ({
  ...load(l)[FILES[l]], ...load('settings/' + l)[FILES[l] + '_SETTINGS'], ...load('models/' + l)[FILES[l] + '_MODELS'],
});

// The name a locale gives the router's "smart" role, read out of every string that shows it.
function smartNames(c) {
  const seg = (text, re) => { const m = re.exec(text); assert.ok(m, `no role name in "${text}"`); return m[1].trim(); };
  return {
    'routing.smart': seg(c['routing.smart'], /^(.+?)\s*:\s*\{model\}/),
    'modelPopup.routingAfter': null, // a sentence; checked below against the same name
    'chat.route.name.smart': c['chat.route.name.smart'].trim(),
    'mm.overview.route.smart': c['mm.overview.route.smart'].trim(),
    'mm.route.role.smart': seg(c['mm.route.role.smart'], /^(.+?)\s+[—–-]\s/),
    'models.roles': seg(c['models.roles'], /·\s*(.+?)\s*:\s*\{smart\}/),
    'composer.autoFastSmart': seg(c['composer.autoFastSmart'], /\((?:[^/]+)\/(.+)\)/),
    'inspector.routingAuto': seg(c['inspector.routingAuto'], /\/\s*([^/]+)$/),
  };
}

test('#652 every locale gives the router\'s smart role one name, in Settings, Models and chat alike', () => {
  for (const l of Object.keys(FILES)) {
    const c = catalogue(l);
    let names; try { names = smartNames(c); } catch (e) { throw new Error(`${l}: ${e.message}`); }
    const distinct = new Set(Object.values(names).filter(Boolean));
    assert.equal(distinct.size, 1, `${l} names the smart role ${[...distinct].join(' / ')}: ${JSON.stringify(names)}`);
    const name = [...distinct][0];
    // The sentences that explain the routing use the same word.
    for (const k of ['modelPopup.routingAfter', 'mm.route.explain1', 'mm.route.explain2', 'mm.route.intro', 'mm.route.unconfigured', 'mm.defaultMode.intro']) {
      assert.ok(c[k].includes(name), `${l}: ${k} does not say "${name}"`);
    }
  }
});

test('#652 French says Intelligent for the smart role and keeps Avancé for the advanced editor', () => {
  const fr = catalogue('fr-FR');
  assert.equal(smartNames(fr)['models.roles'], 'Intelligent');
  assert.equal(fr['models.roles'], 'Rapide : {fast} · Intelligent : {smart}');
  assert.equal(fr['routing.smart'], 'Intelligent : {model}');
  assert.equal(fr['mm.overview.route.smart'], 'Intelligent');
  assert.equal(fr['mm.editor.advanced'], 'Avancé', 'the editor tab is a different word and stays');
  for (const k of Object.keys(fr).filter((k) => /route|routing|roles|defaultMode/.test(k) && !/advanced|Advanced/.test(k))) {
    assert.doesNotMatch(String(fr[k]), /\bAvancé\b|\bmodèle avancé\b/, `${k} still names the role "Avancé"`);
  }
});

test('#652 the models rate says jetons/s in French, like every other French tokens-per-second string', () => {
  const fr = catalogue('fr-FR');
  assert.equal(fr['models.rate'], '{rate} jetons/s au dernier relevé');
  assert.doesNotMatch(fr['models.rate'], /tok\/s/);
  assert.match(fr['stats.tokPerSecUnit'], /jetons\/s/);
  assert.match(fr['mm.tokensPerSecond'], /jetons\/s/);
});

test('#652 the file-sharing "not configured" reason is a catalogue string in every locale, in that locale\'s words', () => {
  const en = catalogue('en-GB')['sharing.reason.notConfigured'];
  assert.equal(en, 'The operator has not configured a file-sharing endpoint.', 'the English catalogue matches the server\'s fallback sentence');
  const server = require('../../server/dav-settings.cjs').configuration({});
  assert.equal(server.reason, en, 'the server fallback and the English string are the same sentence');
  for (const l of Object.keys(FILES).filter((l) => l !== 'en-GB')) {
    const text = catalogue(l)['sharing.reason.notConfigured'];
    assert.ok(text, `${l} has no translation`);
    assert.notEqual(text, en, `${l} still shows English`);
  }
  // The informal address in German, and "Réglages" style wording in French, follow their locale guards.
  assert.doesNotMatch(catalogue('de-DE')['sharing.reason.notConfigured'], /\bSie\b|\bIhr/);
});

test('#652 the sharing panel translates the server reason id and keeps the English sentence as the fallback', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/components/DiarySharing.tsx'), 'utf8');
  assert.match(src, /'not-configured':\s*'sharing\.reason\.notConfigured'/);
  assert.match(src, /sharingReason\(value,\s*t\)/);
  assert.doesNotMatch(src, /\{value\.reason\}/, 'the raw English reason must not be rendered directly');
});
