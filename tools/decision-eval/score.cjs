'use strict';
// #1639: scores RAW decision outputs against the synthetic labels. It reads the per-option scores
// each model returned and computes everything itself (accuracy, macro-F1, ECE, Brier, latency
// percentiles, per-language breakdowns), so it does not depend on the `confidence` field core
// returns (#1640 makes that always null today).
//
// A result record (one line of run.cjs output):
//   { id, purpose, variant, lang, label, model, ok, reason, status, selected, scores, latencyMs }
// variant: 'base' (the request production sends), 'nocode' (model.route without the Code role),
// 'perm1'/'perm2' (the same request with the options rotated, for the order-flip rate).
// A record that is not ok (HTTP error, deadline, invalid answer) counts as wrong everywhere.
//
// Usage: node score.cjs --out report.json [--md report.md] [--rss rss.json] results-a.jsonl results-b.jsonl ...

const fs = require('node:fs');

const BINS = 10;
const DEADLINES_MS = [1300, 1800];
const ACCEPT_AT = 0.6; // the bound tool-gate and the load advisor use on scores[selected]
const PERM_VARIANTS = new Set(['perm1', 'perm2']);

const purposeKey = (r) => (r.variant === 'nocode' ? `${r.purpose}.nocode` : r.purpose);
const round = (x, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/** Scores renormalised to sum to 1, or null when they cannot be (missing, negative, no mass). */
function normalise(scores) {
  if (!scores || typeof scores !== 'object') return null;
  const entries = Object.entries(scores);
  if (!entries.length || !entries.every(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) return null;
  const total = entries.reduce((n, [, v]) => n + v, 0);
  return total > 0 ? Object.fromEntries(entries.map(([k, v]) => [k, v / total])) : null;
}

/** { answered, correct, confidence } for one record; confidence is the renormalised scores[selected]. */
function judge(r) {
  const probs = r.ok ? normalise(r.scores) : null;
  if (!probs || typeof r.selected !== 'string' || !(r.selected in probs)) return { answered: false, correct: false, confidence: null };
  return { answered: true, correct: r.selected === r.label, confidence: probs[r.selected] };
}

/** Nearest-rank percentile of finite values (p in 0..100); null for none. */
function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * v.length));
  return v[Math.min(v.length, rank) - 1];
}

/** Expected calibration error over [{confidence, correct}], equal-width bins on [0,1]. */
function ece(pairs, bins = BINS) {
  const usable = pairs.filter((p) => Number.isFinite(p.confidence));
  if (!usable.length) return null;
  const sums = Array.from({ length: bins }, () => ({ n: 0, conf: 0, hit: 0 }));
  for (const { confidence, correct } of usable) {
    const c = Math.min(1, Math.max(0, confidence));
    const b = sums[Math.min(bins - 1, Math.floor(c * bins))];
    b.n += 1; b.conf += c; b.hit += correct ? 1 : 0;
  }
  return sums.reduce((e, b) => (b.n ? e + (b.n / usable.length) * Math.abs(b.hit / b.n - b.conf / b.n) : e), 0);
}

/** Brier score of the selected option's probability against being right. */
function brier(pairs) {
  const usable = pairs.filter((p) => Number.isFinite(p.confidence));
  if (!usable.length) return null;
  return usable.reduce((s, p) => s + (p.confidence - (p.correct ? 1 : 0)) ** 2, 0) / usable.length;
}

