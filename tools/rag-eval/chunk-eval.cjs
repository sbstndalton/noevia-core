'use strict';
// noevia#1866: chunker comparison on synthetic paged documents with span-based gold.
// Extends the #1665 reranker harness (passage-level, pre-cut candidates) so that the CHUNKER is the
// variable: every arm cuts the same documents, and a chunk counts as a hit when it contains the whole
// gold answer sentence. That makes arms with different chunk sizes comparable.
// No dependencies; Node >= 18 with full ICU (Intl.Segmenter; the official node images have it).
//
//   gen    <outdir> [--docs=3] [--queries=5] [--pages=12] [--seed=1866]
//          writes dataset.json (synthetic documents in the exact `[Page N]\n...` form documents.cjs
//          assemble() produces, plus queries with their gold sentence). Synthetic only: invented towns.
//   chunk  <dataset> <outdir> [--arms=A,B,C,D,E,F] [--fbase=D]
//          offline: writes chunks-<arm>.json and prints per-arm chunk stats + gold coverage. No network.
//   embed  <dataset> <outdir> <embedBaseUrl> [--arms=..] [--fbase=D] [--model=embeddinggemma-2]
//          [--qprefix=..] [--dprefix=..] [--dim=768] [--batch=8] [--batchTok=4000] [--gapMs=1000] [--budget=SEC]
//          embeds queries + every distinct chunk text through the live embed service (read-only), one
//          request at a time with a pause between requests; waits while <outdir>/PAUSE exists (the
//          runner touches it when chat activity appears). Writes pools-<arm>.json (cosine top 12 >= 0.3).
//   rerank <dataset> <outdir> <teiUrl> [--arms=..] [--budget=SEC]
//          gte TEI POST /rerank over each pool (passages capped at 4000 chars, as rag.cjs). rr-<arm>.jsonl
//   score  <dataset> <outdir>      writes scores.json + scores.txt
const fs = require('fs');
const path = require('path');
const http = require('http');

// ------------------------------------------------------------------ constants mirrored from server/rag.cjs
const CHUNK_SIZE = 1200;
const CHUNK_STRIDE = 150;
const MIN_SCORE = 0.3;
const POOL = 12;
const KEEP = 6;
const DEADLINE_MS = 3000;
const PASSAGE_CAP = 4000;
const TOK = (s) => Math.ceil(String(s).length / 4); // chars/4, the estimate the audit uses
const ARMS = ['A', 'B', 'C', 'D', 'E', 'F'];

// ------------------------------------------------------------------ arm A: verbatim copy of rag.chunkText
// chunk-eval.test.cjs asserts this stays byte-identical in output to server/rag.cjs chunkText.
function chunkTextCurrent(text, pagePart = false) {
  if (!pagePart && /^\[Page \d+\]/.test(String(text))) {
    return String(text).split(/(?=\[Page \d+\]\n)/).filter(Boolean).flatMap(part => {
      const marker = part.match(/^\[Page \d+\]/)?.[0] || '';
      return chunkTextCurrent(part.slice(marker.length), true).map(chunk => marker + '\n' + chunk);
    });
  }
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const para = window.lastIndexOf('\n\n');
      if (para > CHUNK_SIZE * 0.5) {
        end = start + para + 1;
      } else {
        let best = -1;
        for (let i = window.length - 1; i >= CHUNK_SIZE * 0.5; i--) {
          if ('.!?\n'.includes(window[i])) { best = i; break; }
        }
        if (best > 0) end = start + best + 1;
      }
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_STRIDE, start + 1);
  }
  return chunks;
}

// ------------------------------------------------------------------ sentence tools
const SEG = new Intl.Segmenter('en', { granularity: 'sentence' });
/** [{start,end}] sentence spans of `text`; Markdown table rows and heading lines are their own unit. */
function sentenceSpans(text) {
  const out = [];
  // split on lines first so a table row / heading never merges with prose
  let off = 0;
  for (const line of text.split('\n')) {
    const ls = off; off += line.length + 1;
    if (!line.trim()) continue;
    if (/^\s*\|/.test(line) || isHeading(line)) { out.push({ start: ls, end: ls + line.length }); continue; }
    for (const s of SEG.segment(line)) {
      const a = ls + s.index; const b = a + s.segment.length;
      if (s.segment.trim()) out.push({ start: a, end: b });
    }
  }
  return out;
}
function isHeading(line) {
  const t = line.trim();
  return t.length > 0 && t.length <= 60 && !/[.!?:;,|]$/.test(t) && !/^\[Page \d+\]$/.test(t) && !/^\|/.test(t) && /^[A-Z]/.test(t);
}
/** Packs sentence spans of `text` into windows of <= size chars with <= overlap chars of whole trailing
 * sentences carried over. A single sentence longer than size is hard-cut (the only mid-sentence cut). */
