'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {
  sanitizeText, repoFromCheckpoint, cardUrl, hostAllowed, normalizeCard,
  artifactIdentityHash, fetchModelCardEvidence, resolveCheckpoint, importModelEvidence, deriveExternal,
} = require('./model-evidence-import.cjs');
const { createStore } = require('./evidence.cjs');

const now = 2_000_000_000_000;
const cardBody = (over = {}) => ({
  id: 'acme/model-7b',
  sha: 'a'.repeat(40),
  license: 'apache-2.0',
  pipeline_tag: 'text-generation',
  library_name: 'gguf',
  tags: ['gguf', 'chat', 'x'.repeat(90)],
  cardData: {
    license: 'apache-2.0',
    model_summary: 'A general-purpose chat model.',
    'model-index': [{ results: [{ task: { type: 'text-generation' }, dataset: { name: 'MMLU' }, metrics: [{ type: 'accuracy', value: 71.2 }] }] }],
  },
  ...over,
});

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-evidence-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createStore(dir);
}

test('sanitizeText strips markup/control characters and caps length', () => {
  assert.equal(sanitizeText('<b>hi</b>\u0007 there'), 'hi there');
  assert.equal(sanitizeText(null), null);
  assert.equal(sanitizeText('x'.repeat(3000)).length, 2001); // 2000 chars + ellipsis
});

test('repoFromCheckpoint validates, strips a quant tag, and rejects dot-only path-escape segments', () => {
  assert.equal(repoFromCheckpoint('acme/model-7b'), 'acme/model-7b');
  assert.equal(repoFromCheckpoint('acme/model-7b:Q4_K_M'), 'acme/model-7b');
  assert.equal(repoFromCheckpoint('../etc/passwd'), null);
  assert.equal(repoFromCheckpoint('not-a-repo'), null);
  assert.equal(repoFromCheckpoint(''), null);
  // Path-escape segments: "acme/.." would resolve to /api/models (a listing), "../datasets"
  // to /api/datasets. Both segments are dot-only and must be rejected outright.
  assert.equal(repoFromCheckpoint('acme/..'), null);
  assert.equal(repoFromCheckpoint('../datasets'), null);
  assert.equal(repoFromCheckpoint('./x'), null);
  assert.equal(repoFromCheckpoint('acme/.'), null);
});

test('cardUrl targets the fixed allow-listed host and hostAllowed rejects other hosts or paths', () => {
  const url = cardUrl('acme/model-7b');
  assert.equal(url, 'https://huggingface.co/api/models/acme/model-7b');
  assert.ok(hostAllowed(url));
  assert.ok(!hostAllowed('https://evil.example.com/api/models/acme/model-7b'));
  assert.ok(!hostAllowed('http://huggingface.co/api/models/acme/model-7b')); // not https
  assert.ok(!hostAllowed('https://huggingface.co/api/datasets/acme/model-7b')); // wrong path
  assert.ok(!hostAllowed('not a url'));
});

test('normalizeCard extracts and caps license/eval claims, drops unrecognized shape including arrays', () => {
  const v = normalizeCard('acme/model-7b', cardBody());
  assert.equal(v.repo, 'acme/model-7b');
  assert.equal(v.revision, 'a'.repeat(40));
  assert.equal(v.license, 'apache-2.0');
  assert.equal(v.pipelineTag, 'text-generation');
  assert.equal(v.tags.length, 3);
  assert.equal(v.tags[2].length, 61); // 60 + ellipsis
  assert.deepEqual(v.evaluationClaims[0], { task: 'text-generation', dataset: 'MMLU', metric: 'accuracy', value: '71.2' });
  assert.equal(normalizeCard('acme/model-7b', null), null);
  assert.equal(normalizeCard('acme/model-7b', 'oops'), null);
  // The models listing endpoint (what "acme/.." would have resolved to) returns a JSON
  // array, not a card object; it must never be normalized as if it were one.
  assert.equal(normalizeCard('acme/model-7b', [{ id: 'unrelated/model' }]), null);
});