/** Macro-F1 over the label classes present (by support). A record with no answer predicts nothing. */
function macroF1(records) {
  const classes = [...new Set(records.map((r) => r.label))];
  if (!classes.length) return null;
  const f1s = classes.map((c) => {
    let tp = 0, fp = 0, fn = 0;
    for (const r of records) {
      const predicted = r.ok ? r.selected : null;
      if (r.label === c && predicted === c) tp += 1;
      else if (r.label === c) fn += 1;
      else if (predicted === c) fp += 1;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  });
  return f1s.reduce((a, b) => a + b, 0) / f1s.length;
}

/** P(selected === pick | label === given), counting a failed record as not picked. */
function rate(records, given, pick) {
  const rows = records.filter((r) => r.label === given);
  return rows.length ? rows.filter((r) => r.ok && r.selected === pick).length / rows.length : null;
}

/** Accuracy and calibration block for a set of records. */
function block(records) {
  const judged = records.map(judge);
  const answered = judged.filter((j) => j.answered);
  const accepted = answered.filter((j) => j.confidence >= ACCEPT_AT);
  return {
    n: records.length,
    answered: answered.length,
    accuracy: records.length ? judged.filter((j) => j.correct).length / records.length : null,
    macroF1: macroF1(records),
    ece: ece(answered),
    brier: brier(answered),
    // Risk-coverage at the shipped 0.6 bound: how many answers clear it, and how often those are right.
    coverageAt06: records.length ? accepted.length / records.length : null,
    accuracyAt06: accepted.length ? accepted.filter((j) => j.correct).length / accepted.length : null,
  };
}

/** Order-flip rate: a rotated request (perm1/perm2) whose answer differs from the base request's. */
function flipRate(records) {
  const base = new Map(records.filter((r) => r.variant === 'base' && r.ok).map((r) => [r.id, r.selected]));
  let compared = 0, flipped = 0;
  for (const r of records) {
    if (!PERM_VARIANTS.has(r.variant) || !base.has(r.id)) continue;
    compared += 1;
    if (!r.ok || r.selected !== base.get(r.id)) flipped += 1;
  }
  return { compared, flipped, rate: compared ? flipped / compared : null };
}

function groupBy(records, key) {
  const out = new Map();
  for (const r of records) { const k = key(r); if (!out.has(k)) out.set(k, []); out.get(k).push(r); }
  return out;
}

function roundBlock(b) { return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? round(v) : v])); }

/** Every metric for one model's records. */
function summarize(records) {
  const main = records.filter((r) => !PERM_VARIANTS.has(r.variant));
  const latencies = main.filter((r) => r.ok).map((r) => r.latencyMs);
  const timedOut = main.filter((r) => !r.ok && /deadline|timeout|http-503/.test(String(r.reason || ''))).length;
  const reasons = {};
  for (const r of main.filter((x) => !x.ok)) reasons[r.reason || 'error'] = (reasons[r.reason || 'error'] || 0) + 1;
  const perPurpose = {};
  for (const [k, rows] of [...groupBy(main, purposeKey)].sort()) {
    perPurpose[k] = roundBlock(block(rows));
    const lat = rows.filter((r) => r.ok).map((r) => r.latencyMs);
    perPurpose[k].latencyP50 = percentile(lat, 50);
    perPurpose[k].latencyP95 = percentile(lat, 95);
  }
  const perLanguage = {};
  for (const [lang, rows] of [...groupBy(main, (r) => r.lang)].sort()) perLanguage[lang] = roundBlock(block(rows));
  const perPurposeLanguage = {};
  for (const [k, rows] of [...groupBy(main, purposeKey)].sort()) {
    perPurposeLanguage[k] = {};
    for (const [lang, sub] of [...groupBy(rows, (r) => r.lang)].sort()) {
      perPurposeLanguage[k][lang] = { n: sub.length, accuracy: round(sub.filter((r) => judge(r).correct).length / sub.length) };
    }
  }
  const sens = main.filter((r) => r.purpose === 'routing.sensitivity');
  const sup = main.filter((r) => r.purpose === 'step.supervise');
  const benign = sup.filter((r) => r.label === 'continue');
  return {
    model: records[0]?.model ?? null,
    overall: { ...roundBlock(block(main)), failed: main.filter((r) => !r.ok).length, failureReasons: reasons },
    latencyMs: {
      p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: percentile(latencies, 100),
      ...Object.fromEntries(DEADLINES_MS.map((d) => [`over${d}`, latencies.filter((x) => x > d).length + timedOut])),
    },
    perPurpose,
    perLanguage,
    perPurposeLanguage,
    sensitivity: { sensitiveRecall: round(rate(sens, 'sensitive', 'sensitive')), benignFlagged: round(rate(sens, 'not_sensitive', 'sensitive')) },
    supervision: {
      escalateRecall: round(rate(sup, 'escalate', 'escalate')),
      escalationsCaught: sup.filter((r) => r.label === 'escalate' && r.ok && r.selected === 'escalate').length,
      escalations: sup.filter((r) => r.label === 'escalate').length,
      benignPausedPer30: benign.length ? round((30 * benign.filter((r) => r.ok && r.selected === 'escalate').length) / benign.length, 2) : null,
    },
    orderFlips: (({ compared, flipped, rate: r }) => ({ compared, flipped, rate: round(r) }))(flipRate(records)),
  };
}

