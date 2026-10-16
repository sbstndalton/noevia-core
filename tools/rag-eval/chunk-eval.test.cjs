'use strict';
// noevia#1866 chunker eval harness: offline checks (synthetic data only, no network beyond a local fake server).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const E = require('./chunk-eval.cjs');

const ds = E.generate({ docs: 3, queries: 12, pages: 8, seed: 7 });
const strip = (c) => c.replace(/^\[Page \d+\]\n/, '').replace(/^Section: .*\n/, '');

test('arm A is byte-identical to server/rag.cjs chunkText', () => {
  const { chunkText } = require('../../server/rag.cjs');
  for (const d of ds.docs) assert.deepEqual(E.chunkTextCurrent(d.text), chunkText(d.text));
  const edge = '[Page 1]\nNo punctuation at all ' + 'x'.repeat(3000) + '\n\n[Page 2]\nShort.';
  assert.deepEqual(E.chunkTextCurrent(edge), chunkText(edge));
});

test('generator is deterministic, synthetic and in the assemble() page format', () => {
  const h = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.equal(h(E.generate({ docs: 3, queries: 12, pages: 8, seed: 7 })), h(ds));
  assert.notEqual(h(E.generate({ docs: 3, queries: 12, pages: 8, seed: 8 })), h(ds));
  assert.equal(ds.synthetic, true);
  for (const d of ds.docs) assert.match(d.text, /^\[Page 1\]\n/);
  assert.equal(ds.queries.length, 12);
  for (const q of ds.queries) assert.ok(ds.docs.find((d) => d.id === q.doc).text.replace(/\s+/g, ' ').length > 0 && q.gold.endsWith('.'));
  // more queries than facts reuse facts in other languages
  const big = E.generate({ docs: 2, queries: 40, pages: 4, seed: 3 });
  assert.equal(big.queries.length, 40);
});

test('page-straddling gold: per-page arms (A, B) cannot hold it, cross-page arms (C-F) can', () => {
  const big = E.generate({ docs: 6, queries: 60, pages: 10, seed: 1866 });
  const strad = big.queries.filter((q) => q.straddlesPage);
  assert.ok(strad.length > 0, 'set has straddling facts');
  for (const arm of E.ARMS) {
    const chunks = E.chunkCorpus(big, arm, 'D');
    const reach = strad.filter((q) => chunks.some((c) => c.doc === q.doc && E.hasGold(c.body, q.gold))).length;
    if (arm === 'A' || arm === 'B') assert.equal(reach, 0, arm); else assert.equal(reach, strad.length, arm);
    const flat = big.queries.filter((q) => !q.straddlesPage);
    assert.equal(flat.filter((q) => chunks.some((c) => c.doc === q.doc && E.hasGold(c.body, q.gold))).length, flat.length, `${arm} reaches every non-straddling gold`);
  }
});

test('B cuts only on sentence/line boundaries and keeps size; C-E respect their token sizes', () => {
  for (const d of ds.docs) {
    const bs = E.chunkSentenceSnapped(d.text);
    for (const [k, c] of bs.entries()) {
      const b = strip(c); assert.ok(b.length <= 1200, 'B size');
      const lastOnPage = k === bs.length - 1 || bs[k + 1].match(/^\[Page (\d+)\]/)[1] !== c.match(/^\[Page (\d+)\]/)[1];
      if (lastOnPage) continue; // a page may end mid-sentence (the generator cuts some gold sentences on purpose)
      const last = b.trimEnd().split('\n').pop();
      assert.ok(/[.!?|]$/.test(last) || /^[A-Z][^.!?]{0,59}$/.test(last), 'B ends on a boundary: ' + JSON.stringify(last.slice(-40)));
    }
    for (const [arm, tok] of [['C', 256], ['D', 512], ['E', 768]]) for (const c of E.chunkArm(arm, d.text)) assert.ok(strip(c).length <= tok * 4, arm);
  }
  // A, by contrast, splits "3.5" style decimals: a cut right after a digit-dot occurs somewhere in a long unbroken text
  const t = '[Page 1]\n' + Array.from({ length: 60 }, (_, i) => `The road is ${i}.5 km long and was paved by Dr. Lind in spring`).join(' and ') + '.';
  assert.ok(E.chunkTextCurrent(t).some((c) => /\d\.$/.test(c) || /^\[Page 1\]\n5 km/.test(c) || /\bDr\.$/.test(c)));
});

test('C-F carry the starting page marker; F adds the section heading', () => {
  const d = ds.docs[0];
  for (const c of E.chunkArm('D', d.text)) assert.match(c, /^\[Page \d+\]\n/);
  const f = E.chunkArm('F', d.text, 'D');
  assert.ok(f.some((c) => /^\[Page \d+\]\nSection: [A-Z]/.test(c)));
  assert.throws(() => E.chunkArm('F', d.text, 'B'), /fbase/);
});

test('metrics: gold@k, nDCG@6, MRR', () => {
  const m = E.metrics([{ pos: 0 }, { pos: 2 }, { pos: 5 }, { pos: -1 }]);
  assert.equal(m.gold1, 25); assert.equal(m.gold3, 50); assert.equal(m.gold6, 75);
  assert.equal(m.mrr, +((1 + 1 / 3 + 1 / 6) / 4).toFixed(3));
  assert.equal(m.ndcg6, +((1 + 1 / Math.log2(4) + 1 / Math.log2(7)) / 4).toFixed(3));
});

