'use strict';
// BrowserExecutor policy (spec-agent-execution §6): what noevia decides before every browser
// action, independent of which executor (Playwright/CDP, Browser Use) eventually carries it out.
// Pure and deterministic on purpose — model output can REQUEST an action but never mark it safe,
// so nothing here reads model text as an instruction. The executor built around it is
// browser-executor.cjs; browser-service.cjs drives it and routes/browser.cjs serves it (admin-only, behind the
// browserExecutor flag).
//
// Three answers only: 'allow', 'needs_approval' (noevia's card: origin, element, typed values
// with secrets masked), 'blocked'. Anything unrecognised needs approval; nothing unrecognised is
// allowed.
//
// BROWSER_POLICY_IMPL=js|wasm (default js; any other value means js, with one warning), read from
// the `env` option (process.env) on every call. wasm also asks noevia-rs's browser-policy crate
// (dav-parse.wasm browser_policy) with the host's projections of the action, the element and the
// page. The JS answer is computed first and is never weakened: an action is allowed only if both
// allow it, asks if either asks, and is blocked if either blocks; an unknown (the port folds only
// the code points of its table), a fault, a bad reply or any other disagreement asks (and what the
// JS blocks stays blocked). checkNavigation and substituteSecrets have no approval step, so there
// a disagreement or fault refuses. The port never receives a secret value: substituteSecrets sends
// it the text, the secrets' names and domains, and the origin, and does the substitution itself.
// Warnings are logged once per event and reason and carry no input. The flag is in
// dav-parse-wasm.cjs IMPL_FLAGS (a missing or tampered module stops startup).
const net = require('node:net');
const { isPrivateIp } = require('./ssrf.cjs');

// Accessible names/text that mark a consequential control (spec §6), in the languages noevia's
// users are most likely to meet. Matched as whole words, case- and accent-insensitive.
const CONSEQUENTIAL = [
  // en
  'send', 'submit', 'pay', 'buy', 'purchase', 'order', 'checkout', 'check out', 'delete', 'remove',
  'publish', 'post', 'confirm', 'save settings', 'transfer', 'subscribe', 'unsubscribe', 'sign up',
  'place order', 'book', 'reserve', 'donate', 'merge', 'push', 'deploy', 'approve', 'accept', 'agree',
  // de
  'senden', 'absenden', 'bezahlen', 'kaufen', 'bestellen', 'loschen', 'entfernen', 'veroffentlichen',
  'bestatigen', 'speichern', 'uberweisen', 'zustimmen', 'akzeptieren',
  // fr
  'envoyer', 'payer', 'acheter', 'commander', 'supprimer', 'publier', 'confirmer', 'enregistrer', 'valider', 'accepter',
  // es
  'enviar', 'pagar', 'comprar', 'pedir', 'eliminar', 'borrar', 'publicar', 'confirmar', 'guardar', 'aceptar',
];
const fold = (text) => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const CONSEQUENTIAL_RE = new RegExp(`(^|[^a-z0-9])(${CONSEQUENTIAL.map((w) => w.replace(/ /g, '\\s+')).join('|')})([^a-z0-9]|$)`);

const READ_ONLY = new Set(['screenshot', 'extract', 'scroll', 'hover', 'wait']);

/** Host allowed when it equals an allowlisted domain or is a subdomain of one. */
function hostAllowed(host, allowedDomains) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return (allowedDomains || []).some((d) => { const dom = String(d).toLowerCase().replace(/^\*?\./, '').replace(/\.$/, ''); return dom && (h === dom || h.endsWith('.' + dom)); });
}

/**
 * Where the browser may go. Only http(s); never an IP literal on a private range, never
 * `localhost`; only allowlisted hosts. DNS-level rebinding is the egress proxy's job (D15).
 * @returns {{ok: true, origin: string} | {ok: false, reason: string}}
 */
