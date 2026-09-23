'use strict';
// The executor's decisions with a scripted stand-in for Playwright: no browser, no network.
// The real-Chromium suite is qa/browser-executor.cjs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createBrowserExecutor } = require('./browser-executor.cjs');

const ORIGIN = 'https://shop.example.test';
const SECRET = 'synthetic-secret-7731';
const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-bexec-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

/** A page whose elements are whatever `dom` says, recording every effect the executor causes. */
function fakeBrowser({ dom = {}, url = ORIGIN + '/', failOn = null } = {}) {
  const effects = [], disposals = [];
  let screenshotCalls = 0;
  const handleFor = (selector) => {
    const node = dom[selector];
    if (!node) return null;
    const attached = () => {
      if (dom[selector] !== node) throw Error('Element is not attached to the DOM');
    };
    return {
      evaluate: async (fn) => {
        attached();
        if (fn.name === 'describeInPage') return node;
        if (String(fn).includes('isConnected')) return true;
        return undefined;
      },
      click: async () => { attached(); if (failOn === 'click') throw Error('Target closed'); effects.push(['click', selector]); },
      fill: async (value) => { attached(); effects.push(['fill', selector, value]); },
      selectOption: async (value) => { attached(); effects.push(['select', selector, value]); },
      press: async (key) => { attached(); effects.push(['press', selector, key]); },
      hover: async () => { attached(); effects.push(['hover', selector]); },
      setInputFiles: async (file) => { attached(); effects.push(['upload', selector, file]); },
      dispose: async () => { disposals.push(selector); },
    };
  };
  const page = {
    url: () => url,
    locator: (selector) => ({
      first() { return this; },
      elementHandle: async () => handleFor(selector),
      innerText: async () => dom[selector]?.text || '',
    }),
    goto: async (to) => { effects.push(['goto', to]); url = to; },
    evaluate: async () => ({ inForm: false }),
    screenshot: async () => { screenshotCalls++; return Buffer.from(`png ${SECRET}`); },
    waitForLoadState: async () => {},
    goBack: async () => {},
    keyboard: { press: async (key) => { effects.push(['key', key]); } },
    mouse: { wheel: async () => {} },
    waitForTimeout: async () => {},
    innerText: async () => 'body text',
  };
  const handlers = {};
  page.on = (event, fn) => { (handlers[event] ||= []).push(fn); };
  page.emit = (event, value) => { for (const fn of handlers[event] || []) fn(value); };
  let onPage = () => {};
  const context = { route: async () => {}, routeWebSocket: async () => {}, on: (event, fn) => { if (event === 'page') onPage = fn; },
    newPage: async () => { onPage(page); return page; }, pages: () => [page], close: async () => {} };
  let options = null;
  const browser = { newContext: async (o) => { options = o; return context; }, close: async () => {} };
  return { browser, effects, options: () => options, pageEmit: (event, value) => page.emit(event, value),
    setUrl: (next) => { url = next; }, screenshotCalls: () => screenshotCalls, disposals };
}

async function session({ dom, answers = [], secrets = {}, open = {}, failOn, onApproval } = {}) {
  const fake = fakeBrowser({ dom, failOn });
  const cards = [], logs = [];
  const executor = createBrowserExecutor({ launch: async () => fake.browser, secrets, log: (e) => logs.push(e),
    askApproval: async (card) => { cards.push(card); await onApproval?.(card, fake); return answers.shift() || 'deny'; } });
  const id = await executor.open({ jobId: 'job', allowedDomains: ['shop.example.test'], downloadsDir: temp(),
    proxy: { server: 'http://egress:8040', username: 'task', password: 'token' }, ...open });
  return { executor, id, act: (a) => executor.act(id, a), cards, logs, ...fake };
}

const submitButton = { tag: 'button', type: '', role: '', name: 'Show details', text: 'Show details', value: '', inForm: true, formMethod: 'post' };
const textField = { tag: 'input', type: 'text', name: 'Note', text: '', value: '', inForm: true, formMethod: 'post' };