function packSentences(text, size, overlap) {
  const sp = [];
  for (const s of sentenceSpans(text)) {
    if (s.end - s.start <= size) { sp.push(s); continue; }
    for (let a = s.start; a < s.end; a += size) sp.push({ start: a, end: Math.min(s.end, a + size) });
  }
  const chunks = [];
  let i = 0;
  while (i < sp.length) {
    let j = i;
    while (j + 1 < sp.length && sp[j + 1].end - sp[i].start <= size) j++;
    chunks.push({ start: sp[i].start, end: sp[j].end });
    if (j + 1 >= sp.length) break;
    // next window starts at the earliest trailing sentence that keeps the carried text within overlap
    let k = j + 1;
    while (k - 1 > i && sp[j].end - sp[k - 1].start <= overlap) k--;
    i = k;
  }
  return chunks.map((c) => ({ start: c.start, end: c.end, body: text.slice(c.start, c.end).trim() })).filter((c) => c.body);
}

// ------------------------------------------------------------------ arms B-F
/** B: same page handling and size as A, but every cut and every overlap start is on a sentence boundary. */
function chunkSentenceSnapped(text) {
  return String(text).split(/(?=\[Page \d+\]\n)/).filter(Boolean).flatMap((part) => {
    const marker = part.match(/^\[Page \d+\]/)?.[0] || '';
    const body = part.slice(marker.length).replace(/\r\n/g, '\n').trim();
    if (!body) return [];
    const pieces = body.length <= CHUNK_SIZE ? [body] : packSentences(body, CHUNK_SIZE, CHUNK_STRIDE).map((c) => c.body);
    return pieces.map((p) => (marker ? marker + '\n' + p : p));
  });
}
/** Joins pages into one text (a sentence crossing a page break is rejoined) and keeps a page map. */
function joinPages(text) {
  const parts = String(text).split(/(?=\[Page \d+\]\n)/).filter(Boolean);
  let joined = ''; const map = []; // [{at, page}]
  for (const part of parts) {
    const m = part.match(/^\[Page (\d+)\]\n/); const page = m ? +m[1] : null;
    let body = (m ? part.slice(m[0].length) : part).replace(/\r\n/g, '\n');
    const trimmedEnd = joined.replace(/\s+$/, '');
    if (joined) {
      const sentenceDone = /[.!?]$/.test(trimmedEnd) || /\|$/.test(trimmedEnd) || isHeading(trimmedEnd.split('\n').pop());
      joined = trimmedEnd + (sentenceDone ? '\n\n' : ' ');
      body = body.replace(/^\s+/, '');
    }
    map.push({ at: joined.length, page });
    joined += body;
  }
  return { text: joined, pageAt: (off) => { let p = map.length ? map[0].page : null; for (const e of map) { if (e.at <= off) p = e.page; else break; } return p; } };
}
/** C/D/E: sentence-aligned windows of about `tokens` tokens across pages; one-sentence overlap (<= 15%). */
function chunkTokenWindows(text, tokens, { headings = false } = {}) {
  const { text: joined, pageAt } = joinPages(text);
  const size = tokens * 4;
  const heads = [];
  if (headings) { let off = 0; for (const line of joined.split('\n')) { if (isHeading(line)) heads.push({ at: off, h: line.trim() }); off += line.length + 1; } }
  const headAt = (off) => { let h = null; for (const e of heads) { if (e.at <= off) h = e.h; else break; } return h; };
  return packSentences(joined, size, Math.floor(size * 0.15)).map((c) => {
    const page = pageAt(c.start); const h = headings ? headAt(c.start) : null;
    const startsWithHead = h && c.body.startsWith(h);
    return (page != null ? `[Page ${page}]\n` : '') + (h && !startsWithHead ? `Section: ${h}\n` : '') + c.body;
  });
}
const TOKENS = { C: 256, D: 512, E: 768 };
function chunkArm(arm, text, fbase = 'D') {
  if (arm === 'A') return chunkTextCurrent(text);
  if (arm === 'B') return chunkSentenceSnapped(text);
  if (TOKENS[arm]) return chunkTokenWindows(text, TOKENS[arm]);
  if (arm === 'F') {
    if (!TOKENS[fbase]) throw new Error(`--fbase must be C, D or E (got ${fbase}); B is per-page and has no heading variant`);
    return chunkTokenWindows(text, TOKENS[fbase], { headings: true });
  }
  throw new Error('unknown arm ' + arm);
}
const norm = (s) => String(s).replace(/\[Page \d+\]\n?/g, ' ').replace(/^Section: .*$/gm, ' ').replace(/\s+/g, ' ').trim();
const hasGold = (chunk, gold) => norm(chunk).includes(norm(gold));

