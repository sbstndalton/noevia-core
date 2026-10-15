'use strict';
// #1791: attaching a harmless PNG to a free chat showed "This looks sensitive (a password or key)". The file is
// stored under the chat's hidden project folder, "cowork-chat-context-<chat id>/", and that path segment is
// key-shaped, so the hybrid pre-rule flagged every attachment as a secret. Image bytes as a base64 data URI
// are not a secret either. Synthetic names and bytes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { preRule } = require('./routing-modes.cjs');

const chatFile = 'noevia projects/cowork-chat-context-c-1792034361215-pyyzo4/Images/qa-red-square.png';

test('#1791: a free chat attachment path is not a password or key', () => {
  assert.equal(preRule(chatFile), null);
  assert.equal(preRule([chatFile, 'noevia projects/cowork-chat-context-c-1792033770417-g4v2ym/Text/notes.txt'].join('\n')), null);
  // The files manifest that rides with the user's turn names the same path.
  assert.equal(preRule(`The user attached these files to this chat (1): "${chatFile}". Excerpts of the relevant ones follow.`), null);
});

test('#1791: image bytes as a base64 data URI are not a secret', () => {
  for (let i = 0; i < 20; i++) {
    const uri = `data:image/png;base64,${crypto.randomBytes(787).toString('base64')}`;
    assert.equal(preRule(uri), null);
  }
  assert.equal(preRule(`data:image/webp;base64,${Buffer.from('synthetic-bytes_with-dashes-and_underscores-0123456789').toString('base64url')}`), null);
});

test('#1791: real secrets beside an attachment path or a data URI are still flagged', () => {
  assert.equal(preRule(`${chatFile}\napi_key = "sk-synthetic-0123456789abcdef"`), 'secret');
  assert.equal(preRule(`data:image/png;base64,AAAA ghp-synthetic0123456789abcdefABCDEF`), 'secret');
  assert.equal(preRule('my token is zq-synth-abcd1234efgh5678ijkl9012mnop'), 'secret');
  // Only the path segment form is blanked: the same words in prose are scanned as before.
  assert.equal(preRule('cowork-chat-context-synth_abcd1234efgh5678ijkl9012'), 'secret');
});
