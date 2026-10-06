'use strict';
// #359: the address bar's path <-> place mapping (src/routes.ts), its return-to validation after
// sign-in, how app state becomes a place, when history is pushed vs replaced, and that the server
// (server/spa-routes.cjs) serves index.html for every path the client can produce.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../src/routes.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exports_, URL });
const { parsePath, matchPath, toPath, safeReturnPath, routeForState, historyMode, canonicalSection } = exports_;
const { isClientRoute } = require('../../server/spa-routes.cjs');

// The module runs in its own realm: compare by JSON, not prototype.
const j = (v) => JSON.stringify(v);

// One entry per place the app can show, with its canonical path.
const PLACES = [
  [{ kind: 'new' }, '/'],
  [{ kind: 'new', projectId: 'proj-1727000000000-ab12cd' }, '/p/proj-1727000000000-ab12cd/new'],
  [{ kind: 'chat', chatId: 'c-1727000000000-x1y2z3' }, '/c/c-1727000000000-x1y2z3'],
  [{ kind: 'project', id: 'proj-1' }, '/p/proj-1'],
  [{ kind: 'project', id: 'proj-1', tab: 'sources' }, '/p/proj-1/sources'],
  [{ kind: 'project', id: 'proj-1', tab: 'research' }, '/p/proj-1/research'],
  [{ kind: 'project', id: 'proj-1', tab: 'code' }, '/p/proj-1/code'],
  [{ kind: 'project', id: 'proj-1', tab: 'browser' }, '/p/proj-1/browser'],
  [{ kind: 'projects' }, '/projects'],
  [{ kind: 'settings', section: 'appearance' }, '/settings/appearance'],
  [{ kind: 'settings', section: 'models' }, '/settings/models'],
  [{ kind: 'settings', section: 'status' }, '/settings/status'],
  [{ kind: 'customise', tab: 'skills' }, '/customise/skills'],
  [{ kind: 'customise', tab: 'connectors' }, '/customise/connectors'],
  [{ kind: 'customise', tab: 'plugins' }, '/customise/plugins'],
  [{ kind: 'models' }, '/models'],
  [{ kind: 'models', model: 'Qwen3-30B-A3B-Q4_K_M.gguf' }, '/models/Qwen3-30B-A3B-Q4_K_M.gguf'],
  [{ kind: 'models', model: 'org/model:Q4 K' }, '/models/org%2Fmodel%3AQ4%20K'],
  [{ kind: 'diary' }, '/diary'],
  [{ kind: 'archived' }, '/archived'],
  [{ kind: 'code' }, '/code'],
];

test('every place has one canonical path, and the path reads back as the same place', () => {
  for (const [route, expected] of PLACES) {
    assert.equal(toPath(route), expected, `toPath ${j(route)}`);
    assert.equal(j(parsePath(expected)), j(route), `parsePath ${expected}`);
    assert.equal(toPath(parsePath(expected)), expected, `round trip ${expected}`);
  }
});

