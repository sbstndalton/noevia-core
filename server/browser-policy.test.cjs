'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { classifyAction, checkNavigation, substituteSecrets, maskSecrets } = require('./browser-policy.cjs');

const page = { origin: 'https://shop.example.com', allowedDomains: ['example.com', 'docs.python.org'] };
const status = (action) => classifyAction(action, page).status;

test('navigation: allowlisted hosts and subdomains only; lookalikes, local and private addresses blocked', () => {
  assert.equal(status({ type: 'navigate', url: 'https://example.com/a' }), 'allow');
  assert.equal(status({ type: 'navigate', url: 'https://shop.example.com/cart' }), 'allow');
  for (const url of ['https://example.com.evil.net/', 'https://notexample.com/', 'https://evil.net/?next=example.com',
    'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'http://localhost:8080/', 'http://127.0.0.1/',
    'http://10.0.0.5/', 'http://[::1]/', 'http://169.254.169.254/latest', 'https://user:pw@example.com/', 'http://nas.local/', 'not a url']) {
    assert.equal(status({ type: 'navigate', url }), 'blocked', url);
  }
  assert.equal(checkNavigation('https://docs.python.org/3/', page.allowedDomains).ok, true);
});

test('sending data by navigation asks, and says so when it goes to another site', () => {
  assert.equal(status({ type: 'navigate', url: 'https://example.com/login', method: 'POST' }), 'needs_approval');
  assert.match(classifyAction({ type: 'navigate', url: 'https://docs.python.org/x', method: 'POST' }, page).reason, /another site/);
});

test('form submits ask however they happen', () => {
  assert.equal(status({ type: 'submit' }), 'needs_approval');
  assert.equal(status({ type: 'click', element: { tag: 'input', type: 'submit', name: 'Go' } }), 'needs_approval');
  assert.equal(status({ type: 'click', element: { tag: 'input', type: 'image' } }), 'needs_approval');
  assert.equal(status({ type: 'click', element: { tag: 'button', inForm: true, text: 'Next' } }), 'needs_approval', 'a form button submits by default');
  assert.equal(status({ type: 'click', element: { tag: 'button', type: 'button', inForm: true, text: 'Show password' } }), 'allow');
  assert.equal(status({ type: 'press', key: 'Enter', element: { tag: 'input', inForm: true } }), 'needs_approval');
  assert.equal(status({ type: 'press', key: 'Tab', element: { inForm: true } }), 'allow');
});

test('consequential controls ask in several languages; ordinary ones do not', () => {
  for (const text of ['Send', 'Pay now', 'Buy', 'Place order', 'Delete repository', 'Publish', 'Save settings', 'Accept all cookies',
    'Jetzt kaufen', 'Löschen', 'Bestätigen', 'Supprimer', 'Envoyer le message', 'Comprar ahora', 'Eliminar cuenta']) {
    assert.equal(status({ type: 'click', element: { tag: 'a', text } }), 'needs_approval', text);
  }
  for (const text of ['Next page', 'Read more', 'Documentation', 'Facebook', 'Posts', 'Sender details', 'Menu']) {
    assert.equal(status({ type: 'click', element: { tag: 'a', text } }), 'allow', text);
  }
  assert.equal(status({ type: 'click', element: { role: 'button', name: 'Pay' } }), 'needs_approval', 'accessible name counts');
});

test('uploads ask; reading, typing and choosing do not; unknown actions ask', () => {
  assert.equal(status({ type: 'upload' }), 'needs_approval');
  for (const type of ['screenshot', 'extract', 'scroll', 'type', 'select']) assert.equal(status({ type }), 'allow', type);
  assert.equal(status({ type: 'evaluate_js' }), 'needs_approval');
  assert.equal(status({}), 'needs_approval');
});

test('secrets are substituted only on their own site, and never shown back', () => {
  const secrets = { github_token: { value: 'ghp_abcdef123456', domains: ['github.com'] } };
  assert.deepEqual(substituteSecrets('token={{secret:github_token}}', secrets, 'https://api.github.com'),
    { ok: true, value: 'token=ghp_abcdef123456', used: ['github_token'] });
  assert.equal(substituteSecrets('{{secret:github_token}}', secrets, 'https://github.com.evil.net').ok, false);
  assert.equal(substituteSecrets('{{secret:missing}}', secrets, 'https://github.com').ok, false);
  assert.equal(substituteSecrets('{{secret:__proto__}}', secrets, 'https://github.com').ok, false);
  assert.equal(substituteSecrets('plain text', secrets, 'https://github.com').value, 'plain text');
  assert.equal(maskSecrets('saw ghp_abcdef123456 in page', secrets), 'saw {{secret:github_token}} in page');
});