test('a session is refused without allowed domains, a downloads directory or an egress grant', async () => {
  const executor = createBrowserExecutor({ launch: async () => fakeBrowser().browser, askApproval: async () => 'deny' });
  const base = { jobId: 'j', allowedDomains: ['shop.example.test'], downloadsDir: temp(), proxy: { server: 'http://egress:1' } };
  await assert.rejects(executor.open({ ...base, allowedDomains: [] }), (e) => e.status === 400);
  await assert.rejects(executor.open({ ...base, downloadsDir: '' }), (e) => e.status === 400);
  await assert.rejects(executor.open({ ...base, proxy: null }), (e) => e.status === 409 && /egress/.test(e.message));
  await assert.rejects(executor.open({ ...base, profile: { named: 'work' } }), (e) => e.status === 409);
  // Direct access has to be asked for when the executor is built, not per task.
  const direct = createBrowserExecutor({ launch: async () => fakeBrowser().browser, askApproval: async () => 'deny', direct: true });
  assert.ok(await direct.open({ ...base, proxy: null }));
});

test('each session is a fresh context behind its own proxy grant', async () => {
  const s = await session();
  assert.deepEqual(s.options().proxy, { server: 'http://egress:8040', username: 'task', password: 'token' });
  assert.equal(s.options().serviceWorkers, 'block');
});

test('the element is judged as it is, not as the model describes it', async () => {
  const s = await session({ dom: { '#b': submitButton } });
  const r = await s.act({ type: 'click', selector: '#b', text: 'harmless, just shows details', safe: true });
  assert.equal(s.cards.length, 1, 'asked');
  assert.match(s.cards[0].reason, /Submits a form/);
  assert.equal(s.cards[0].element.formMethod, 'post');
  assert.equal(r.status, 'blocked');
  assert.deepEqual(s.effects, [], 'declined: nothing clicked');
});

test('Allow once performs the action; a timeout or failure to answer does not', async () => {
  const yes = await session({ dom: { '#b': submitButton }, answers: ['approve'] });
  assert.equal((await yes.act({ type: 'click', selector: '#b' })).status, 'done');
  assert.deepEqual(yes.effects, [['click', '#b']]);
  for (const answer of ['timeout', 'aborted']) {
    const no = await session({ dom: { '#b': submitButton }, answers: [answer] });
    assert.equal((await no.act({ type: 'click', selector: '#b' })).status, 'blocked');
    assert.deepEqual(no.effects, []);
  }
});

test('each action disposes its element handle after approved, declined and policy-blocked outcomes', async () => {
  const approved = await session({ dom: { '#b': submitButton }, answers: ['approve'] });
  assert.equal((await approved.act({ type: 'click', selector: '#b' })).status, 'done');
  assert.deepEqual(approved.disposals, ['#b']);

  const declined = await session({ dom: { '#b': submitButton }, answers: ['deny'] });
  assert.equal((await declined.act({ type: 'click', selector: '#b' })).status, 'blocked');
  assert.deepEqual(declined.disposals, ['#b']);

  const blocked = await session({ dom: { '#f': textField }, secrets: { bank: { value: SECRET, domains: ['bank.example.test'] } } });
  assert.equal((await blocked.act({ type: 'type', selector: '#f', text: '{{secret:bank}}' })).status, 'blocked');
  assert.deepEqual(blocked.disposals, ['#f']);
});

test('a secret is typed only on its own site, and never appears in a result, card or log', async () => {
  const secrets = { shop: { value: SECRET, domains: ['shop.example.test'] }, bank: { value: 'bank-9981-x', domains: ['bank.example.test'] } };
  const s = await session({ dom: { '#f': textField, '#b': submitButton }, secrets, answers: ['approve'] });
  assert.equal((await s.act({ type: 'type', selector: '#f', text: 'pw {{secret:shop}}' })).status, 'done');
  assert.deepEqual(s.effects[0], ['fill', '#f', `pw ${SECRET}`]);
  const other = await s.act({ type: 'type', selector: '#f', text: '{{secret:bank}}' });
  assert.equal(other.status, 'blocked');
  assert.equal(s.effects.length, 1, "another site's secret is not typed at all");
  const shot = await s.act({ type: 'screenshot' });
  assert.equal(shot.evidence.screenshot, undefined);
  assert.equal(shot.evidence.screenshotOmitted, true);
  assert.match(shot.evidence.screenshotOmissionReason, /handled a secret/);
  assert.equal(s.screenshotCalls(), 0, 'the page is never captured after a secret, even if ordinary page content echoes it');
  await s.act({ type: 'click', selector: '#b' });
  assert.equal(s.cards[0].screenshot, undefined);
  assert.equal(s.cards[0].screenshotOmitted, true);
  const everything = JSON.stringify({ cards: s.cards, logs: s.logs, state: s.executor.state(s.id) });
  assert.ok(!everything.includes(SECRET) && !everything.includes('bank-9981-x'));
});

