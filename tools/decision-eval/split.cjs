'use strict';
// #1639 phase A: a fixed, stratified tuning/held-out split of the synthetic cases. Wording is tuned
// on the tuning split only, and the result is measured on the held-out split. A case is the unit:
// its 'nocode' and 'perm1'/'perm2' variants go wherever its base request goes, so no wording is
// judged on a case it was tuned on.
//
// Strata are purpose x language x label (the label too, so small classes such as the 15 English
// escalations land on both sides). Inside a stratum the case ids are sorted, shuffled with a seeded
// PRNG (mulberry32), and the first round(n * fraction) go to tuning; a stratum of one goes to
// tuning with probability `fraction` (seeded too). Same seed and cases, same split, on any machine.
//
// Usage: node split.cjs --requests requests.jsonl --seed 1639 [--fraction 0.6] --tune tune.jsonl --heldout heldout.jsonl

const fs = require('node:fs');

const DEFAULT_FRACTION = 0.6;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** { tune: Set(id), heldout: Set(id), strata: [{ key, n, tune }] } over the base records' case ids. */
function splitIds(records, { seed, fraction = DEFAULT_FRACTION } = {}) {
  if (!Number.isInteger(seed)) throw Error('seed must be an integer');
  if (!(fraction > 0 && fraction < 1)) throw Error('fraction must be between 0 and 1');
  const strata = new Map();
  for (const r of records) {
    if (r.variant !== 'base') continue;
    const key = `${r.purpose}|${r.lang}|${r.label}`;
    if (!strata.has(key)) strata.set(key, new Set());
    strata.get(key).add(r.id);
  }
  const random = mulberry32(seed);
  const tune = new Set(), heldout = new Set(), summary = [];
  for (const key of [...strata.keys()].sort()) {
    const ids = [...strata.get(key)].sort();
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const k = ids.length > 1 ? Math.round(ids.length * fraction) : (random() < fraction ? 1 : 0);
    ids.forEach((id, i) => (i < k ? tune : heldout).add(id));
    summary.push({ key, n: ids.length, tune: k });
  }
  return { tune, heldout, strata: summary };
}

/** The records split by case id; every variant follows its case. Throws on a record with no base. */
function splitRecords(records, opts) {
  const { tune, heldout, strata } = splitIds(records, opts);
  const out = { tune: [], heldout: [] };
  for (const r of records) {
    if (tune.has(r.id)) out.tune.push(r);
    else if (heldout.has(r.id)) out.heldout.push(r);
    else throw Error(`${r.id}/${r.variant}: no base request`);
  }
  return { ...out, strata, cases: { tune: tune.size, heldout: heldout.size } };
}

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!a.requests || !a.tune || !a.heldout || a.seed === undefined) throw Error('usage: node split.cjs --requests FILE --seed N [--fraction 0.6] --tune FILE --heldout FILE');
  const s = splitRecords(readJsonl(a.requests), { seed: Number(a.seed), fraction: a.fraction === undefined ? DEFAULT_FRACTION : Number(a.fraction) });
  fs.writeFileSync(a.tune, toJsonl(s.tune));
  fs.writeFileSync(a.heldout, toJsonl(s.heldout));
  const count = (rows) => rows.reduce((m, r) => ((m[`${r.purpose}/${r.variant}`] = (m[`${r.purpose}/${r.variant}`] || 0) + 1), m), {});
  console.log(JSON.stringify({ seed: Number(a.seed), cases: s.cases, requests: { tune: s.tune.length, heldout: s.heldout.length }, tune: count(s.tune), heldout: count(s.heldout) }, null, 1));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { splitIds, splitRecords, mulberry32, DEFAULT_FRACTION };