// ------------------------------------------------------------------ synthetic generator
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const SYL = ['nor', 'dal', 'ves', 'kar', 'lin', 'mor', 'tav', 'sel', 'brin', 'hol', 'fen', 'gar', 'stro', 'vik', 'ber', 'lun', 'ost', 'rav', 'tel', 'quin'];
const END = ['havn', 'by', 'stad', 'dorf', 'mere', 'vale', 'holm', 'ford', 'heim', 'wick'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FIRST = ['Ada', 'Bram', 'Cora', 'Dag', 'Elin', 'Finn', 'Greta', 'Hugo', 'Ines', 'Jon', 'Kaja', 'Lars'];
const LAST = ['Lind', 'Moberg', 'Okafor', 'Petit', 'Rossi', 'Sato', 'Varga', 'Weber', 'Haug', 'Brandt'];
// Fact kinds: the sentence (gold) and the question in nine languages. {T} town, {V} value.
const FACTS = {
  founded: { s: '{T} was founded in the year {V} by a group of river traders.', v: (r) => String(1400 + Math.floor(r() * 500)),
    q: { en: 'When was {T} founded?', de: 'Wann wurde {T} gegründet?', es: '¿Cuándo se fundó {T}?', fr: 'Quand {T} a-t-elle été fondée ?', it: 'Quando è stata fondata {T}?', nb: 'Når ble {T} grunnlagt?', nl: 'Wanneer is {T} gesticht?', pt: 'Quando foi fundada {T}?', sv: 'När grundades {T}?' } },
  reservoir: { s: 'The main reservoir of {T} holds {V} million litres of drinking water.', v: (r) => (1 + r() * 9).toFixed(1),
    q: { en: 'How much water does the reservoir of {T} hold?', de: 'Wie viel Wasser fasst das Reservoir von {T}?', es: '¿Cuánta agua almacena el embalse de {T}?', fr: "Combien d'eau contient le réservoir de {T} ?", it: "Quanta acqua contiene il serbatoio di {T}?", nb: 'Hvor mye vann rommer reservoaret i {T}?', nl: 'Hoeveel water bevat het reservoir van {T}?', pt: 'Quanta água comporta o reservatório de {T}?', sv: 'Hur mycket vatten rymmer reservoaren i {T}?' } },
  bridge: { s: 'The old stone bridge in {T} is {V} metres long and was restored twice.', v: (r) => String(40 + Math.floor(r() * 300)),
    q: { en: 'How long is the old bridge in {T}?', de: 'Wie lang ist die alte Brücke in {T}?', es: '¿Qué longitud tiene el puente viejo de {T}?', fr: 'Quelle est la longueur du vieux pont de {T} ?', it: "Quanto è lungo il vecchio ponte di {T}?", nb: 'Hvor lang er den gamle brua i {T}?', nl: 'Hoe lang is de oude brug in {T}?', pt: 'Qual é o comprimento da ponte velha de {T}?', sv: 'Hur lång är den gamla bron i {T}?' } },
  mayor: { s: 'The current mayor of {T} is {V}, elected after a close second round.', v: (r) => `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`,
    q: { en: 'Who is the mayor of {T}?', de: 'Wer ist Bürgermeister von {T}?', es: '¿Quién es el alcalde de {T}?', fr: 'Qui est le maire de {T} ?', it: 'Chi è il sindaco di {T}?', nb: 'Hvem er ordfører i {T}?', nl: 'Wie is de burgemeester van {T}?', pt: 'Quem é o prefeito de {T}?', sv: 'Vem är borgmästare i {T}?' } },
  festival: { s: '{T} holds its harvest festival every year in {V}, on the market square.', v: (r) => MONTHS[Math.floor(r() * 12)],
    q: { en: 'In which month is the harvest festival of {T}?', de: 'In welchem Monat ist das Erntefest von {T}?', es: '¿En qué mes es la fiesta de la cosecha de {T}?', fr: 'En quel mois a lieu la fête des récoltes de {T} ?', it: 'In quale mese si tiene la festa del raccolto di {T}?', nb: 'Hvilken måned er høstfesten i {T}?', nl: 'In welke maand is het oogstfeest van {T}?', pt: 'Em que mês é a festa da colheita de {T}?', sv: 'Vilken månad är skördefesten i {T}?' } },
};
const LANGS = ['en', 'de', 'es', 'fr', 'it', 'nb', 'nl', 'pt', 'sv'];
const HEADINGS = ['History', 'Water supply', 'Transport and bridges', 'Local government', 'Culture and events', 'Economy', 'Population trends', 'Infrastructure notes'];
// Filler: hard negatives (same towns, other topics) plus decimals and abbreviations that a naive
// '.'-splitter treats as sentence ends ("3.5 km", "Dr. Lind", "approx. 40").
const FILLER = [
  'Council minutes from {Y} note that {T} spent approx. {D} percent of its budget on road repairs.',
  'Dr. {N} of the regional office reviewed the water tests in {T} and found no issues.',
  'The ferry between {T} and {U} runs every {D} hours in summer and less often in winter.',
  'A survey counted {P} households in {T}, a small change compared with the previous count.',
  'Visitors to {T} often mention the {D} km walking path along the river.',
  'The school in {T} added a new library wing, paid for by a local trust.',
  'Records show that {U} and {T} shared a tax collector until {Y}.',
  'In {Y} a storm damaged several roofs in {T}; repairs took about {D} months.',
  'The bus line to {U} was extended, and the trip now takes {D} minutes on average.',
  'Prof. {N} described the old mill in {T} as one of the best preserved in the area.',
];
function town(r, used) { for (;;) { const t = SYL[Math.floor(r() * SYL.length)].replace(/^./, (c) => c.toUpperCase()) + SYL[Math.floor(r() * SYL.length)] + END[Math.floor(r() * END.length)]; if (!used.has(t)) { used.add(t); return t; } } }
function twinOf(t, used) { const alts = [t.replace(/([aeiou])/, (m) => ({ a: 'e', e: 'a', i: 'y', o: 'u', u: 'o' })[m]), t + 'e', t.slice(0, -1)]; for (const a of alts) if (a !== t && !used.has(a)) { used.add(a); return a; } return null; }
function fill(tpl, r, ctx) {
  return tpl.replace(/\{T\}/g, ctx.T).replace(/\{U\}/g, ctx.U).replace(/\{Y\}/g, () => String(1700 + Math.floor(r() * 320)))
    .replace(/\{D\}/g, () => (r() < 0.5 ? String(2 + Math.floor(r() * 30)) : (1 + r() * 9).toFixed(1)))
    .replace(/\{P\}/g, () => String(300 + Math.floor(r() * 9000))).replace(/\{N\}/g, () => LAST[Math.floor(r() * LAST.length)]);
}
function table(r, T) {
  const rows = ['| Year | Visitors | Events |', '|---|---|---|'];
  for (let i = 0; i < 4 + Math.floor(r() * 6); i++) rows.push(`| ${2000 + i * 2} | ${Math.floor(r() * 90000)} | ${Math.floor(r() * 40)} |`);
  return `Visitor numbers for ${T}:\n` + rows.join('\n');
}

function generate({ docs = 3, queries = 5, pages = 12, seed = 1866 } = {}) {
  const r = rng(seed); const used = new Set();
  const kinds = Object.keys(FACTS);
  const allFacts = []; const outDocs = [];
  for (let d = 0; d < docs; d++) {
    const towns = [town(r, used), town(r, used), town(r, used)];
    // the facts of this document: every town gets 2 kinds; a near-twin town gets the same kind with another value
    const facts = [];
    for (const T of towns) {
      const ks = kinds.slice().sort(() => r() - 0.5).slice(0, 2);
      for (const k of ks) facts.push({ kind: k, T, V: FACTS[k].v(r) });
      const tw = twinOf(T, used);
      if (tw) facts.push({ kind: ks[0], T: tw, V: FACTS[ks[0]].v(r), twin: true });
    }
    facts.sort(() => r() - 0.5);
    // build paragraphs, then pages; facts are dropped at random paragraph positions
    const paras = []; let headIdx = 0;
    const targetChars = pages * 1800;
    let fi = 0; let total = 0;
    while (total < targetChars || fi < facts.length) {
      if (paras.length % 5 === 0) { paras.push({ kind: 'h', text: HEADINGS[headIdx++ % HEADINGS.length] }); }
      const ti = Math.floor(r() * towns.length); const ctx = { T: towns[ti], U: towns[(ti + 1 + Math.floor(r() * (towns.length - 1))) % towns.length] };
      if (r() < 0.12) { const t = table(r, ctx.T); paras.push({ kind: 't', text: t }); total += t.length; continue; }
      const sents = []; const n = 3 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) sents.push(fill(FILLER[Math.floor(r() * FILLER.length)], r, ctx));
      const p = { kind: 'p', sents };
      if (fi < facts.length && (r() < 0.35 || total >= targetChars)) {
        const f = facts[fi++]; const sentence = FACTS[f.kind].s.replace('{T}', f.T).replace('{V}', f.V);
        const at = Math.floor(r() * (sents.length + 1)); sents.splice(at, 0, sentence);
        p.fact = { ...f, sentence };
      }
      paras.push(p); total += sents.join(' ').length;
    }
    // render paragraphs into pages of a random length; some page breaks fall inside a gold sentence
    const id = `doc${d + 1}`;
    const pageTexts = []; let cur = '';
    const pageLen = () => (r() < 0.15 ? 300 + Math.floor(r() * 400) : 1200 + Math.floor(r() * 1400));
    let limit = pageLen();
    const flush = () => { if (cur.trim()) pageTexts.push(cur.trim()); cur = ''; limit = pageLen(); };
    for (const p of paras) {
      if (p.kind !== 'p') { const add = p.text + '\n\n'; if (cur.length + add.length > limit && cur) flush(); cur += add; continue; }
      for (const s of p.sents) {
        const add = s + ' ';
        const isFact = p.fact && s === p.fact.sentence;
        const forceStraddle = isFact && cur.length >= 300 && r() < 0.25; // about a quarter of facts are cut by a page break
        if ((cur.length + add.length > limit && cur) || forceStraddle) {
          if (isFact && (forceStraddle || r() < 0.5)) { // straddle: break the page in the middle of the gold sentence
            const words = s.split(' '); const cut = Math.max(2, Math.floor(words.length / 2));
            cur += words.slice(0, cut).join(' '); flush(); cur += words.slice(cut).join(' ') + ' ';
            p.fact.straddlesPage = true; continue;
          }
          flush();
        }
        cur += add;
      }
      cur = cur.replace(/ $/, '') + '\n\n';
    }
    flush();
    const text = pageTexts.map((t, i) => `[Page ${i + 1}]\n${t}`).join('\n\n');
    outDocs.push({ id, title: `Municipal report ${d + 1}`, pages: pageTexts.length, text });
    for (const p of paras) if (p.fact) allFacts.push({ doc: id, ...p.fact });
  }
  // queries: non-twin facts, languages rotated (en first), deterministic spread over documents
  // About one query in five asks for a sentence that a page break cuts (when the set has such facts).
  // More queries than facts: a fact is asked again in another language (round r uses a shifted language).
  const cands = allFacts.filter((f) => !f.twin);
  const strad = cands.filter((f) => f.straddlesPage); const rest = cands.filter((f) => !f.straddlesPage);
  const nb = Math.min(queries, cands.length); const ns = Math.min(strad.length, Math.ceil(nb / 5)); const nr = Math.min(rest.length, nb - ns);
  const spread = (arr, k) => Array.from({ length: k }, (_, i) => arr[Math.floor(i * arr.length / k)]);
  const base = [...spread(rest, nr), ...spread(strad, Math.min(strad.length, nb - nr))];
  for (let i = base.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [base[i], base[j]] = [base[j], base[i]]; }
  const qs = Array.from({ length: base.length ? queries : 0 }, (_, i) => {
    const f = base[i % base.length]; const round = Math.floor(i / base.length);
    const lang = round === 0 ? (i % 3 === 0 ? 'en' : LANGS[(i % (LANGS.length - 1)) + 1]) : LANGS[(i + round) % LANGS.length];
    return { id: `q${i + 1}`, lang, crossLingual: lang !== 'en', kind: f.kind, doc: f.doc, text: FACTS[f.kind].q[lang].replace('{T}', f.T), gold: f.sentence, straddlesPage: !!f.straddlesPage,
      hasTwin: allFacts.some((g) => g.twin && g.kind === f.kind && g.T !== f.T && twinBase(g.T, f.T)) };
  });
  return { version: 1, synthetic: true, seed, params: { docs, queries, pages }, docs: outDocs, queries: qs };
}
function twinBase(a, b) { if (Math.abs(a.length - b.length) > 1) return false; let diff = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) diff++; return diff + Math.abs(a.length - b.length) <= 1; }

