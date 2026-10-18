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
// The rules themselves are noevia-rs's browser-policy crate (dav-parse.wasm browser_policy), always:
// BROWSER_POLICY_IMPL was retired in #1071 and the JS rules (classifyActionJs, checkNavigationJs,
// substituteSecretsJs and the word lists and folding behind them) deleted. This module sends the
// crate the host's projections of the action, the element the executor read and the page, and
// applies its answer alone. The crate folds only the code points of its table, so for text outside
// it the answer is "unknown": a click, press or other action then asks, and a navigation is not
// opened; a fault, a refusal or a bad reply gives the same strict result. checkNavigation and
// substituteSecrets have no approval step, so there an unknown or a fault refuses. The crate never
// receives a secret value: substituteSecrets sends it the text, the secrets' names and domains and
// the origin, and this module puts the values in only for the placeholders the crate allowed, in
// the order it named them (anything else refuses). Warnings are logged once per event and reason
// and carry no input. A missing or tampered module stops startup.

const defaultLoader = () => require('./dav-parse-wasm.cjs');

const PLACEHOLDER = /\{\{secret:([A-Za-z0-9_.-]{1,64})\}\}/g;

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


const UNCHECKED_ACTION = 'This action could not be double-checked, so it asks first.';
const UNCHECKED_ADDRESS = 'This address could not be double-checked, so it is not opened.';
const UNCHECKED_SECRETS = 'The secrets in this value could not be double-checked, so nothing was typed.';

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

/**
 * Classify one browser action before it runs, by the port.
 * @param {{type: string, url?: string, method?: string, key?: string, text?: string,
 *          element?: {tag?: string, type?: string, role?: string, name?: string, text?: string, inForm?: boolean, formMethod?: string}}} action
 * @param {{origin: string, allowedDomains: string[]}} page
 * @returns {{status: 'allow'|'needs_approval'|'blocked', reason: string}}
 *   Unknown to the port, a fault or a bad reply: a navigation is blocked (it might be), any other action asks.
 */
function classifyAction(action = {}, page = {}, { wasmLoader = defaultLoader } = {}) {
  const port = ask(wasmLoader, (m) => {
    const type = String(action.type || '');
    return m.browserPolicyClassify(actionProjection(action, type), elementProjection(action.element), pageProjection(page, type));
  });
  if (port && port.status !== null) return { status: port.status, reason: port.reason };
  if (port) portWarn('browser_policy.unknown', 'classify');
  return String(action.type || '') === 'navigate' ? { status: 'blocked', reason: UNCHECKED_ADDRESS } : { status: 'needs_approval', reason: UNCHECKED_ACTION };
}

/**
 * Where the browser may go, by the port. Only http(s); never an IP literal on a private range, never
 * `localhost`; only allowlisted hosts. DNS-level rebinding is the egress proxy's job (D15). There is
 * no approval step here: a fault refuses.
 * @returns {{ok: true, origin: string} | {ok: false, reason: string}}
 */
function checkNavigation(rawUrl, allowedDomains, { wasmLoader = defaultLoader } = {}) {
  const port = ask(wasmLoader, (m) => m.browserPolicyNavigation(String(rawUrl), domainsProjection(allowedDomains)));
  return port || { ok: false, reason: UNCHECKED_ADDRESS };
}

/**
 * Put secrets into a value at execution time — only on an origin the secret is bound to. The
 * model only ever sees `{{secret:name}}`. The port decides which placeholders may be filled here
 * (it is given the names and domains, never the values); an unknown secret, or a known one on the
 * wrong origin, blocks the action rather than typing the placeholder or leaking the value.
 * @param {string} text
 * @param {Record<string, {value: string, domains: string[]}>} secrets
 * @param {string} origin current page origin
 * @returns {{ok: true, value: string, used: string[]} | {ok: false, reason: string}}
 */
function substituteSecrets(text, secrets, origin, { wasmLoader = defaultLoader } = {}) {
  const port = ask(wasmLoader, (m) => m.browserPolicySubstitute(String(text ?? ''), secretsProjection(secrets), String(origin)));
  if (!port) return { ok: false, reason: UNCHECKED_SECRETS };
  if (!port.ok) return { ok: false, reason: port.reason };
  // The values go in only for the placeholders the port named, in its order; anything else refuses.
  const source = String(text ?? '');
  const names = [...source.matchAll(PLACEHOLDER)].map((m) => m[1]);
  const known = names.every((name) => Object.prototype.hasOwnProperty.call(secrets || {}, name) && secrets[name]);
  if (!known || names.length !== port.used.length || names.some((name, i) => name !== port.used[i])) {
    portWarn('browser_policy.impl_mismatch', 'used');
    return { ok: false, reason: UNCHECKED_SECRETS };
  }
  const value = source.replace(PLACEHOLDER, (_match, name) => String(secrets[name].value));
  return { ok: true, value, used: port.used };
}

module.exports = { classifyAction, checkNavigation, substituteSecrets, maskSecrets, actionProjection, elementProjection,
  pageProjection, secretsProjection, domainsProjection };