test('artifactIdentityHash is stable for the same artifact and differs for another', () => {
  assert.equal(artifactIdentityHash('123:456:abc'), artifactIdentityHash('123:456:abc'));
  assert.notEqual(artifactIdentityHash('123:456:abc'), artifactIdentityHash('123:456:def'));
});

test('fetchModelCardEvidence rejects a bad checkpoint or missing artifact without fetching', async () => {
  let called = false;
  const fetchJson = async () => { called = true; return { ok: true, body: cardBody() }; };
  assert.equal((await fetchModelCardEvidence({ checkpoint: 'bad', artifact: 'x', fetchJson, now: () => now })).ok, false);
  assert.equal((await fetchModelCardEvidence({ checkpoint: 'acme/model-7b', artifact: null, fetchJson, now: () => now })).ok, false);
  assert.equal((await fetchModelCardEvidence({ checkpoint: 'acme/..', artifact: 'x', fetchJson, now: () => now })).ok, false);
  assert.equal(called, false);
});

test('fetchModelCardEvidence never follows redirects and only queries the allow-listed host', async () => {
  let seenUrl = null, seenOpts = null;
  const fetchJson = async (url, opts) => { seenUrl = url; seenOpts = opts; return { ok: true, body: cardBody() }; };
  const result = await fetchModelCardEvidence({ checkpoint: 'acme/model-7b:Q4_K_M', artifact: 'artifact-hash', fetchJson, now: () => now });
  assert.equal(result.ok, true);
  assert.equal(seenUrl, 'https://huggingface.co/api/models/acme/model-7b');
  assert.equal(seenOpts.redirect, 'error');
  assert.equal(result.record.category, 'external_model_card');
  assert.equal(result.record.result, 'reported');
  assert.equal(result.record.identityHash, artifactIdentityHash('artifact-hash'));
  assert.equal(result.record.provenance.sourceUrl, 'https://huggingface.co/api/models/acme/model-7b');
  assert.equal(result.record.provenance.retrievedAt, now);
  assert.match(result.record.limitations[0], /unverified, from source/);
});

test('fetchModelCardEvidence handles offline/failed/oversized lookups without throwing', async () => {
  const throwing = async () => { throw Object.assign(new Error('response too large'), { status: 502 }); };
  assert.equal((await fetchModelCardEvidence({ checkpoint: 'acme/model-7b', artifact: 'a', fetchJson: throwing, now: () => now })).ok, false);
  const notFound = async () => ({ ok: false, status: 404, body: { error: 'not found' } });
  assert.equal((await fetchModelCardEvidence({ checkpoint: 'acme/model-7b', artifact: 'a', fetchJson: notFound, now: () => now })).ok, false);
  const priv = async () => ({ ok: true, body: { private: true } });
  assert.equal((await fetchModelCardEvidence({ checkpoint: 'acme/model-7b', artifact: 'a', fetchJson: priv, now: () => now })).ok, false);
  const listing = async () => ({ ok: true, body: [{ id: 'acme/model-7b' }] });
  assert.equal((await fetchModelCardEvidence({ checkpoint: 'acme/model-7b', artifact: 'a', fetchJson: listing, now: () => now })).ok, false);
});

test('resolveCheckpoint requires an override to name the same repository as the model', () => {
  assert.equal(resolveCheckpoint('acme/model-7b', undefined), 'acme/model-7b');
  assert.equal(resolveCheckpoint('acme/model-7b', null), 'acme/model-7b');
  assert.equal(resolveCheckpoint('acme/model-7b', 'acme/model-7b:Q4_K_M'), 'acme/model-7b:Q4_K_M');
  // A locally renamed model has no repo of its own; any override is refused, not guessed at.
  assert.equal(resolveCheckpoint('laya', 'acme/model-7b'), null);
  // An override naming an unrelated repository must never be accepted.
  assert.equal(resolveCheckpoint('acme/model-7b', 'someone-else/other-model'), null);
});

