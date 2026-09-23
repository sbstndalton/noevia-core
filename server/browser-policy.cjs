'use strict';
// BrowserExecutor policy (spec-agent-execution §6): what noevia decides before every browser
// action, independent of which executor (Playwright/CDP, Browser Use) eventually carries it out.
// Pure and deterministic on purpose — model output can REQUEST an action but never mark it safe,
// so nothing here reads model text as an instruction. The executor built around it is
// browser-executor.cjs; neither is wired to a route, job or flag yet (no execution node exists).
//
// Three answers only: 'allow', 'needs_approval' (noevia's card: origin, element, typed values
// with secrets masked), 'blocked'. Anything unrecognised needs approval; nothing unrecognised is
// allowed.
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
function checkNavigation(rawUrl, allowedDomains) {
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
function classifyAction(action = {}, page = {}) {
  const type = String(action.type || '');
  const el = action.element || {};
  if (READ_ONLY.has(type)) return { status: 'allow', reason: 'Read-only.' };
  if (type === 'navigate') {
    const nav = checkNavigation(action.url, page.allowedDomains);
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
    if (activates && control) return classifyAction({ ...action, type: 'click' }, page);
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
function substituteSecrets(text, secrets, origin) {
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

module.exports = { classifyAction, checkNavigation, hostAllowed, substituteSecrets, maskSecrets, CONSEQUENTIAL };
