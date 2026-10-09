#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for BROWSER_POLICY_IMPL: browser-policy.cjs's action, navigation
// and secret-origin rules. The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/browser-policy/tests/fixtures/browser-policy.v1.json); noevia-core CI compares them.
//   node tools/gen-browser-policy-fixtures.cjs > tests/fixtures/browser-policy.v1.json
//
// Each row is { op, wire, want } or { op, wire, want, strict: true }: `wire` is the JSON the host
// sends after the op byte (its projections, which are valid inputs for the JS too), `want` the
// exact reply text the port must give. All sites, labels and secret names are synthetic; the
// random ones come from a seeded mulberry32.
//
// Nothing recorded depends on ICU or on the dav-parse.wasm module (#1115). Every string a row folds
// is ASCII (NFKD and toLowerCase are the identity / ASCII-only there on every ICU) or holds a code
// point the port does not know (it answers null without tables); URLs are ASCII; an IP literal
// appears only where it is private (isPrivateIp, which is the Rust port, fails closed to private
// without the module, so the answer is the same either way). A row without `strict` is the JS's
// own answer. A `strict` row is where the port is stricter by design (see noevia-rs
// crates/browser-policy): a <button> in a form whose type is not button or reset, a local name
// with a trailing dot, or text the port does not know. Its `want` is the port's answer, computed
// here by the mirror below, and the generator checks it is never more permissive than the JS.

const path = require('node:path');
const bp = require(path.join(__dirname, '..', 'server', 'browser-policy.cjs'));
const { isPrivateIp } = require(path.join(__dirname, '..', 'server', 'ssrf.cjs'));
const net = require('node:net');

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xb805e);
const pick = (list) => list[Math.floor(rand() * list.length)];

// ── The port, mirrored without ICU ──────────────────────────────────────────
// browser_policy::KNOWN_RANGES.
const KNOWN = [[0x0000, 0x052f], [0x1e00, 0x1fff], [0x2000, 0x206f], [0x3000, 0x30ff], [0x4e00, 0x9fff], [0xac00, 0xd7a3],
  [0xff01, 0xff9f], [0x1f300, 0x1f6ff], [0x1f900, 0x1faff]];
const knownCp = (cp) => KNOWN.some(([a, b]) => cp >= a && cp <= b);
const ASCII = /^[\x00-\x7f]*$/;

let touched = false; // the row reached something the port answers more strictly
/** fold, or null where the port does not know the text. Known non-ASCII text is never recorded. */
function portFold(s) {
  if (ASCII.test(s)) return bp.fold(s);
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0xd800 && cp <= 0xdfff) || !knownCp(cp)) { touched = true; return null; }
  }
  throw Error(`known non-ASCII text in a fixture: ${JSON.stringify(s)}`);
}
const CONSEQUENTIAL_RE = new RegExp(`(^|[^a-z0-9])(${bp.CONSEQUENTIAL.map((w) => w.replace(/ /g, '\\s+')).join('|')})([^a-z0-9]|$)`);
const v = (status, reason) => ({ status, reason });
const UNKNOWN = v(null, '');