function checkNavigationJs(rawUrl, allowedDomains) {
  let url; try { url = new URL(String(rawUrl)); } catch { return { ok: false, reason: 'Not a web address.' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: `${url.protocol} links are not opened.` };
  if (url.username || url.password) return { ok: false, reason: 'Addresses with embedded credentials are not opened.' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return { ok: false, reason: 'Local addresses are not opened.' };
  if (net.isIP(host) && isPrivateIp(host)) return { ok: false, reason: 'Private network addresses are not opened.' };
  if (!hostAllowed(host, allowedDomains)) return { ok: false, reason: `${host} is not on this task’s allowed list.` };
  return { ok: true, origin: url.origin };
}

/**
 * Classify one browser action before it runs.
 * @param {{type: string, url?: string, method?: string, key?: string, text?: string,
 *          element?: {tag?: string, type?: string, role?: string, name?: string, text?: string, inForm?: boolean, formMethod?: string}}} action
 * @param {{origin: string, allowedDomains: string[]}} page
 * @returns {{status: 'allow'|'needs_approval'|'blocked', reason: string}}
 */
function classifyActionJs(action = {}, page = {}) {
  const type = String(action.type || '');
  const el = action.element || {};
  if (READ_ONLY.has(type)) return { status: 'allow', reason: 'Read-only.' };
  if (type === 'navigate') {
    const nav = checkNavigationJs(action.url, page.allowedDomains);
    if (!nav.ok) return { status: 'blocked', reason: nav.reason };
    const post = String(action.method || 'GET').toUpperCase() !== 'GET';
    if (post && page.origin && nav.origin !== page.origin) return { status: 'needs_approval', reason: 'Sends data to another site.' };
    if (post) return { status: 'needs_approval', reason: 'Sends data.' };
    return { status: 'allow', reason: '' };
  }
  if (type === 'upload') return { status: 'needs_approval', reason: 'Uploads a file.' };
  if (type === 'submit') return { status: 'needs_approval', reason: 'Submits a form.' };
  const label = fold([el.name, el.text, el.value].filter(Boolean).join(' '));
  if (type === 'click') {
    const tag = fold(el.tag), kind = fold(el.type);
    // A <button> inside a form submits unless it says otherwise; so does <input type=submit|image>.
    const submits = kind === 'submit' || (tag === 'input' && kind === 'image') || (tag === 'button' && el.inForm && (!kind || kind === 'submit'));
    if (submits) return { status: 'needs_approval', reason: 'Submits a form.' };
    if (CONSEQUENTIAL_RE.test(label)) return { status: 'needs_approval', reason: `“${label.slice(0, 60)}” looks consequential.` };
    return { status: 'allow', reason: '' };
  }
  if (type === 'press') {
    // Keys are chords ("Shift+Enter", "NumpadEnter"): any Enter in a form can submit it, and
    // Space or Enter on a control activates it exactly like a click, so it is judged as one.
    const raw = String(action.key ?? '');
    const key = raw.length && !raw.trim() ? 'space' : fold(raw).replace(/\s+/g, '');
    const parts = key.split('+');
    const last = parts[parts.length - 1];
    const enter = /enter$/.test(last) || last === 'return';
    const activates = enter || last === 'space' || key.endsWith('+');
    const tag = fold(el.tag), kind = fold(el.type);
    const control = tag === 'button' || tag === 'a' || tag === 'summary' || ['button', 'link', 'menuitem', 'tab', 'switch', 'checkbox', 'radio', 'option'].includes(fold(el.role))
      || (tag === 'input' && ['submit', 'image', 'button', 'reset', 'checkbox', 'radio'].includes(kind));
    if (activates && control) return classifyActionJs({ ...action, type: 'click' }, page);
    if (enter && el.inForm) return { status: 'needs_approval', reason: 'Enter submits the form.' };
    return { status: 'allow', reason: '' };
  }
  if (type === 'type' || type === 'select') return { status: 'allow', reason: 'Nothing is sent until a submit, which asks.' };
  return { status: 'needs_approval', reason: `Unrecognised action “${type || 'none'}”.` };
}

const PLACEHOLDER = /\{\{secret:([A-Za-z0-9_.-]{1,64})\}\}/g;

/**
 * Put secrets into a value at execution time — only on an origin the secret is bound to. The
 * model only ever sees `{{secret:name}}`. An unknown secret, or a known one on the wrong origin,
 * blocks the action rather than typing the placeholder or leaking the value.
 * @param {string} text
 * @param {Record<string, {value: string, domains: string[]}>} secrets
 * @param {string} origin current page origin
 * @returns {{ok: true, value: string, used: string[]} | {ok: false, reason: string}}
 */
function substituteSecretsJs(text, secrets, origin) {
  let host; try { host = new URL(origin).hostname; } catch { return { ok: false, reason: 'No page origin.' }; }
  const used = [];
  let failure = null;
  const value = String(text ?? '').replace(PLACEHOLDER, (match, name) => {
    const secret = Object.prototype.hasOwnProperty.call(secrets || {}, name) ? secrets[name] : null;
    if (!secret) { failure = failure || `No secret named ${name}.`; return match; }
    if (!hostAllowed(host, secret.domains)) { failure = failure || `The ${name} secret is not for ${host}.`; return match; }
    used.push(name);
    return String(secret.value);
  });
  return failure ? { ok: false, reason: failure } : { ok: true, value, used };
}

/** For evidence and approval cards: every known secret value replaced by its placeholder. */
function maskSecrets(text, secrets) {
  let out = String(text ?? '');
  const entries = Object.entries(secrets || {}).filter(([, s]) => s && typeof s.value === 'string' && s.value.length >= 4)
    .sort((a, b) => b[1].value.length - a[1].value.length);
  for (const [name, s] of entries) {
    // The value as typed, and as it travels in a URL or a form body.
    const forms = new Set([s.value, encodeURIComponent(s.value), encodeURIComponent(s.value).replace(/%20/g, '+')]);
    for (const form of forms) out = out.split(form).join(`{{secret:${name}}}`);
  }
  return out;
}

// ── BROWSER_POLICY_IMPL ─────────────────────────────────────────────────────

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** BROWSER_POLICY_IMPL: 'js' (default) or 'wasm'. */
function browserPolicyImpl(env = process.env) {
  const raw = env?.BROWSER_POLICY_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[browser-policy] BROWSER_POLICY_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}
const defaultLoader = () => require('./dav-parse-wasm.cjs');
const implOf = ({ env = process.env, impl = browserPolicyImpl(env) } = {}) => impl;

const warnedPort = new Set();
function portWarn(event, reason) {
  const key = `${event}:${reason}`;
  if (warnedPort.has(key)) return;
  warnedPort.add(key);
  console.warn(`[browser-policy] ${event} (${reason}); the stricter answer was used`);
}

/** Asks the port; undefined (after a warning) when it throws. Projections are built inside, so a
 *  value that cannot be projected is a fault too. */
function ask(wasmLoader, fn) {
  try {
    return fn(wasmLoader());
  } catch (err) {
    portWarn('browser_policy.wasm_fault', String(err?.reason || 'unexpected').slice(0, 40));
    return undefined;
  }
}

// What the rules read, as the JS reads it: `fold(v)` is String(v || ''), the label keeps the
// truthy fields, `!!inForm`.
const textOf = (v) => (v ? String(v) : '');
/** `(domains || []).some(...)` reads each element of an array as String(d) (holes skipped). */
function domainsProjection(domains) {
  if (!domains) return [];
  if (!Array.isArray(domains)) throw Object.assign(Error('allowed domains are not a list'), { reason: 'domains' });
  return domains.filter(() => true).map((d) => String(d));
}
/** action: { type, url, method, key }; only the fields its type reads (null otherwise). */
function actionProjection(action, type) {
  return {
    type,
    url: type === 'navigate' ? String(action.url) : null,
    method: type === 'navigate' ? String(action.method || 'GET') : null,
    key: type === 'press' ? String(action.key ?? '') : null,
  };
}
function elementProjection(element) {
  const el = element || {};
  return { tag: textOf(el.tag), type: textOf(el.type), role: textOf(el.role), name: textOf(el.name), text: textOf(el.text),
    value: textOf(el.value), inForm: !!el.inForm };
}
/** page: origin as a string ('' when falsy, null for a truthy non-string, which equals nothing). */
function pageProjection(page, type) {
  const origin = typeof page.origin === 'string' ? page.origin : (page.origin ? null : '');
  return { origin, allowedDomains: type === 'navigate' ? domainsProjection(page.allowedDomains) : [] };
}
const SECRET_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** [[name, domains], ...] for every own property a placeholder could name whose value is truthy:
 *  never a value. */
function secretsProjection(secrets) {
  const all = secrets || {};
  const out = [];
  for (const name of Object.getOwnPropertyNames(Object(all))) {
    if (!SECRET_NAME.test(name)) continue;
    const secret = all[name];
    if (secret) out.push([name, domainsProjection(secret.domains)]);
  }
  return out;
}

const RANK = { allow: 0, needs_approval: 1, blocked: 2 };
const UNCHECKED_ACTION = 'This action could not be double-checked, so it asks first.';
const UNCHECKED_ADDRESS = 'This address could not be double-checked, so it is not opened.';
const UNCHECKED_SECRETS = 'The secrets in this value could not be double-checked, so nothing was typed.';

/** classifyActionJs; under BROWSER_POLICY_IMPL=wasm never more permissive than either answer, and
 *  any unknown, fault or disagreement asks at least. */
function classifyAction(action = {}, page = {}, { wasmLoader = defaultLoader, ...opts } = {}) {
  const js = classifyActionJs(action, page);
  if (js.status === 'blocked' || implOf(opts) !== 'wasm') return js;
  const port = ask(wasmLoader, (m) => {
    const type = String(action.type || '');
    return m.browserPolicyClassify(actionProjection(action, type), elementProjection(action.element), pageProjection(page, type));
  });
  if (port && port.status === js.status && port.reason === js.reason) return js;
  if (port === undefined) return js.status === 'allow' ? { status: 'needs_approval', reason: UNCHECKED_ACTION } : js;
  portWarn(port.status === null ? 'browser_policy.unknown' : 'browser_policy.impl_mismatch', port.status === null ? 'classify' : `${js.status}:${port.status}`);
  if (port.status !== null && RANK[port.status] > RANK[js.status]) return { status: port.status, reason: port.reason };
  return js.status === 'allow' ? { status: 'needs_approval', reason: UNCHECKED_ACTION } : js;
}

/** checkNavigationJs; under BROWSER_POLICY_IMPL=wasm a JS ok stands only when the port agrees on
 *  the origin too. There is no approval step here: a disagreement or fault refuses. */
function checkNavigation(rawUrl, allowedDomains, { wasmLoader = defaultLoader, ...opts } = {}) {
  const js = checkNavigationJs(rawUrl, allowedDomains);
  if (!js.ok || implOf(opts) !== 'wasm') return js;
  const port = ask(wasmLoader, (m) => m.browserPolicyNavigation(String(rawUrl), domainsProjection(allowedDomains)));
  if (port && port.ok && port.origin === js.origin) return js;
  if (port) portWarn('browser_policy.impl_mismatch', port.ok ? 'origin' : 'navigation');
  return { ok: false, reason: port && !port.ok ? port.reason : UNCHECKED_ADDRESS };
}

/** substituteSecretsJs; under BROWSER_POLICY_IMPL=wasm a JS ok stands only when the port, given the
 *  secrets' names and domains (never their values), allows the same placeholders. */
function substituteSecrets(text, secrets, origin, { wasmLoader = defaultLoader, ...opts } = {}) {
  const js = substituteSecretsJs(text, secrets, origin);
  if (!js.ok || implOf(opts) !== 'wasm') return js;
  const port = ask(wasmLoader, (m) => m.browserPolicySubstitute(String(text ?? ''), secretsProjection(secrets), String(origin)));
  if (port && port.ok && port.used.length === js.used.length && port.used.every((n, i) => n === js.used[i])) return js;
  if (port) portWarn('browser_policy.impl_mismatch', port.ok ? 'used' : 'secrets');
  return { ok: false, reason: port && !port.ok ? port.reason : UNCHECKED_SECRETS };
}

module.exports = { classifyAction, checkNavigation, hostAllowed, substituteSecrets, maskSecrets, CONSEQUENTIAL,
  classifyActionJs, checkNavigationJs, substituteSecretsJs, browserPolicyImpl, actionProjection, elementProjection,
  pageProjection, secretsProjection, domainsProjection, fold };
