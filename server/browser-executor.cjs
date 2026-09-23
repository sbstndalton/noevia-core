'use strict';
// BrowserExecutor (spec-agent-execution §6, "Executor interface"): open / act / close over a
// Playwright browser, with browser-policy.cjs deciding before every action.
//
// What this module owns, and why each piece is here rather than in the policy:
//   * The facts the policy judges come from the real DOM, read by the executor. A model names an
//     element; it never describes it. "Click the harmless button" that is really `type=submit`
//     is classified as a submit, because the executor looked.
//   * Where the page may go is enforced twice. Every request Playwright can route (subresources,
//     form posts, popups, WebSockets) is checked against the task's allowed list here, which is
//     what lets an action report "blocked" and the audit say what was refused. But Chromium
//     follows a server redirect without routing it — measured: the refused host was hit — so the
//     boundary is the egress proxy (code-egress.cjs, D15), which every hop goes through. A session
//     is refused without a proxy grant unless the executor was built for direct access on purpose.
//     After every action the page's own origin is checked too, and a page that ended up somewhere
//     it may not be is reported blocked and stepped back.
//   * Secrets are substituted only when the value is typed, only on an origin the secret is bound
//     to, and every piece of evidence (results, approval cards, the audit) is masked.
//   * Uploads come only from files the task was explicitly given; downloads land in the task's
//     own directory and are reported, never opened.
//
// Not wired to anything yet: there is no execution node, route, job or flag. Playwright is
// injected (`launch`), so the web app takes no browser dependency; a node that runs this brings
// its own. Only isolated profiles exist: a named, signed-in profile belongs to node pairing
// (spec §5), which is not built.
const fs = require('node:fs'), nodePath = require('node:path'), crypto = require('node:crypto');
const { classifyAction, checkNavigation, substituteSecrets, maskSecrets } = require('./browser-policy.cjs');

const ACTIONS = new Set(['navigate', 'click', 'type', 'select', 'press', 'upload', 'submit', 'extract',
  'screenshot', 'scroll', 'hover', 'wait']);
const ACTION_TIMEOUT_MS = 15000;
const MAX_EXTRACT = 20000;

// Runs in the page: what the element really is. Kept small and serialisable on purpose.
function describeInPage(el) {
  const text = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const labelled = el.getAttribute('aria-labelledby');
  const byId = labelled ? labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '';
  const label = el.labels && el.labels.length ? Array.from(el.labels).map((l) => l.textContent).join(' ') : '';
  const form = el.form || el.closest('form');
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || '',
    role: el.getAttribute('role') || '',
    name: text(el.getAttribute('aria-label') || byId || label || el.getAttribute('title') || el.getAttribute('alt') || ''),
    text: text(el.innerText || el.textContent || ''),
    value: el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) ? text(el.value) : '',
    inForm: !!form,
    formMethod: form ? (form.getAttribute('method') || 'get').toLowerCase() : '',
    formAction: form ? form.action : '',
  };
}

/**
 * @param {{launch: () => Promise<object>, askApproval: (card: object) => Promise<'approve'|'deny'|'timeout'|'aborted'>,
 *          secrets?: Record<string, {value: string, domains: string[]}>, log?: (entry: object) => void,
 *          timeoutMs?: number, direct?: boolean}} deps
 *   `direct: true` lets a session run without an egress proxy (development only: a server
 *   redirect then escapes the allowed list).
 */