test('importModelEvidence refuses an admin-supplied checkpoint that names a different repository', async () => {
  const store = tempStore(test);
  let fetched = false;
  const fetchJson = async () => { fetched = true; return { ok: true, body: cardBody() }; };
  const result = await importModelEvidence({ model: 'acme/model-7b', checkpoint: 'someone-else/other-model', artifact: 'artifact-1', fetchJson, store, now: () => now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match/);
  assert.equal(fetched, false, 'a mismatched override must never be fetched, let alone attributed to this model');
  assert.equal(store.list().length, 0);
});

test('importModelEvidence dedupes repeated imports of the same artifact and card, using the real evidence store', async (t) => {
  const store = tempStore(t);
  const fetchJson = async () => ({ ok: true, body: cardBody() });
  const first = await importModelEvidence({ model: 'acme/model-7b', artifact: 'artifact-1', fetchJson, store, now: () => now });
  const second = await importModelEvidence({ model: 'acme/model-7b', artifact: 'artifact-1', fetchJson, store, now: () => now + 1000 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(store.list().length, 1, 'unchanged card for the same artifact appends nothing');
  assert.equal(first.record.id, second.record.id);
});

test('importModelEvidence records a new entry when the card changes or the artifact changes, but not on revision alone', async (t) => {
  const store = tempStore(t);
  let sha = 'a'.repeat(40);
  const fetchJson = async () => ({ ok: true, body: cardBody({ sha }) });
  await importModelEvidence({ model: 'acme/model-7b', artifact: 'artifact-1', fetchJson, store, now: () => now });
  // Same card content, a different commit sha (e.g. a moving `main` ref, or a re-push with
  // no real change): must not append a second record.
  sha = 'b'.repeat(40);
  await importModelEvidence({ model: 'acme/model-7b', artifact: 'artifact-1', fetchJson, store, now: () => now + 1 });
  assert.equal(store.list().length, 1, 'a changed revision alone must not append a new record');
  assert.equal(store.list()[0].value.revision, 'a'.repeat(40), 'the first-seen revision is kept, not silently replaced');
  await importModelEvidence({ model: 'acme/model-7b', artifact: 'artifact-2', fetchJson, store, now: () => now + 2 });
  assert.equal(store.list().length, 2, 'a new artifact still appends');
});

test('importModelEvidence surfaces the evidence store credential guard rather than swallowing it silently', async (t) => {
  const store = tempStore(t);
  const fetchJson = async () => ({ ok: true, body: cardBody({ cardData: { license: 'apache-2.0', model_summary: 'sk-abcdefghijklmnopqrstuvwx leaked in a card' } }) });
  await assert.rejects(
    importModelEvidence({ model: 'acme/model-7b', artifact: 'artifact-1', fetchJson, store, now: () => now }),
    /credential/i,
  );
});

test('deriveExternal reports the artifact-matching record, falls back to stale, then unverified', () => {
  const records = [
    { model: 'laya', category: 'external_model_card', identityHash: artifactIdentityHash('old'), value: { license: 'mit' } },
    { model: 'laya', category: 'external_model_card', identityHash: artifactIdentityHash('new'), value: { license: 'apache-2.0' } },
  ];
  assert.equal(deriveExternal(records, { model: 'laya', artifactHash: artifactIdentityHash('new') }).state, 'reported');
  assert.equal(deriveExternal(records, { model: 'laya', artifactHash: artifactIdentityHash('unseen') }).state, 'stale');
  assert.equal(deriveExternal(records, { model: 'laya', artifactHash: null }).state, 'unavailable');
  assert.equal(deriveExternal([], { model: 'laya', artifactHash: artifactIdentityHash('new') }).state, 'unverified');
  assert.equal(deriveExternal(records, { model: 'other', artifactHash: artifactIdentityHash('new') }).state, 'unverified');
});
