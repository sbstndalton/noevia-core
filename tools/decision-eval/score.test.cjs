'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('./score.cjs');

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const rec = (over) => ({ id: 'x', purpose: 'model.route', variant: 'base', lang: 'en', label: 'fast', model: 'm', ok: true, reason: null,
  selected: 'fast', scores: { fast: 0.8, smart: 0.2 }, latencyMs: 100, ...over });

test('percentile is nearest-rank and ignores non-finite values', () => {
  assert.equal(s.percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(s.percentile([1, 2, 3, 4], 50), 2);
  assert.equal(s.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 95), 19);
  assert.equal(s.percentile([7], 95), 7);
  assert.equal(s.percentile([NaN, null, 4], 50), 4);
  assert.equal(s.percentile([], 50), null);
});

test('ECE: perfectly calibrated bins score 0; an overconfident bin scores its gap', () => {
  const calibrated = [...Array(9)].map(() => ({ confidence: 0.9, correct: true })).concat([{ confidence: 0.9, correct: false }]);
  close(s.ece(calibrated), 0);
  // All at 0.8 and half right: one bin, |0.5 - 0.8| = 0.3.
  close(s.ece([0.8, 0.8, 0.8, 0.8].map((c, i) => ({ confidence: c, correct: i < 2 }))), 0.3);
  // Two bins weighted by size: 2 at 0.95 both right (gap 0.05), 2 at 0.55 none right (gap 0.55) -> 0.3.
  close(s.ece([{ confidence: 0.95, correct: true }, { confidence: 0.95, correct: true }, { confidence: 0.55, correct: false }, { confidence: 0.55, correct: false }]), 0.3);
  // A confidence of exactly 1 lands in the last bin, not past it.
  close(s.ece([{ confidence: 1, correct: true }]), 0);
  assert.equal(s.ece([]), null);
});

test('Brier on the selected probability', () => {
  close(s.brier([{ confidence: 0.8, correct: true }, { confidence: 0.6, correct: false }]), (0.04 + 0.36) / 2);
  assert.equal(s.brier([]), null);
});

test('macro-F1 averages per-class F1 over the labels present; a failed record predicts nothing', () => {
  const rows = [
    rec({ label: 'fast', selected: 'fast' }), rec({ label: 'fast', selected: 'smart' }),
    rec({ label: 'smart', selected: 'smart' }), rec({ label: 'smart', ok: false, selected: null, scores: null }),
  ];
  // fast: tp1 fp0 fn1 -> P1 R.5 F.6667; smart: tp1 fp1 fn1 -> P.5 R.5 F.5.
  close(s.macroF1(rows), (2 / 3 + 0.5) / 2);
  assert.equal(s.macroF1([]), null);
});

test('normalise renormalises rounded probabilities and refuses unusable ones', () => {
  const n = s.normalise({ a: 0.3334, b: 0.3334, c: 0.3335 });
  close(Object.values(n).reduce((x, y) => x + y, 0), 1);
  assert.equal(s.normalise({ a: -0.1, b: 1.1 }), null);
  assert.equal(s.normalise({ a: 0, b: 0 }), null);
  assert.equal(s.normalise(null), null);
  assert.equal(s.normalise({ a: 'x' }), null);
});

test('judge: a failure or an answer outside its own scores is unanswered and wrong', () => {
  assert.deepEqual(s.judge(rec({})), { answered: true, correct: true, confidence: 0.8 });
  assert.deepEqual(s.judge(rec({ ok: false })), { answered: false, correct: false, confidence: null });
  assert.deepEqual(s.judge(rec({ selected: 'code' })), { answered: false, correct: false, confidence: null });
  // Confidence is read from renormalised scores, not trusted raw.
  close(s.judge(rec({ scores: { fast: 0.4, smart: 0.1 } })).confidence, 0.8);
});

test('flip rate compares rotated requests with the base answer; a failed rotation counts as a flip', () => {
  const rows = [
    rec({ id: 'a' }), rec({ id: 'a', variant: 'perm1' }), rec({ id: 'a', variant: 'perm2', selected: 'smart', scores: { fast: 0.3, smart: 0.7 } }),
    rec({ id: 'b' }), rec({ id: 'b', variant: 'perm1', ok: false }),
    rec({ id: 'c', ok: false }), rec({ id: 'c', variant: 'perm1' }), // no base answer: not compared
  ];
  assert.deepEqual(s.flipRate(rows), { compared: 3, flipped: 2, rate: 2 / 3 });
});