// ------------------------------------------------------------------ chunk all docs for an arm
function chunkCorpus(ds, arm, fbase) {
  const out = [];
  for (const d of ds.docs) {
    const pieces = chunkArm(arm, d.text, fbase); const seen = new Set();
    pieces.forEach((body) => { if (seen.has(body)) return; seen.add(body); out.push({ id: `${arm}:${d.id}:${out.length}`, doc: d.id, body }); });
  }
  return out;
}
function chunkStats(ds, chunks) {
  const toks = chunks.map((c) => TOK(c.body)); const mean = toks.reduce((a, b) => a + b, 0) / (toks.length || 1);
  const covered = ds.queries.filter((q) => chunks.some((c) => c.doc === q.doc && hasGold(c.body, q.gold))).length;
  return { chunks: chunks.length, meanTok: Math.round(mean), maxTok: Math.max(0, ...toks), over2048Tok: toks.filter((t) => t > 2048).length, goldReachable: covered, queries: ds.queries.length };
}

// ------------------------------------------------------------------ io
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function req(method, url, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false, headers: Object.assign({ connection: 'close' }, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => { if (res.statusCode >= 300) reject(Object.assign(new Error(`${res.statusCode} ${b.slice(0, 300)}`), { status: res.statusCode })); else { try { resolve(JSON.parse(b)); } catch { reject(new Error('bad json: ' + b.slice(0, 200))); } } });
    });
    r.on('error', reject); r.setTimeout(timeoutMs, () => r.destroy(new Error('timeout'))); if (data) r.write(data); r.end();
  });
}
async function waitPause(outDir, deadlineMs) { // runner touches PAUSE when chat activity shows up; bounded wait
  const t0 = Date.now(); let waited = 0;
  while (fs.existsSync(path.join(outDir, 'PAUSE'))) {
    if (Date.now() - t0 > deadlineMs) throw new Error('PAUSE held longer than ' + deadlineMs / 1000 + ' s; stopping');
    await sleep(2000); waited += 2000;
  }
  if (fs.existsSync(path.join(outDir, 'ABORT'))) throw new Error('ABORT file present');
  return waited;
}
const arg = (opt, k, d) => (opt[k] === undefined || opt[k] === true ? d : opt[k]);
function armsOf(opt) { const a = String(arg(opt, 'arms', ARMS.join(','))).split(',').filter(Boolean); for (const x of a) if (!ARMS.includes(x)) throw new Error('bad arm ' + x); return a; }