// ------------------------------------------------------------------ phases against a local fake service
function fakeServer({ model = 'embeddinggemma-2', refuseLong = 0, slowRerankMs = 0 } = {}) {
  const calls = { models: 0, embeddings: 0, rerank: 0, inputs: 0 };
  const vec = (t) => { const h = crypto.createHash('sha256').update(t.replace(/^task: search result \| query: |^title: none \| text: /, '').toLowerCase()).digest(); return Array.from({ length: 8 }, (_, i) => (h[i] / 255) + 0.5); };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/v1/models') { calls.models++; return send(200, { data: [{ id: model }] }); }
      if (req.url === '/v1/embeddings') {
        calls.embeddings++; const j = JSON.parse(b); calls.inputs += j.input.length;
        if (refuseLong && j.input.some((t) => t.length > refuseLong)) return send(400, { error: 'input too large' });
        return send(200, { data: j.input.map((t, index) => ({ index, embedding: vec(t) })) });
      }
      if (req.url === '/info') return send(200, { model_id: '/model', max_input_length: 8192, version: 'fake' });
      if (req.url === '/rerank') {
        calls.rerank++; const j = JSON.parse(b); if (slowRerankMs) await new Promise((r) => setTimeout(r, slowRerankMs));
        assert.ok(j.texts.every((t) => t.length <= 4000));
        return send(200, j.texts.map((t, index) => ({ index, score: t.length % 97 })));
      }
      send(404, {});
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-eval-'));

test('embed -> rerank -> score end to end; throttled, counted, scored per arm', async () => {
  const f = await fakeServer(); const out = tmp();
  try {
    const small = E.generate({ docs: 2, queries: 4, pages: 3, seed: 5 });
    await E.embedPhase(small, out, f.url + '/v1', { arms: 'A,D', gapMs: '0', dim: '8' });
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'embed.meta.json'), 'utf8'));
    assert.equal(meta.requests, f.calls.models + f.calls.embeddings);
    assert.ok(meta.perArm.A.chunks > 0 && meta.perArm.D.chunks > 0);
    for (const arm of ['A', 'D']) {
      const pools = JSON.parse(fs.readFileSync(path.join(out, `pools-${arm}.json`), 'utf8'));
      for (const q of small.queries) { assert.ok(pools[q.id].length <= 12); for (let i = 1; i < pools[q.id].length; i++) assert.ok(pools[q.id][i - 1][1] >= pools[q.id][i][1]); }
    }
    await E.rerankPhase(small, out, f.url, { arms: 'A,D' });
    const res = E.score(small, out);
    for (const arm of ['A', 'D']) { assert.equal(res.arms[arm].cosine.all.n, 4); assert.equal(res.arms[arm].rerank.all.n, 4); assert.equal(res.arms[arm].rerank.latency.errors, 0); }
    assert.ok(fs.readFileSync(path.join(out, 'scores.txt'), 'utf8').includes('D rerank'));
  } finally { f.srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('embed refuses to run against the wrong model, and records per-text refusals instead of failing', async () => {
  const wrong = await fakeServer({ model: 'nomic-embed-text-v1' }); const out = tmp();
  try { await assert.rejects(E.embedPhase(ds, out, wrong.url + '/v1', { arms: 'A', gapMs: '0' }), /not served/); assert.equal(wrong.calls.embeddings, 0); }
  finally { wrong.srv.close(); }
  const f = await fakeServer({ refuseLong: 3000 });
  try {
    await E.embedPhase(ds, out, f.url + '/v1', { arms: 'E', gapMs: '0' });
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'embed.meta.json'), 'utf8'));
    assert.ok(meta.refused.length > 0 && meta.perArm.E.refusedChunks === meta.refused.length);
  } finally { f.srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('embed waits while PAUSE exists and stops on ABORT', async () => {
  const f = await fakeServer(); const out = tmp();
  try {
    fs.writeFileSync(path.join(out, 'PAUSE'), '');
    setTimeout(() => fs.rmSync(path.join(out, 'PAUSE')), 2500);
    const t0 = Date.now(); await E.embedPhase(E.generate({ docs: 1, queries: 1, pages: 2, seed: 2 }), out, f.url + '/v1', { arms: 'A', gapMs: '0' });
    assert.ok(Date.now() - t0 >= 2000);
    assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'embed.meta.json'), 'utf8')).pausedMs >= 2000);
    fs.writeFileSync(path.join(out, 'ABORT'), '');
    await assert.rejects(E.embedPhase(ds, out, f.url + '/v1', { arms: 'A', gapMs: '0' }), /ABORT/);
  } finally { f.srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});

test('rerank past the 3 s deadline is scored as the cosine fallback production would return', async () => {
  const f = await fakeServer({ slowRerankMs: 3100 }); const out = tmp();
  try {
    const one = E.generate({ docs: 1, queries: 1, pages: 3, seed: 9 });
    await E.embedPhase(one, out, f.url + '/v1', { arms: 'C', gapMs: '0' });
    await E.rerankPhase(one, out, f.url, { arms: 'C' });
    const res = E.score(one, out);
    assert.equal(res.arms.C.rerank.latency.over3s, 1);
    assert.deepEqual(res.arms.C.rerankWithDeadline.all, res.arms.C.cosine.all);
  } finally { f.srv.close(); fs.rmSync(out, { recursive: true, force: true }); }
});