test('summarize: per purpose, per language, failures count as wrong, rotations stay out of accuracy', () => {
  const rows = [
    rec({ id: 'r1', lang: 'en', label: 'fast', selected: 'fast', latencyMs: 100 }),
    rec({ id: 'r2', lang: 'de', label: 'smart', selected: 'fast', latencyMs: 300 }),
    rec({ id: 'r3', lang: 'de', label: 'smart', ok: false, reason: 'http-503', selected: null, scores: null, latencyMs: 1900 }),
    rec({ id: 'r1', variant: 'nocode', lang: 'en', label: 'fast', selected: 'fast', latencyMs: 200 }),
    rec({ id: 'r1', variant: 'perm1', lang: 'en', label: 'fast', selected: 'smart', scores: { fast: 0.1, smart: 0.9 }, latencyMs: 5000 }),
    rec({ id: 's1', purpose: 'routing.sensitivity', label: 'sensitive', selected: 'sensitive', scores: { sensitive: 0.9, not_sensitive: 0.1 }, latencyMs: 1400 }),
    rec({ id: 's2', purpose: 'routing.sensitivity', label: 'not_sensitive', selected: 'sensitive', scores: { sensitive: 0.7, not_sensitive: 0.3 } }),
    rec({ id: 'v1', purpose: 'step.supervise', label: 'escalate', selected: 'escalate', scores: { continue: 0.1, verify: 0.1, escalate: 0.8 } }),
    rec({ id: 'v2', purpose: 'step.supervise', label: 'continue', selected: 'escalate', scores: { continue: 0.3, verify: 0.1, escalate: 0.6 } }),
    rec({ id: 'v3', purpose: 'step.supervise', label: 'continue', selected: 'continue', scores: { continue: 0.9, verify: 0.05, escalate: 0.05 } }),
  ];
  const out = s.summarize(rows);
  assert.equal(out.model, 'm');
  assert.equal(out.overall.n, 9, 'the rotated request is not part of accuracy');
  assert.equal(out.overall.failed, 1);
  assert.deepEqual(out.overall.failureReasons, { 'http-503': 1 });
  assert.equal(out.perPurpose['model.route'].n, 3);
  close(out.perPurpose['model.route'].accuracy, 1 / 3);
  assert.equal(out.perPurpose['model.route.nocode'].n, 1, 'route without the Code role is its own row');
  close(out.perLanguage.de.accuracy, 0);
  assert.equal(out.perPurposeLanguage['model.route'].de.n, 2);
  assert.equal(out.sensitivity.sensitiveRecall, 1);
  assert.equal(out.sensitivity.benignFlagged, 1);
  assert.equal(out.supervision.escalationsCaught, 1);
  assert.equal(out.supervision.benignPausedPer30, 15);
  // Latency from answered main requests only (the 5 s rotation is excluded); the 503 counts as a miss.
  assert.equal(out.latencyMs.max, 1400);
  assert.equal(out.latencyMs.over1300, 2);
  assert.equal(out.latencyMs.over1800, 1);
  assert.deepEqual(out.orderFlips, { compared: 1, flipped: 1, rate: 1 });
  // Risk-coverage at 0.6: answers at or above it, and how often those are right.
  const route = out.perPurpose['model.route'];
  close(route.coverageAt06, 2 / 3);
  close(route.accuracyAt06, 0.5);
});

test('markdown has one row per model in each table and names the weakest languages', () => {
  const a = s.summarize([rec({ id: '1' }), rec({ id: '2', lang: 'de', selected: 'smart', scores: { fast: 0.2, smart: 0.8 } }), rec({ id: '3', lang: 'fr' })]);
  const b = s.summarize([rec({ id: '1', model: 'other' })]);
  const md = s.markdown([a, b], { m: { peakBytes: 512 * 2 ** 20 } });
  assert.match(md, /\| m \| 66\.7% \| 66\.7% \|/);
  assert.match(md, /512 MiB/);
  assert.match(md, /\| other \|/);
  assert.deepEqual(s.weakLanguages(a), ['de 0.0%', 'fr 100.0%']);
  assert.equal(md.split('\n').filter((l) => l.startsWith('| m |')).length, 3);
});

test('one temperature refit on a held-out split cools an overconfident model and leaves the argmax alone', () => {
  // Says 0.95 every time but is right 60% of the time: the fitted T is above 1 and ECE falls.
  const rows = [...Array(400)].map((_, i) => {
    const right = i % 5 < 3;
    return rec({ id: `r${i}`, label: 'fast', selected: right ? 'fast' : 'smart', scores: right ? { fast: 0.95, smart: 0.05 } : { fast: 0.05, smart: 0.95 } });
  });
  const r = s.temperatureRefit(rows);
  assert.ok(r.calibrationN > 150 && r.evaluationN > 150, JSON.stringify(r));
  assert.ok(r.temperature > 1, `T ${r.temperature}`);
  assert.ok(r.eceBefore > 0.3 && r.eceAfter < 0.1, JSON.stringify(r));
  assert.ok(s.summarize(rows).calibrationRefit.eceAfter < 0.1);
  assert.equal(s.temperatureRefit([rec({ ok: false })]), null);
});