async function embedPhase(ds, outDir, base, opt) {
  const model = arg(opt, 'model', 'embeddinggemma-2'); const qp = arg(opt, 'qprefix', 'task: search result | query: '); const dp = arg(opt, 'dprefix', 'title: none | text: ');
  const batchN = +arg(opt, 'batch', 8); const batchTok = +arg(opt, 'batchTok', 4000); const gapMs = +arg(opt, 'gapMs', 1000); const budget = +arg(opt, 'budget', 0);
  const fbase = arg(opt, 'fbase', 'D'); const arms = armsOf(opt);
  const stats = { model, queryPrefix: qp, documentPrefix: dp, requests: 0, texts: 0, refused: [], pausedMs: 0, retries: 0, perArm: {} };
  // the model check: the service must list the model we ask for
  const models = await req('GET', `${base}/models`, undefined, 10000); stats.requests++;
  const ids = (models.data || []).map((m) => m.id); stats.serviceModels = ids;
  if (!ids.includes(model)) throw new Error(`model ${model} not served by ${base} (has: ${ids.join(', ')})`);
  const vec = new Map(); const t00 = Date.now(); let last = 0;
  async function embedTexts(texts) { // texts: distinct strings already framed
    const todo = texts.filter((t) => !vec.has(t)); let i = 0;
    while (i < todo.length) {
      const batch = []; let tok = 0;
      while (i < todo.length && batch.length < batchN && (batch.length === 0 || tok + TOK(todo[i]) <= batchTok)) { tok += TOK(todo[i]); batch.push(todo[i++]); }
      if (budget && (Date.now() - t00) / 1000 > budget) throw new Error('embed budget exceeded');
      stats.pausedMs += await waitPause(outDir, 15 * 60 * 1000);
      const wait = gapMs - (Date.now() - last); if (wait > 0) await sleep(wait);
      last = Date.now(); stats.requests++;
      let j = null;
      for (let attempt = 0; attempt < 3 && !j; attempt++) {
        try { j = await req('POST', `${base}/embeddings`, { model, input: batch }); } catch (e) {
          if (e.status && e.status < 500) break; // a refusal: fall back to one text at a time below
          stats.retries++; await sleep([2000, 5000, 10000][attempt]);
        }
      }
      if (j) { j.data.forEach((d) => vec.set(batch[d.index], d.embedding)); continue; }
      for (const t of batch) { // per-text fallback, still throttled
        await sleep(gapMs); stats.requests++;
        try { const k = await req('POST', `${base}/embeddings`, { model, input: [t] }); vec.set(t, k.data[0].embedding); } catch (e) { stats.refused.push({ tokEst: TOK(t), err: String(e.message).slice(0, 160) }); vec.set(t, null); }
      }
    }
    stats.texts = vec.size;
  }
  const nrm = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
  const qTexts = ds.queries.map((q) => qp + q.text);
  await embedTexts(qTexts);
  const dim = vec.get(qTexts[0]).length; stats.dim = dim;
  if (opt.dim && +opt.dim !== dim) throw new Error(`embedding dim ${dim} != expected ${opt.dim}`);
  for (const arm of arms) {
    const chunks = chunkCorpus(ds, arm, fbase);
    fs.writeFileSync(path.join(outDir, `chunks-${arm}.json`), JSON.stringify(chunks));
    const t0 = Date.now(); const before = stats.requests;
    await embedTexts(chunks.map((c) => dp + c.body));
    const cv = chunks.map((c) => { const v = vec.get(dp + c.body); return v ? nrm(v) : null; });
    const pools = {};
    for (const q of ds.queries) {
      const qv = nrm(vec.get(qp + q.text));
      pools[q.id] = cv.map((v, i) => [i, v ? v.reduce((s, x, k) => s + x * qv[k], 0) : -2]).filter((x) => x[1] >= MIN_SCORE).sort((a, b) => b[1] - a[1]).slice(0, POOL).map(([i, s]) => [i, +s.toFixed(5)]);
    }
    fs.writeFileSync(path.join(outDir, `pools-${arm}.json`), JSON.stringify(pools));
    stats.perArm[arm] = { ...chunkStats(ds, chunks), embedSec: +((Date.now() - t0) / 1000).toFixed(1), embedRequests: stats.requests - before, refusedChunks: cv.filter((v) => !v).length };
    console.log('embedded arm', arm, JSON.stringify(stats.perArm[arm]));
  }
  stats.totalSec = +((Date.now() - t00) / 1000).toFixed(1);
  fs.writeFileSync(path.join(outDir, 'embed.meta.json'), JSON.stringify(stats, null, 1));
  console.log('embed done: requests', stats.requests, 'texts', stats.texts, 'dim', dim, 'model', model, 'refused', stats.refused.length);
}