test('approval is invalidated when the exact target is replaced before dispatch', async () => {
  const dom = { '#b': submitButton };
  const s = await session({ dom, answers: ['approve'], onApproval: async () => {
    dom['#b'] = { ...submitButton, name: 'Replacement', text: 'Replacement' };
  } });
  const r = await s.act({ type: 'click', selector: '#b' });
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /approved target changed/);
  assert.deepEqual(s.effects, [], 'the replacement target is never clicked');
});

test('approval is invalidated when the page origin changes before dispatch', async () => {
  const s = await session({ dom: { '#b': submitButton }, answers: ['approve'], onApproval: async (_card, fake) => {
    fake.setUrl('https://partner.example.test/account');
  } });
  const r = await s.act({ type: 'click', selector: '#b' });
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /page changed/);
  assert.equal(r.origin, 'https://partner.example.test');
  assert.deepEqual(s.effects, [], 'nothing is clicked on the changed page');
});

test('only files given to the task upload, and only after asking', async () => {
  const dir = temp(), given = path.join(dir, 'given.txt'), other = path.join(dir, 'other.txt');
  fs.writeFileSync(given, 'x'); fs.writeFileSync(other, 'y');
  const fileInput = { tag: 'input', type: 'file', inForm: true };
  const s = await session({ dom: { '#u': fileInput }, answers: ['approve'], open: { uploadFiles: [given] } });
  assert.equal((await s.act({ type: 'upload', selector: '#u', file: other })).status, 'blocked');
  assert.equal((await s.act({ type: 'upload', selector: '#u', file: path.join(dir, '..', path.basename(dir), 'given.txt') })).status, 'done');
  assert.equal(s.cards.length, 1);
  assert.equal(s.cards[0].file, 'given.txt');
  assert.deepEqual(s.effects, [['upload', '#u', fs.realpathSync(given)]]);
});

test('navigation off the allowed list is blocked before anything happens', async () => {
  const s = await session();
  for (const url of ['https://evil.test/', 'http://10.0.0.1/', 'javascript:alert(1)', 'https://shop.example.test.evil.test/']) {
    assert.equal((await s.act({ type: 'navigate', url })).status, 'blocked', url);
  }
  assert.deepEqual(s.effects, []);
  assert.equal((await s.act({ type: 'navigate', url: ORIGIN + '/next' })).status, 'done');
});

test('an action that fails after it was dispatched is uncertain, not failed', async () => {
  const s = await session({ dom: { '#b': submitButton }, answers: ['approve'], failOn: 'click' });
  const r = await s.act({ type: 'click', selector: '#b' });
  assert.equal(r.status, 'uncertain');
});

test('unknown actions, missing elements and closed sessions do nothing', async () => {
  const s = await session();
  assert.equal((await s.act({ type: 'teleport' })).status, 'blocked');
  assert.equal((await s.act({ type: 'click', selector: '#missing' })).status, 'blocked');
  await s.executor.close(s.id);
  assert.equal((await s.act({ type: 'screenshot' })).status, 'blocked');
  assert.deepEqual(s.effects, []);
});

test('two downloads at once keep both files, each under its own number', async () => {
  const s = await session();
  const saved = [];
  const download = (name, delay) => ({ suggestedFilename: () => name, url: () => ORIGIN + '/' + name,
    saveAs: async (to) => { await new Promise((r) => setTimeout(r, delay)); saved.push(to); } });
  // Both fire before either save finishes, the slower one first.
  s.pageEmit('download', download('r.csv', 30));
  s.pageEmit('download', download('r.csv', 0));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(new Set(saved).size, 2, 'distinct paths');
  assert.deepEqual(s.executor.state(s.id).downloads.map((d) => path.basename(d.path)).sort(), ['1-r.csv', '2-r.csv']);
});