function createBrowserExecutor({ launch, askApproval, secrets = {}, log = () => {}, timeoutMs = ACTION_TIMEOUT_MS, direct = false }) {
  if (typeof launch !== 'function') throw Error('A browser executor needs a browser to launch.');
  if (typeof askApproval !== 'function') throw Error('A browser executor needs an approval channel.');
  const sessions = new Map();
  let browser = null;
  const mask = (value) => maskSecrets(value, secrets);

  function sessionOf(id) {
    const s = sessions.get(id);
    if (!s) throw Object.assign(Error('No such browser session.'), { status: 404 });
    return s;
  }

  /**
   * @param {{jobId: string, profile?: 'isolated'|{named: string}, allowedDomains: string[], downloadsDir: string,
   *          uploadFiles?: string[], signal?: AbortSignal,
   *          proxy?: {server: string, username?: string, password?: string}}} task
   *   `proxy` is the task's egress grant (code-egress.cjs) for the same domains.
   * @returns {Promise<string>} session id
   */
  async function open({ jobId, profile = 'isolated', allowedDomains = [], downloadsDir, uploadFiles = [], signal, proxy = null } = {}) {
    if (profile !== 'isolated') throw Object.assign(Error('Named browser profiles need a paired execution node, which is not built.'), { status: 409 });
    if (!Array.isArray(allowedDomains) || !allowedDomains.length) throw Object.assign(Error('A browser task needs at least one allowed domain.'), { status: 400 });
    if (!downloadsDir) throw Object.assign(Error('A browser task needs its own downloads directory.'), { status: 400 });
    if (!proxy && !direct) throw Object.assign(Error('A browser task needs an egress proxy grant for its domains.'), { status: 409 });
    fs.mkdirSync(downloadsDir, { recursive: true, mode: 0o700 });
    const uploads = new Set(uploadFiles.map((f) => fs.realpathSync(f)));
    browser = browser || await launch();
    // A fresh context is an isolated profile: no cookies, storage or credentials from anything else.
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', ...(proxy ? { proxy } : {}) });
    const id = crypto.randomUUID();
    const session = { id, jobId, context, page: null, allowedDomains: [...allowedDomains], downloadsDir, uploads,
      blocked: [], downloads: [], closed: false, secretTyped: false, navBlocked: null };
    // Every request, not only the ones the model asked for. data:/blob: stay inside the page.
    const refuse = (req, url, reason) => {
      if (session.blocked.length < 100) session.blocked.push({ url: mask(url).slice(0, 300), reason });
      log({ event: 'browser.blocked', jobId, url: mask(url).slice(0, 300), reason });
      // A page leaving for a host it may not visit: the action that caused it reports blocked.
      if (req && req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame()) session.navBlocked = reason;
    };
    await context.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (/^(data|blob):/i.test(url)) return route.continue();
      const verdict = checkNavigation(url, session.allowedDomains);
      if (!verdict.ok) { refuse(req, url, verdict.reason); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    // WebSockets are not requests the route above sees.
    await context.routeWebSocket(/.*/, (ws) => {
      const url = ws.url().replace(/^ws/i, 'http');
      const verdict = checkNavigation(url, session.allowedDomains);
      if (verdict.ok) { ws.connectToServer(); return; }
      refuse(null, ws.url(), verdict.reason);
      ws.close({ code: 1008, reason: 'Not on this task’s allowed list.' });
    });
    context.on('page', (page) => {
      // Popups share the context's route rules; the session follows the newest page.
      session.page = page;
      page.on('download', (download) => { save(session, download).catch(() => {}); });
    });
    session.page = await context.newPage();
    sessions.set(id, session);
    if (signal) {
      if (signal.aborted) { await close(id); throw Object.assign(Error('Cancelled'), { status: 499 }); }
      signal.addEventListener('abort', () => { close(id).catch(() => {}); }, { once: true });
    }
    log({ event: 'browser.opened', jobId, session: id, allowedDomains: session.allowedDomains });
    return id;
  }

  async function save(session, download) {
    // The suggested name is the site's; only its base name is kept, inside the task's directory.
    const name = nodePath.basename(String(download.suggestedFilename() || 'download')).replace(/^\.+/, '') || 'download';
    const target = nodePath.join(session.downloadsDir, `${session.downloads.length + 1}-${name}`);
    await download.saveAs(target);
    session.downloads.push({ name, path: target, from: mask(download.url()).slice(0, 300) });
  }

  const originOf = (page) => { try { const u = new URL(page.url()); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; } };

  async function evidence(session, extra = {}) {
    // Once a secret has been typed on this page, form fields are painted over in every
    // screenshot: a plain text field would otherwise show the value itself.
    const fields = session.secretTyped ? [session.page.locator('input, textarea, select, [contenteditable]:not([contenteditable="false"])')] : [];
    const shot = await session.page.screenshot({ type: 'png', mask: fields }).catch(() => null);
    return { screenshot: shot ? shot.toString('base64') : undefined, ...extra };
  }

  /**
   * Run one action. The model's action names a `selector`; everything the gate judges is read here.
   * @returns {Promise<{status: 'done'|'blocked'|'needs_approval'|'uncertain', origin: string, reason?: string,
   *          evidence?: object, downloads?: object[]}>}
   */
  async function act(sessionId, action = {}) {
    const session = sessionOf(sessionId);
    if (session.closed) return { status: 'blocked', origin: '', reason: 'The browser session is closed.' };
    const { page } = session;
    const type = String(action.type || '');
    const origin = originOf(page);
    const result = (status, extra = {}) => {
      const out = { status, origin, ...extra };
      if (out.reason) out.reason = mask(out.reason);
      log({ event: 'browser.act', jobId: session.jobId, session: sessionId, type, status, origin, reason: out.reason || '' });
      return out;
    };
    if (!ACTIONS.has(type)) return result('blocked', { reason: `Unknown action “${mask(type).slice(0, 40)}”.` });

    // The element as it really is, never as the model described it.
    let element = null, locator = null;
    if (action.selector && type !== 'navigate') {
      locator = page.locator(String(action.selector)).first();
      try { element = await locator.evaluate(describeInPage, null, { timeout: timeoutMs }); }
      catch { return result('blocked', { reason: 'That element is not on the page.' }); }
    }
    const facts = { type, url: action.url, method: action.method, key: action.key, element: element || undefined };
    if (type === 'press' && !element) facts.element = await page.evaluate(() => {
      const el = document.activeElement; return { inForm: !!(el && (el.form || el.closest?.('form'))) };
    }).catch(() => ({ inForm: true })); // unknown focus: assume the worst, so Enter asks
    const verdict = classifyAction(facts, { origin, allowedDomains: session.allowedDomains });
    if (verdict.status === 'blocked') return result('blocked', { reason: verdict.reason });

    // Values the action would type, with secrets resolved for this origin — and only for it.
    let typed = null;
    if (type === 'type' || type === 'select') {
      const sub = substituteSecrets(String(action.text ?? action.value ?? ''), secrets, origin || 'about:blank');
      if (!sub.ok) return result('blocked', { reason: sub.reason });
      typed = sub.value;
      if (sub.used.length) session.secretTyped = true;
    }
    let file = null;
    if (type === 'upload') {
      try { file = fs.realpathSync(String(action.file || '')); } catch { file = null; }
      if (!file || !session.uploads.has(file)) return result('blocked', { reason: 'Only files given to this task can be uploaded.' });
    }

    if (verdict.status === 'needs_approval') {
      const card = {
        jobId: session.jobId, origin, action: type, reason: verdict.reason,
        element: element ? { ...element, text: mask(element.text), name: mask(element.name), value: mask(element.value), formAction: mask(element.formAction) } : null,
        url: action.url ? mask(action.url) : null,
        // What will be sent, as the human should see it: placeholders, not values.
        typed: typed === null ? null : mask(typed),
        file: file ? nodePath.basename(file) : null,
        ...(await evidence(session)),
      };
      const answer = await askApproval(card).catch(() => 'deny');
      log({ event: 'browser.decided', jobId: session.jobId, type, origin, decision: answer });
      if (answer !== 'approve') return result('blocked', { reason: 'Declined.' });
    }

    let dispatched = false;
    session.navBlocked = null;
    try {
      switch (type) {
        case 'navigate': dispatched = true; await page.goto(String(action.url), { timeout: timeoutMs }); break;
        case 'click': dispatched = true; await locator.click({ timeout: timeoutMs }); break;
        case 'hover': await locator.hover({ timeout: timeoutMs }); break;
        case 'type': dispatched = true; await locator.fill(typed, { timeout: timeoutMs }); typed = null; break;
        case 'select': dispatched = true; await locator.selectOption(typed, { timeout: timeoutMs }); typed = null; break;
        case 'press': dispatched = true; await (locator ? locator.press(String(action.key), { timeout: timeoutMs }) : page.keyboard.press(String(action.key))); break;
        case 'upload': dispatched = true; await locator.setInputFiles(file, { timeout: timeoutMs }); break;
        case 'submit': dispatched = true; await locator.evaluate((el) => { const f = el.form || el.closest('form') || el; f.requestSubmit ? f.requestSubmit() : f.submit(); }); break;
        case 'scroll': await page.mouse.wheel(0, Number(action.dy) || 600); break;
        case 'wait': await page.waitForTimeout(Math.min(Number(action.ms) || 500, 5000)); break;
        case 'extract': {
          const text = locator ? await locator.innerText({ timeout: timeoutMs }) : await page.innerText('body', { timeout: timeoutMs });
          return result('done', { evidence: { text: mask(String(text).slice(0, MAX_EXTRACT)) } });
        }
        case 'screenshot': return result('done', { evidence: await evidence(session) });
        default: break;
      }
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
      // Where the page actually is, whatever the route layer saw: a redirect it never saw ends
      // on the proxy's refusal at the refused address.
      const landed = session.page.url();
      const where = /^https?:/i.test(landed) ? checkNavigation(landed, session.allowedDomains) : { ok: true };
      if (!where.ok && !session.navBlocked) {
        session.navBlocked = where.reason;
        if (session.blocked.length < 100) session.blocked.push({ url: mask(landed).slice(0, 300), reason: where.reason });
      }
      if (session.navBlocked) {
        // Step back off the browser's error page, or the refused address, to where it was.
        const reason = session.navBlocked;
        if (!where.ok || !originOf(session.page)) await session.page.goBack({ timeout: timeoutMs }).catch(() => {});
        return result('blocked', { reason, origin: originOf(session.page) });
      }
    } catch (error) {
      if (session.navBlocked) {
        const reason = session.navBlocked;
        if (!originOf(session.page)) await session.page.goBack({ timeout: timeoutMs }).catch(() => {});
        return result('blocked', { reason, origin: originOf(session.page) });
      }
      // Once an action with effects was dispatched, a failure does not prove it did not happen.
      const reason = String(error?.message || error).split('\n')[0].slice(0, 200);
      return result(dispatched ? 'uncertain' : 'blocked', { reason, origin: originOf(session.page) });
    }
    return result('done', { origin: originOf(session.page), downloads: session.downloads.map(({ name, from }) => ({ name, from })) });
  }

  /** What the audit and the approval card show about a session, masked. */
  function state(sessionId) {
    const s = sessionOf(sessionId);
    return { origin: s.page ? originOf(s.page) : '', blocked: [...s.blocked], downloads: s.downloads.map(({ name, path, from }) => ({ name, path, from })), closed: s.closed };
  }

  async function close(sessionId) {
    const s = sessions.get(sessionId);
    if (!s || s.closed) return;
    s.closed = true;
    await s.context.close().catch(() => {});
    log({ event: 'browser.closed', jobId: s.jobId, session: sessionId });
  }

  async function shutdown() {
    for (const id of sessions.keys()) await close(id);
    if (browser) await browser.close().catch(() => {});
    browser = null;
  }

  return { open, act, close, state, shutdown };
}

module.exports = { createBrowserExecutor, describeInPage, ACTIONS };