async function rerankPhase(ds, outDir, url, opt) {
  const arms = armsOf(opt); const budget = +arg(opt, 'budget', 0); const t00 = Date.now();
  let info = null; try { info = await req('GET', `${url}/info`, undefined, 5000); } catch (e) { info = { error: String(e.message) }; }
  const call = (q, texts) => req('POST', `${url}/rerank`, { query: q.text, texts: texts.map((t) => t.slice(0, PASSAGE_CAP)), truncate: true });
  const meta = { serverInfo: info && { model_id: info.model_id, max_input_length: info.max_input_length, version: info.version, error: info.error }, arms: {} };
  for (const arm of arms) {
    const chunks = JSON.parse(fs.readFileSync(path.join(outDir, `chunks-${arm}.json`), 'utf8'));
    const pools = JSON.parse(fs.readFileSync(path.join(outDir, `pools-${arm}.json`), 'utf8'));
    const first = ds.queries.find((q) => pools[q.id].length > 1); if (first) await call(first, pools[first.id].map(([i]) => chunks[i].body)); // warm-up, not timed
    const out = fs.openSync(path.join(outDir, `rr-${arm}.jsonl`), 'w'); let done = 0; let stopped = false;
    for (const q of ds.queries) {
      if (budget && (Date.now() - t00) / 1000 > budget) { stopped = true; break; }
      if (fs.existsSync(path.join(outDir, 'ABORT'))) { stopped = true; break; }
      const pool = pools[q.id]; let order = pool.map(([i]) => i); let err = null; let ms = 0;
      if (pool.length > 1) {
        const t0 = process.hrtime.bigint();
        try { const s = await call(q, pool.map(([i]) => chunks[i].body)); order = s.slice().sort((a, b) => b.score - a.score).map((x) => pool[x.index][0]); } catch (e) { err = String(e.message).slice(0, 200); }
        ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      fs.writeSync(out, JSON.stringify({ q: q.id, ms, err, order, tokSent: pool.reduce((s, [i]) => s + TOK(chunks[i].body.slice(0, PASSAGE_CAP)), 0) }) + '\n'); done++;
    }
    fs.closeSync(out); meta.arms[arm] = { done, stopped }; console.log('reranked arm', arm, done + '/' + ds.queries.length, stopped ? '(stopped)' : '');
  }
  fs.writeFileSync(path.join(outDir, 'rerank.meta.json'), JSON.stringify(meta, null, 1));
}

// ------------------------------------------------------------------ scoring (same metric definitions as #1665 harness2.cjs)
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
function wilson(k, n) { if (!n) return null; const z = 1.96, ph = k / n, d = 1 + z * z / n, c = ph + z * z / (2 * n), m = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)); return [+(100 * (c - m) / d).toFixed(1), +(100 * (c + m) / d).toFixed(1)]; }
/** items: [{pos}] where pos = 0-based rank of the first chunk containing the gold sentence among the KEPT list, -1 if none. */
function metrics(items) {
  const n = items.length; if (!n) return { n: 0 };
  let g1 = 0, g3 = 0, g6 = 0, nd = 0, mrr = 0;
  for (const { pos } of items) {
    if (pos === 0) g1++; if (pos >= 0 && pos < 3) g3++; if (pos >= 0 && pos < 6) { g6++; nd += 1 / Math.log2(pos + 2); }
    mrr += pos >= 0 ? 1 / (pos + 1) : 0;
  }
  const f = (x) => +(100 * x / n).toFixed(1);
  return { n, gold1: f(g1), gold1_ci95: wilson(g1, n), gold3: f(g3), gold6: f(g6), gold6_ci95: wilson(g6, n), ndcg6: +(nd / n).toFixed(3), mrr: +(mrr / n).toFixed(3) };
}
function firstGold(order, chunks, q) { return order.slice(0, KEEP).findIndex((i) => chunks[i].doc === q.doc && hasGold(chunks[i].body, q.gold)); }
function score(ds, outDir) {
  const em = JSON.parse(fs.readFileSync(path.join(outDir, 'embed.meta.json'), 'utf8'));
  const Q = Object.fromEntries(ds.queries.map((q) => [q.id, q]));
  const res = { dataset: { synthetic: ds.synthetic, seed: ds.seed, params: ds.params, docs: ds.docs.length, pages: ds.docs.reduce((s, d) => s + d.pages, 0), queries: ds.queries.length },
    embed: { model: em.model, dim: em.dim, requests: em.requests, texts: em.texts, refused: em.refused.length, pausedMs: em.pausedMs, retries: em.retries, totalSec: em.totalSec }, arms: {} };
  const lines = [`dataset: ${res.dataset.docs} docs / ${res.dataset.pages} pages / ${res.dataset.queries} queries (seed ${ds.seed}); embed ${em.model} dim ${em.dim}, ${em.requests} requests, ${em.refused.length} refused, ${em.totalSec}s`];
  lines.push('arm/mode           n  g@1   g@3   g@6   nDCG@6 MRR    pool@12 chunks meanTok keptTok  rr p50/p95 ms  >3s');
  for (const arm of ARMS) {
    const pf = path.join(outDir, `pools-${arm}.json`); if (!fs.existsSync(pf)) continue;
    const chunks = JSON.parse(fs.readFileSync(path.join(outDir, `chunks-${arm}.json`), 'utf8')); const pools = JSON.parse(fs.readFileSync(pf, 'utf8'));
    const st = em.perArm[arm];
    const cosItems = ds.queries.map((q) => ({ q, pos: firstGold(pools[q.id].map(([i]) => i), chunks, q), inPool: pools[q.id].some(([i]) => chunks[i].doc === q.doc && hasGold(chunks[i].body, q.gold)), kept: pools[q.id].slice(0, KEEP).map(([i]) => i) }));
    const keptTok = (its) => Math.round(its.reduce((s, it) => s + it.kept.reduce((a, i) => a + TOK(chunks[i].body), 0), 0) / (its.length || 1));
    const poolRecall = +(100 * cosItems.filter((x) => x.inPool).length / cosItems.length).toFixed(1);
    const groups = (its) => ({ all: metrics(its), en: metrics(its.filter((x) => !x.q.crossLingual)), crossLingual: metrics(its.filter((x) => x.q.crossLingual)), straddlesPage: metrics(its.filter((x) => x.q.straddlesPage)), hasTwin: metrics(its.filter((x) => x.q.hasTwin)) });
    const a = { stats: st, cosine: { ...groups(cosItems), poolRecall12: poolRecall, keptTokMean: keptTok(cosItems) } };
    const row = (tag, m, extra) => `${tag.padEnd(16)} ${String(m.n).padStart(3)} ${String(m.gold1).padStart(5)} ${String(m.gold3).padStart(5)} ${String(m.gold6).padStart(5)}  ${String(m.ndcg6).padEnd(6)} ${String(m.mrr).padEnd(6)} ${extra}`;
    lines.push(row(`${arm} cosine`, a.cosine.all, `${String(poolRecall).padStart(6)}  ${String(st.chunks).padStart(6)} ${String(st.meanTok).padStart(7)} ${String(a.cosine.keptTokMean).padStart(7)}`));
    const rf = path.join(outDir, `rr-${arm}.jsonl`);
    if (fs.existsSync(rf)) {
      const rows = fs.readFileSync(rf, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const ok = rows.filter((r) => !r.err); const ms = ok.filter((r) => r.ms > 0).map((r) => r.ms);
      const rrItems = ok.map((r) => ({ q: Q[r.q], pos: firstGold(r.order, chunks, Q[r.q]), kept: r.order.slice(0, KEEP) }));
      // what production would return: past the 3 s deadline (or on an error) rag.cjs falls back to cosine
      const effItems = rows.map((r) => { const q = Q[r.q]; const fb = r.err || r.ms > DEADLINE_MS; const order = fb ? pools[r.q].map(([i]) => i) : r.order; return { q, pos: firstGold(order, chunks, q), kept: order.slice(0, KEEP) }; });
      a.rerank = { ...groups(rrItems), keptTokMean: keptTok(rrItems), latency: { n: rows.length, errors: rows.length - ok.length, firstError: (rows.find((r) => r.err) || {}).err || null, p50: pct(ms, 50), p95: pct(ms, 95), max: ms.length ? Math.max(...ms) : null, over3s: ms.filter((x) => x > DEADLINE_MS).length, meanTokSent: Math.round(ok.reduce((s, r) => s + r.tokSent, 0) / (ok.length || 1)) } };
      a.rerankWithDeadline = groups(effItems);
      const L = a.rerank.latency;
      lines.push(row(`${arm} rerank`, a.rerank.all, `${String(poolRecall).padStart(6)}  ${String(st.chunks).padStart(6)} ${String(st.meanTok).padStart(7)} ${String(a.rerank.keptTokMean).padStart(7)}  ${L.p50}/${L.p95}  ${L.over3s}${L.errors ? ' err ' + L.errors : ''}`));
    }
    res.arms[arm] = a;
  }
  fs.writeFileSync(path.join(outDir, 'scores.json'), JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(outDir, 'scores.txt'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  return res;
}

module.exports = { chunkTextCurrent, chunkSentenceSnapped, chunkTokenWindows, chunkArm, chunkCorpus, chunkStats, joinPages, packSentences, sentenceSpans, hasGold, norm, generate, metrics, score, embedPhase, rerankPhase, ARMS };

if (require.main === module) {
  const [, , mode, ...rest] = process.argv;
  const pos = rest.filter((a) => !a.startsWith('--'));
  const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
  const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  (async () => {
    if (mode === 'gen') {
      const ds = generate({ docs: +arg(opt, 'docs', 3), queries: +arg(opt, 'queries', 5), pages: +arg(opt, 'pages', 12), seed: +arg(opt, 'seed', 1866) });
      fs.mkdirSync(pos[0], { recursive: true }); fs.writeFileSync(path.join(pos[0], 'dataset.json'), JSON.stringify(ds));
      console.log('generated', ds.docs.length, 'docs,', ds.docs.reduce((s, d) => s + d.pages, 0), 'pages,', ds.queries.length, 'queries');
    } else if (mode === 'chunk') {
      const ds = load(pos[0]); fs.mkdirSync(pos[1], { recursive: true });
      for (const arm of armsOf(opt)) { const c = chunkCorpus(ds, arm, arg(opt, 'fbase', 'D')); fs.writeFileSync(path.join(pos[1], `chunks-${arm}.json`), JSON.stringify(c)); console.log(arm, JSON.stringify(chunkStats(ds, c))); }
    } else if (mode === 'embed') await embedPhase(load(pos[0]), pos[1], pos[2], opt);
    else if (mode === 'rerank') await rerankPhase(load(pos[0]), pos[1], pos[2], opt);
    else if (mode === 'score') score(load(pos[0]), pos[1]);
    else throw new Error('mode: gen | chunk | embed | rerank | score');
  })().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
}