// #403: a section listed in SettingsShell's own navigation must be reachable at its own
// `/settings/<id>` address — the nav is read from source, not hand-copied, so adding a section
// there without giving it a working address fails this test instead of shipping a silent
// deep-link fallback to Appearance.
test('every Settings section SettingsShell lists has its own working /settings/<id> address', () => {
  const shellSrc = fs.readFileSync(path.join(__dirname, '../../src/components/SettingsShell.tsx'), 'utf8');
  const personalStart = shellSrc.indexOf('const PERSONAL: Group[] = [');
  const personalEnd = shellSrc.indexOf('\n];', personalStart);
  const adminStart = shellSrc.indexOf('const ADMIN: Group = {');
  const adminEnd = shellSrc.indexOf('\n] };', adminStart);
  assert.ok(
    personalStart >= 0 && personalEnd > personalStart && adminStart >= 0 && adminEnd > adminStart,
    "SettingsShell.tsx's PERSONAL/ADMIN group markers changed shape — update this test's extraction",
  );
  const region = shellSrc.slice(personalStart, personalEnd) + '\n' + shellSrc.slice(adminStart, adminEnd);
  // Each nav item is `['id', 'Label', 'keywords']`; the id is the first quoted string after `[`.
  const ids = [...new Set([...region.matchAll(/\[\s*'([a-z][a-z0-9-]*)',\s*'/g)].map((m) => m[1]))];
  // A floor, not an exact count: a newly added section joins the loop below automatically, so this
  // only has to catch the extraction itself silently finding nothing.
  assert.ok(ids.length >= 19, `expected every Settings section id (found ${ids.length}: ${ids.join(', ')})`);
  for (const id of ids) {
    // Listed by its own id, so it must not itself be aliased away to some other section.
    assert.equal(canonicalSection(id), id, `${id} is a section id but SETTINGS_SECTION_ALIASES rewrites it`);
    assert.equal(j(matchPath(`/settings/${id}`)), j({ kind: 'settings', section: id }), `/settings/${id} does not open ${id}`);
    assert.equal(toPath({ kind: 'settings', section: id }), `/settings/${id}`, `${id} does not round-trip to its own path`);
  }
});

test('#403: /settings/account (the obvious guess for the page SettingsShell labels "Account") reaches it, not Appearance', () => {
  assert.equal(canonicalSection('account'), 'profile');
  assert.equal(j(matchPath('/settings/account')), j({ kind: 'settings', section: 'profile' }));
  assert.equal(j(parsePath('/settings/account')), j({ kind: 'settings', section: 'profile' }));
});

test('old and alternative spellings land on the canonical place', () => {
  const cases = [
    ['/chat', '/'],
    ['/c/abc/', '/c/abc'],
    ['/p/proj-1/chats', '/p/proj-1'],
    ['/settings', '/settings/appearance'],
    ['/settings/general', '/settings/appearance'],
    ['/settings/archived', '/settings/data'],
    ['/settings/shortcuts', '/settings/keyboard'],
    ['/settings/instructions', '/settings/personalization'],
    ['/customise', '/customise/connectors'],
    ['/customize/skills', '/customise/skills'],
    ['/customise/mcp', '/customise/plugins'],
    ['/customise/connected', '/customise/connectors'],
    ['/plugins', '/customise/connectors'],
  ];
  for (const [input, canonical] of cases) assert.equal(toPath(parsePath(input)), canonical, input);
});

test('junk, truncated and hostile paths read as a new chat and never throw', () => {
  const junk = [
    '', 'c/abc', '/c', '/c/', '/c/a/b', '/c/<script>', '/c/a%20b', '/c/%E0%A4%A', '/p', '/p/', '/p/../x', '/p/proj-1/new/x',
    '/p/proj-1/unknown', '/settings/UPPER', '/settings/a/b', '/settings/%00', '/customise/nope', '/models/a/b',
    `/models/${'x'.repeat(300)}`, '/models/%0Aevil', '//evil.example/c/abc', '/\\evil.example', '/api/workspace',
    '/assets/index.js', '/nope', '/diary/2026-09-26', '/a//b', `/${'a'.repeat(600)}`, '/%', '/c/%2e%2e',
  ];
  for (const input of junk) {
    assert.equal(matchPath(input), null, `matchPath ${j(input)}`);
    assert.equal(j(parsePath(input)), j({ kind: 'new' }), `parsePath ${j(input)}`);
  }
  for (const input of [null, undefined, 42, {}, []]) assert.equal(j(parsePath(input)), j({ kind: 'new' }));
});

test('toPath never writes an address outside this app, even for malformed ids', () => {
  assert.equal(toPath({ kind: 'chat', chatId: '../../evil' }), '/');
  assert.equal(toPath({ kind: 'chat', chatId: '//evil.example' }), '/');
  assert.equal(toPath({ kind: 'project', id: 'a/b' }), '/');
  assert.equal(toPath({ kind: 'new', projectId: 'a b' }), '/');
  assert.equal(toPath({ kind: 'settings', section: 'Bad Section' }), '/settings/appearance');
  assert.equal(toPath({ kind: 'models', model: 'x'.repeat(300) }), '/models');
  assert.match(toPath({ kind: 'models', model: '//evil.example' }), /^\/models\/%2F%2Fevil\.example$/);
});

test('return-to after sign-in: only same-origin paths this app makes', () => {
  assert.equal(safeReturnPath('/c/c-1-abc'), '/c/c-1-abc');
  assert.equal(safeReturnPath('/p/proj-1/sources'), '/p/proj-1/sources');
  assert.equal(safeReturnPath('/settings/general'), '/settings/appearance');
  // The invite/recovery token and any fragment never survive into the address bar.
  assert.equal(safeReturnPath('/c/abc?invite=secret-token'), '/c/abc');
  assert.equal(safeReturnPath('/?recovery=secret'), '/');
  assert.equal(safeReturnPath('/c/abc#frag'), '/c/abc');
  for (const hostile of [
    '//evil.example', '//evil.example/c/abc', '/\\evil.example', '\\\\evil.example', 'https://evil.example/c/abc',
    'http:evil.example', 'javascript:alert(1)', 'data:text/html,x', '/%2F%2Fevil.example', '/c/abc/../../../evil',
    ' /c/abc', '', null, undefined, 7, '/unknown/place', '/api/auth/session', '/\t/evil.example',
  ]) {
    assert.equal(safeReturnPath(hostile), '/', `safeReturnPath ${j(hostile)}`);
  }
});

test('app state -> place: Settings is an overlay and wins, then Code, then the view', () => {
  const chat = { kind: 'chat', chatId: 'c-1', projectId: null };
  const base = { view: chat, settingsOpen: false, settingsSection: 'appearance', codeMode: false };
  assert.equal(toPath(routeForState(base)), '/c/c-1');
  assert.equal(toPath(routeForState({ ...base, freshChat: true })), '/');
  assert.equal(toPath(routeForState({ ...base, view: { ...chat, projectId: 'proj-1' }, freshChat: true })), '/p/proj-1/new');
  assert.equal(toPath(routeForState({ ...base, settingsOpen: true, settingsSection: 'general' })), '/settings/appearance');
  assert.equal(toPath(routeForState({ ...base, settingsOpen: true, codeMode: true, settingsSection: 'usage' })), '/settings/usage');
  assert.equal(toPath(routeForState({ ...base, codeMode: true })), '/code');
  assert.equal(toPath(routeForState({ ...base, view: { kind: 'project', id: 'proj-1' } })), '/p/proj-1');
  assert.equal(toPath(routeForState({ ...base, view: { kind: 'project', id: 'proj-1' }, projectTab: 'sources' })), '/p/proj-1/sources');
  assert.equal(toPath(routeForState({ ...base, view: { kind: 'plugins' }, customiseTab: 'skills' })), '/customise/skills');
  assert.equal(toPath(routeForState({ ...base, view: { kind: 'plugins' } })), '/customise/connectors');
  assert.equal(toPath(routeForState({ ...base, view: { kind: 'models', model: 'm' } })), '/models/m');
  assert.equal(toPath(routeForState({ ...base, view: { kind: 'projects' } })), '/projects');
  assert.equal(toPath(routeForState({ ...base, view: { kind: 'diary' } })), '/diary');
  assert.equal(toPath(routeForState({ ...base, view: { kind: 'archived' } })), '/archived');
  // An unbuilt preview is never somewhere to link to: the address bar is left alone.
  assert.equal(routeForState({ ...base, view: { kind: 'preview', title: 'x' } }), null);
});

test('history: push what the person chose, replace what the app did on its own', () => {
  const at = (p, kind = 'chat', chatId = null) => ({ path: p, kind, chatId });
  // Already there (Back/Forward landed, or nothing changed).
  assert.equal(historyMode(at('/c/a'), at('/c/a'), { current: '/c/a' }), 'none');
  // The first sync after load normalises whatever was typed.
  assert.equal(historyMode(null, at('/settings/appearance', 'settings'), { current: '/settings/general' }), 'replace');
  // chat A -> chat B is a navigation.
  assert.equal(historyMode(at('/c/a', 'chat', 'a'), at('/c/b', 'chat', 'b'), { current: '/c/a' }), 'push');
  // A redirect (deleted chat, missing project, unavailable section) replaces.
  assert.equal(historyMode(at('/c/a', 'chat', 'a'), at('/', 'new', 'n'), { current: '/c/a', forceReplace: true }), 'replace');
  // A new chat getting its address once its first message is sent is the same place.
  assert.equal(historyMode(at('/', 'new', 'x'), at('/c/x', 'chat', 'x'), { current: '/' }), 'replace');
  // ...but moving from a new chat to a different chat is a navigation.
  assert.equal(historyMode(at('/', 'new', 'x'), at('/c/y', 'chat', 'y'), { current: '/' }), 'push');
});

test('the server serves index.html for every path the client can produce', () => {
  for (const [route, p] of PLACES) {
    assert.ok(isClientRoute(p), `server does not accept ${p} (${j(route)})`);
    assert.ok(isClientRoute(toPath(parsePath(p))), p);
  }
  // Every alternative spelling the client accepts is also served, so an old link still loads.
  for (const p of ['/chat', '/settings', '/settings/general', '/customise', '/customize/skills', '/customise/mcp', '/plugins', '/p/proj-1/chats', '/c/abc/']) {
    assert.ok(isClientRoute(p), p);
  }
  // #406: a truncated/stripped-id chat or project link (`/c`, `/p`, and their trailing-slash
  // forms) is also served the shell rather than a raw JSON 404 — the client already reads these
  // as a new chat (see the junk-path test above), so this only has to get it past the fallback.
  for (const p of ['/c', '/c/', '/p', '/p/']) {
    assert.ok(isClientRoute(p), p);
    assert.equal(j(parsePath(p)), j({ kind: 'new' }), p);
  }
});

test('App wiring: one popstate listener, history written only through historyMode, a stable Settings callback', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/App.tsx'), 'utf8');
  assert.match(app, /addEventListener\('popstate'/);
  assert.equal((app.match(/history\.pushState\(/g) || []).length, 1, 'exactly one pushState, in the address-bar sync');
  assert.match(app, /const mode = historyMode\(/);
  // Settings re-reports its section whenever this callback changes identity; an inline arrow made
  // it re-report a stale section on every render and ping-pong with Back (found by qa/url-history).
  assert.match(app, /onSection=\{onSettingsSection\}/);
  assert.match(app, /const onSettingsSection = useCallback\(/);
  // Signing in keeps the deep link, through the validator only.
  const gate = fs.readFileSync(path.join(__dirname, '../../src/components/AuthGate.tsx'), 'utf8');
  assert.doesNotMatch(gate, /replaceState\(\{\}, '', window\.location/);
  assert.equal((gate.match(/safeReturnPath\(window\.location\.pathname\)/g) || []).length, 2);
});