/** Languages below English on overall accuracy, worst first (at most `n`). */
function weakLanguages(summary, n = 3) {
  const langs = Object.entries(summary.perLanguage).filter(([lang]) => lang !== 'en');
  return langs.sort((a, b) => a[1].accuracy - b[1].accuracy).slice(0, n).map(([lang, b]) => `${lang} ${pct(b.accuracy)}`);
}

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '–');
const num = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const ms = (x) => (Number.isFinite(x) ? `${Math.round(x)}` : '–');
const mib = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 2 ** 20).toFixed(0)} MiB` : '–');

/** Markdown tables for the issue comment: one row per model. */
function markdown(summaries, rss = {}) {
  const purposes = [...new Set(summaries.flatMap((s) => Object.keys(s.perPurpose)))].sort();
  const lines = [];
  lines.push(`| Model | ${purposes.map((p) => `${p} acc`).join(' | ')} | overall acc | macro-F1 | ECE | Brier | p50 ms | p95 ms | >1.3 s | peak RAM | flips |`);
  lines.push(`|${' --- |'.repeat(purposes.length + 10)}`);
  for (const s of summaries) {
    const r = rss[s.model] || {};
    lines.push(`| ${s.model} | ${purposes.map((p) => pct(s.perPurpose[p]?.accuracy)).join(' | ')} | ${pct(s.overall.accuracy)} | ${num(s.overall.macroF1)} | ${num(s.overall.ece)} | ${num(s.overall.brier)} | ${ms(s.latencyMs.p50)} | ${ms(s.latencyMs.p95)} | ${s.latencyMs.over1300} | ${mib(r.peakBytes)} | ${pct(s.orderFlips.rate)} |`);
  }
  lines.push('');
  const langs = [...new Set(summaries.flatMap((s) => Object.keys(s.perLanguage)))].sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
  lines.push(`| Model | ${langs.join(' | ')} | weakest |`);
  lines.push(`|${' --- |'.repeat(langs.length + 2)}`);
  for (const s of summaries) lines.push(`| ${s.model} | ${langs.map((l) => pct(s.perLanguage[l]?.accuracy)).join(' | ')} | ${weakLanguages(s).join(', ') || '–'} |`);
  lines.push('');
  lines.push('| Model | sensitive recall | benign flagged | escalations caught | benign paused /30 | ECE per purpose | macro-F1 per purpose | failures |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of summaries) {
    const per = (k) => purposes.map((p) => `${p.replace(/^.*\./, '')} ${num(s.perPurpose[p]?.[k], 2)}`).join(', ');
    const failures = Object.entries(s.overall.failureReasons).map(([k, v]) => `${k} ${v}`).join(', ') || '0';
    lines.push(`| ${s.model} | ${pct(s.sensitivity.sensitiveRecall)} | ${pct(s.sensitivity.benignFlagged)} | ${s.supervision.escalationsCaught}/${s.supervision.escalations} | ${num(s.supervision.benignPausedPer30, 1)} | ${per('ece')} | ${per('macroF1')} | ${failures} |`);
  }
  return lines.join('\n') + '\n';
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function main(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--md' || a === '--rss') args[a.slice(2)] = argv[++i];
    else args.files.push(a);
  }
  if (!args.files.length || !args.out) throw Error('usage: node score.cjs --out report.json [--md report.md] [--rss rss.json] results.jsonl...');
  const rss = args.rss ? JSON.parse(fs.readFileSync(args.rss, 'utf8')) : {};
  const summaries = args.files.map((f) => summarize(readJsonl(f)));
  fs.writeFileSync(args.out, JSON.stringify({ generatedAt: new Date().toISOString(), rss, summaries }, null, 2) + '\n');
  if (args.md) fs.writeFileSync(args.md, markdown(summaries, rss));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { normalise, judge, percentile, ece, brier, macroF1, flipRate, block, summarize, markdown, weakLanguages, purposeKey, readJsonl };