function portClick(el) {
  const tag = portFold(el.tag), kind = portFold(el.type);
  if (tag === null || kind === null) return UNKNOWN;
  const buttonSubmits = kind !== 'button' && kind !== 'reset';
  if (tag === 'button' && el.inForm && buttonSubmits && !(!kind || kind === 'submit')) touched = true;
  const submits = kind === 'submit' || (tag === 'input' && kind === 'image') || (tag === 'button' && el.inForm && buttonSubmits);
  if (submits) return v('needs_approval', 'Submits a form.');
  const label = portFold([el.name, el.text, el.value].filter(Boolean).join(' '));
  if (label === null) return UNKNOWN;
  if (CONSEQUENTIAL_RE.test(label)) return v('needs_approval', `“${label.slice(0, 60)}” looks consequential.`);
  return v('allow', '');
}
function portPress(a, el) {
  const raw = a.key;
  let key;
  if (raw.length && !raw.trim()) key = 'space';
  else {
    const f = portFold(raw);
    if (f === null) return UNKNOWN;
    key = f.replace(/\s+/g, '');
  }
  const parts = key.split('+');
  const last = parts[parts.length - 1];
  const enter = /enter$/.test(last) || last === 'return';
  const activates = enter || last === 'space' || key.endsWith('+');
  const tag = portFold(el.tag), kind = portFold(el.type), role = portFold(el.role);
  if (tag === null || kind === null || role === null) return UNKNOWN;
  const control = tag === 'button' || tag === 'a' || tag === 'summary' || ['button', 'link', 'menuitem', 'tab', 'switch', 'checkbox', 'radio', 'option'].includes(role)
    || (tag === 'input' && ['submit', 'image', 'button', 'reset', 'checkbox', 'radio'].includes(kind));
  if (activates && control) return portClick(el);
  if (enter && el.inForm) return v('needs_approval', 'Enter submits the form.');
  return v('allow', '');
}
const isLocal = (h) => h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local');
/** checkNavigation with the port's trailing-dot local rule. */
function portNav(rawUrl, domains) {
  let url; try { url = new URL(String(rawUrl)); } catch { return { ok: false, reason: 'Not a web address.' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: `${url.protocol} links are not opened.` };
  if (url.username || url.password) return { ok: false, reason: 'Addresses with embedded credentials are not opened.' };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  let end = host.length;
  while (end > 0 && host[end - 1] === '.') end--;
  if (isLocal(host) || isLocal(host.slice(0, end))) {
    if (!isLocal(host)) touched = true;
    return { ok: false, reason: 'Local addresses are not opened.' };
  }
  if (net.isIP(host)) {
    if (!isPrivateIp(host)) throw Error(`a public IP literal in a fixture: ${rawUrl}`);
    return { ok: false, reason: 'Private network addresses are not opened.' };
  }
  if (!bp.hostAllowed(host, domains)) return { ok: false, reason: `${host} is not on this task’s allowed list.` };
  return { ok: true, origin: url.origin };
}
function portClassify(a, el, page) {
  const type = a.type;
  if (['screenshot', 'extract', 'scroll', 'hover', 'wait'].includes(type)) return v('allow', 'Read-only.');
  if (type === 'navigate') {
    const nav = portNav(a.url, page.allowedDomains);
    if (!nav.ok) return v('blocked', nav.reason);
    const post = a.method.toUpperCase() !== 'GET';
    const elsewhere = page.origin === null || (page.origin !== '' && nav.origin !== page.origin);
    if (post && elsewhere) return v('needs_approval', 'Sends data to another site.');
    if (post) return v('needs_approval', 'Sends data.');
    return v('allow', '');
  }
  if (type === 'upload') return v('needs_approval', 'Uploads a file.');
  if (type === 'submit') return v('needs_approval', 'Submits a form.');
  if (type === 'click') return portClick(el);
  if (type === 'press') return portPress(a, el);
  if (type === 'type' || type === 'select') return v('allow', 'Nothing is sent until a submit, which asks.');
  return v('needs_approval', `Unrecognised action “${type || 'none'}”.`);
}

// ── Rows ────────────────────────────────────────────────────────────────────
const RANK = { allow: 0, needs_approval: 1, blocked: 2 };
const rows = [];
const seen = new Set();
function push(op, args, want, strict) {
  const wire = JSON.stringify(args);
  const key = `${op}:${wire}`;
  if (seen.has(key)) return;
  seen.add(key);
  const row = { op, wire, want: JSON.stringify(want) };
  if (strict) row.strict = true;
  rows.push(row);
}

/** The JS reads of a projection are the projection itself (null origin: a truthy non-string). */
function classifyRow(action, element, page) {
  const type = String(action.type || '');
  const a = bp.actionProjection(action, type), e = bp.elementProjection(element), p = bp.pageProjection(page, type);
  touched = false;
  const port = portClassify(a, e, p);
  const js = bp.classifyActionJs({ ...action, element }, page);
  if (!touched) {
    if (port.status !== js.status || port.reason !== js.reason) throw Error(`mirror differs from the JS: ${JSON.stringify([a, e, p, port, js])}`);
  } else if (port.status !== null && RANK[port.status] < RANK[js.status]) {
    throw Error(`port more permissive than the JS: ${JSON.stringify([a, e, p, port, js])}`);
  }
  push(1, [a, e, p], port, touched && (port.status !== js.status || port.reason !== js.reason));
}
function navRow(url, domains) {
  touched = false;
  const port = portNav(url, domains);
  const js = bp.checkNavigationJs(url, domains);
  if (!touched && JSON.stringify(port) !== JSON.stringify(js)) throw Error(`mirror differs: ${url}`);
  if (port.ok && !js.ok) throw Error(`port more permissive: ${url}`);
  push(2, [url, domains], port, touched);
}
function subRow(text, secrets, origin) {
  const js = bp.substituteSecretsJs(text, secrets, origin);
  const want = js.ok ? { ok: true, used: js.used } : { ok: false, reason: js.reason };
  push(3, [text, bp.secretsProjection(secrets), origin], want, false);
}
function foldRow(texts) {
  touched = false;
  const folded = texts.map(portFold);
  push(4, [texts], { folded }, touched);
}

// Navigation.
const DOMAINS = [['example.com', 'docs.python.org'], ['*.example.com'], ['.example.com.'], ['EXAMPLE.COM'], [], ['com'], ['*.'], ['.'], [''],
  ['corp.internal', 'nas.local'], ['localhost'], ['example.com', 'x.localhost'], ['ex-ample.co.uk'], ['a.b.c.d.e']];
const URLS = ['https://example.com/a', 'https://shop.example.com/cart', 'https://EXAMPLE.com/', 'https://example.com./', 'https://example.com../',
  'https://example.com:443/', 'https://example.com:8443/x', 'http://example.com:80/', 'http://example.com:0/', 'https://a.b.example.com/?q=1#h',
  'https://example.com.evil.net/', 'https://notexample.com/', 'https://evil.net/?next=example.com', 'https://evil.net/#@example.com',
  'https://example.com@evil.net/', 'https://user:pw@example.com/', 'https://user@example.com/', 'https://:pw@example.com/', 'https://@example.com/',
  'https://:@example.com/', 'javascript:alert(1)', 'JavaScript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'blob:https://example.com/x',
  'ftp://example.com/', 'ws://example.com/', 'wss://example.com/', 'about:blank', 'mailto:a@example.com', 'not a url', '', '//example.com/', '/path',
  'https://', 'https:///x', 'http:example.com', 'https:\\\\example.com\\x', 'HTTPS://EXAMPLE.COM/A', '  https://example.com/  ', 'https://exa\tmple.com/',
  'https://exa\nmple.com/', 'https://example.com/%2e%2e/x', 'https://ex%61mple.com/', 'https://example%2Ecom/', 'http://localhost:8080/',
  'http://LOCALHOST/', 'http://localhost./', 'http://localhost../', 'http://a.localhost/', 'http://a.localhost./', 'http://corp.internal/',
  'http://corp.internal./', 'http://nas.local/', 'http://nas.local./', 'http://nas.local.:8080/', 'http://internal/', 'http://local/',
  'http://127.0.0.1/', 'http://127.1/', 'http://0x7f.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/',
  'http://172.16.0.1/', 'http://169.254.169.254/latest', 'http://0.0.0.0/', 'http://0/', 'http://[::1]/', 'http://[::]/', 'http://[fe80::1]/',
  'http://[::ffff:127.0.0.1]/', 'http://[fc00::1]/', 'http://127.0.0.1./', 'http://1.2.3.4.5/', 'http://256.0.0.1/',
  'https://example.com/' + 'a'.repeat(3000), 'https://' + 'a.'.repeat(60) + 'example.com/', 'https://xexample.com/', 'https://example.co/',
  'https://docs.python.org/3/', 'https://ex-ample.co.uk/', 'https://a.b.c.d.e/', 'https://b.c.d.e/', 'https://com/', 'https://x.com/',
  'https://exa_mple.com/', 'https://exa mple.com/', 'https://example.com:99999/', 'https://example.com:/', 'http://[::1/', 'http://a b/'];
for (const url of URLS) for (const d of DOMAINS) navRow(url, d);

// Actions.
const PAGES = [{ origin: 'https://shop.example.com', allowedDomains: ['example.com', 'docs.python.org'] }, { origin: '', allowedDomains: ['example.com'] },
  { origin: {}, allowedDomains: ['example.com'] }, { origin: 'https://example.com', allowedDomains: ['example.com'] }, { origin: 'https://example.com', allowedDomains: [] },
  { origin: 'https://example.com', allowedDomains: null }, { origin: 0, allowedDomains: ['corp.internal', 'example.com'] }];
const METHODS = [undefined, 'GET', 'get', 'Get', 'POST', 'post', 'PUT', 'DELETE', '', 'GET ', ' GET', 'GETS', 'GE', 0, null];
for (const page of PAGES) {
  for (const url of URLS.slice(0, 60)) classifyRow({ type: 'navigate', url, method: pick(METHODS) }, undefined, page);
  for (const method of METHODS) {
    classifyRow({ type: 'navigate', url: 'https://example.com/login', method }, undefined, page);
    classifyRow({ type: 'navigate', url: 'https://docs.python.org/x', method }, undefined, page);
    classifyRow({ type: 'navigate', url: 'https://shop.example.com/x', method }, undefined, page);
  }
}
classifyRow({ type: 'navigate' }, undefined, PAGES[0]);
classifyRow({ type: 'navigate', url: null }, undefined, PAGES[0]);

const TYPES = ['navigate', 'click', 'press', 'type', 'select', 'upload', 'submit', 'screenshot', 'extract', 'scroll', 'hover', 'wait', 'evaluate_js', '',
  'Click', 'NAVIGATE', 'press ', ' click', 'drag', 'none', 'constructor', '__proto__', 'toString'];
for (const type of TYPES) for (const page of PAGES.slice(0, 2)) classifyRow({ type, url: 'https://example.com/', key: 'Enter' }, { tag: 'button', inForm: true, text: 'Send' }, page);
classifyRow({}, undefined, PAGES[0]);
classifyRow({ type: 0 }, undefined, PAGES[0]);
classifyRow({ type: null }, undefined, PAGES[0]);
classifyRow({ type: false }, undefined, PAGES[0]);

const TAGS = ['button', 'a', 'input', 'summary', 'div', 'span', 'BUTTON', ' Button ', 'select', 'textarea', '', 'label', 'form', 'Input'];
const ETYPES = ['', 'submit', 'button', 'reset', 'image', 'text', 'checkbox', 'radio', 'SUBMIT', 'xyz', 'Submit ', 'menu', 'Button', 'IMAGE', 'password', 'sub mit'];
const ROLES = ['', 'button', 'link', 'menuitem', 'tab', 'switch', 'checkbox', 'radio', 'option', 'BUTTON', ' link ', 'menu', 'presentation', 'menuitemcheckbox'];
const LABELS = ['', 'Send', 'Pay now', 'Buy', 'Place order', 'Place  order', 'place\torder', 'Delete repository', 'Publish', 'Save settings', 'Accept all cookies',
  'Jetzt kaufen', 'Loschen', 'Bestatigen', 'Supprimer', 'Envoyer le message', 'Comprar ahora', 'Eliminar cuenta', 'Next page', 'Read more', 'Documentation',
  'Facebook', 'Posts', 'Sender details', 'Menu', 'Check out', 'check-out', 'checkout', 'CHECKOUT!', 'sign up', 'signup', 'Sign_up', 'x-send-y', 'send2',
  '2send', 'resend', 'Sending', 'pay.', '(buy)', 'buy/sell', 'Order #123', 'order123', 'Save', 'Save settings now', 'settings save', 'book a table',
  'Booking', 'Unsubscribe', 'Subscribe!', 'Push notifications', 'merge pull request', 'Deploy to production', 'I agree', 'Approve', 'pedir', 'borrar',
  'guardar', 'aceptar', 'payer', 'acheter', 'valider', 'zustimmen', 'akzeptieren', 'speichern', 'uberweisen', 'veroffentlichen', 'Remove item',
  'Transfer funds', 'Reserve', 'Donate', 'Confirm', 'Submit', 'Post comment', 'Purchase', 'a'.repeat(70) + ' send', 'send ' + 'b'.repeat(70),
  'Close', 'Cancel', 'OK', 'Yes', 'Continue', ' ', 'ﬁnish', 'x\ud800', 'Se\ud83c', '؀ send', 'ok ﬃ'];
for (let i = 0; i < 2500; i++) {
  const element = { tag: pick(TAGS), type: pick(ETYPES), role: pick(ROLES), inForm: rand() < 0.5 };
  for (const k of ['name', 'text', 'value']) if (rand() < 0.5) element[k] = pick(LABELS);
  if (rand() < 0.05) element.inForm = pick([1, 0, 'yes', '', null]);
  const known = (s) => s === undefined || ASCII.test(s) || [...s].some((ch) => { const cp = ch.codePointAt(0); return (cp >= 0xd800 && cp <= 0xdfff) || !knownCp(cp); });
  if (!['name', 'text', 'value'].every((k) => known(element[k]))) continue; // only ASCII or unknown text (U+00A0 is known)
  classifyRow({ type: 'click' }, element, pick(PAGES));
}
// Every tag/type/inForm combination with a plain label, and the first labels with no element facts.
for (const tag of TAGS) for (const type of ETYPES) for (const inForm of [true, false]) classifyRow({ type: 'click' }, { tag, type, inForm, text: 'Next' }, PAGES[0]);
for (const text of LABELS.filter((l) => ASCII.test(l) || l.includes('ﬁ') || l.includes('\ud800'))) {
  classifyRow({ type: 'click' }, { text }, PAGES[0]);
  classifyRow({ type: 'click' }, { name: text, text: 'x', value: '' }, PAGES[0]);
}
classifyRow({ type: 'click' }, { tag: 'a', text: 7 }, PAGES[0]);
classifyRow({ type: 'click' }, { tag: 'a', name: ['pay', 'now'] }, PAGES[0]);
classifyRow({ type: 'click' }, { tag: 'ﬁ', text: 'x' }, PAGES[0]);
classifyRow({ type: 'click' }, { tag: 'button', type: 'ﬁ', inForm: true }, PAGES[0]);
classifyRow({ type: 'click' }, 'not an object', PAGES[0]);
classifyRow({ type: 'click' }, null, PAGES[0]);

const KEYS = ['Enter', 'NumpadEnter', 'Shift+Enter', 'Control+Enter', 'Return', 'return', ' ', '  ', '\t', '\n', 'Space', 'space', 'Tab', 'a', '+', 'Control++',
  'Shift+', 'Enter+a', 'enter ', 'En ter', 'RETURN', 'KP_Enter', 'Spacebar', '', 'Shift+Space', 'Meta+Return', 'Enter+', 'Shift + Enter', 'S p a c e',
  'Escape', 'ArrowDown', 'Control+a', 'Center', 'enterprise', 'returns', 'x+return', 'ﬁ', 'Enter\ud800', 0, null, undefined, 13];
const PRESS_ELEMENTS = [{ tag: 'input', inForm: true }, { tag: 'input', type: 'text', inForm: true }, { tag: 'input', type: 'submit', name: 'Go' },
  { tag: 'button', inForm: true }, { tag: 'button', name: 'Delete account' }, { tag: 'button', type: 'button', inForm: true, text: 'Show' },
  { tag: 'button', type: 'xyz', inForm: true, text: 'Next' }, { tag: 'a', text: 'Send' }, { tag: 'a', text: 'Home' }, { tag: 'summary', text: 'Pay' },
  { role: 'button', name: 'Pay' }, { role: 'link', text: 'Read' }, { role: 'option', text: 'Order' }, { tag: 'div', inForm: true }, { tag: 'div' },
  { inForm: true }, {}, { tag: 'input', type: 'checkbox', inForm: true, name: 'Accept' }, { tag: 'input', type: 'reset', inForm: true },
  { tag: 'input', type: 'image', inForm: false }, { tag: 'textarea', inForm: true }, { tag: 'select', inForm: true, role: 'listbox' },
  { tag: 'input', type: 'radio', name: 'Buy' }, { role: 'ﬁ', inForm: true }];
for (const key of KEYS) for (const element of PRESS_ELEMENTS) classifyRow({ type: 'press', key }, element, PAGES[0]);
classifyRow({ type: 'press' }, { tag: 'button', inForm: true }, PAGES[0]);

// Secrets.
const SECRETS = [{ github_token: { value: 'ghp_abcdef123456', domains: ['github.com'] } },
  { a: { value: 'one1', domains: ['example.com', '*.github.com'] }, 'b.c-d_e': { value: 'two2', domains: [] }, z: null, y: 0, x: { value: 'v', domains: null } },
  {}, null, { __proto__: null, k: { value: 'kkkk', domains: ['EXAMPLE.com.'] } }, { ['A'.repeat(64)]: { value: 'long', domains: ['example.com'] } }];
const TEXTS = ['token={{secret:github_token}}', '{{secret:github_token}}', '{{secret:missing}}', '{{secret:__proto__}}', 'plain text', '',
  '{{secret:a}}{{secret:b.c-d_e}}', '{{secret:b.c-d_e}}{{secret:a}}', '{{secret:z}}', '{{secret:y}}', '{{secret:x}}', '{{secret:k}}', '{{ secret:a }}',
  '{secret:a}', '{{{secret:a}}}', '{{secret:a}}}', '{{secret:}}', '{{secret:a b}}', '{{SECRET:a}}', '{{secret:a}', `{{secret:${'A'.repeat(64)}}}`,
  `{{secret:${'A'.repeat(65)}}}`, '{{secret:a}}{{secret:missing}}{{secret:github_token}}', '{{secret:{{secret:a}}}}', '{{secret:a}}'.repeat(50),
  '{{secret:constructor}}', '{{secret:toString}}', '{{secret:hasOwnProperty}}', '{{secret:length}}', '{{secret:0}}'];
const ORIGINS = ['https://api.github.com', 'https://github.com', 'https://github.com.evil.net', 'https://example.com', 'https://x.example.com',
  'about:blank', 'not a url', '', 'https://EXAMPLE.COM', 'http://example.com:8080', 'https://[::1]', 'file:///x', 'https://gist.github.com'];
for (const secrets of SECRETS) for (const text of TEXTS) for (const origin of ORIGINS) subRow(text, secrets, origin);
subRow('{{secret:0}}{{secret:length}}', 'abc', 'https://example.com');

// Folds.
for (const l of LABELS) if (ASCII.test(l) || l.includes('ﬁ') || l.includes('\ud800')) foldRow([l]);
foldRow([' \t\n\v\f\r x  y ', 'A\u000bB', 'MiXeD CaSe 123', '', '   ']);
foldRow(['؀', 'ﬁ', 'x\udc00', '\ud83d', '\u{10000}', '\u{1fb00}', 'a֐b']);
foldRow(TAGS.concat(ETYPES, ROLES, KEYS.filter((k) => typeof k === 'string' && ASCII.test(k))));

const counts = rows.reduce((m, r) => { const k = `${r.op}${r.strict ? 's' : ''}`; m[k] = (m[k] || 0) + 1; return m; }, {});
for (const k of ['1', '1s', '2', '2s', '3', '4', '4s']) if (!counts[k]) throw Error(`no ${k} rows`);
const want = (status) => rows.filter((r) => r.op === 1 && JSON.parse(r.want).status === status).length;
if (want('allow') < 300 || want('needs_approval') < 300 || want('blocked') < 300 || want(null) < 20) throw Error(`thin coverage ${JSON.stringify(counts)}`);

process.stdout.write(`${JSON.stringify({ version: 1, rows })}\n`);
