'use strict';
// Deep research foundations (docs/spec-deep-research.md §5–6): a per-job source registry,
// deterministic page reduction and a citation verifier. No model call happens here.
const crypto = require('node:crypto');
const { tokens } = require('./chat-context.cjs');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const normalise = (text) => String(text).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set('a an and are as at be but by for from has have in is it its of on or that the this to was were which with into than then there their they also can may will'.split(' '));
// Negations are content words whatever their length, so "not" and "no" must match like any other word (#707).
const NEGATIONS = new Set('not no never without none nor neither nobody nothing nowhere'.split(' '));
const words = (text) => normalise(String(text).replace(/n['’]t\b/gi, ' not').replace(/\bcannot\b/gi, 'can not'))
  .split(' ').filter((w) => NEGATIONS.has(w) || (w.length > 2 && !STOP.has(w)));

// §5 (#707): sentence-level evidence. Every excerpt is split into sentences and each sentence gets
// a job-wide ID (S1, S2, …) so the write step can cite the exact sentence that states a claim.
function splitSentences(text) {
  return String(text).split(/\n+|(?<=[.!?]["”')\]]?)\s+(?=["“(]?[\p{Lu}\p{N}])/u).map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => words(x).length || /\d/.test(x));
}

function createRegistry() {
  const sources = [];
  const bySentenceId = new Map();
  let nextSentence = 1;
  function addSentences(target, text) {
    for (const sentence of splitSentences(text)) {
      const key = normalise(sentence);
      if (target.sentences.some((x) => normalise(x.text) === key)) continue;
      const entry = { id: `S${nextSentence++}`, text: sentence };
      target.sentences.push(entry);
      bySentenceId.set(entry.id, { ...entry, sourceId: target.id });
    }
  }
  function register({ kind, url = null, file = null, title = '', retrievedAt = Date.now(), excerpts = [] }) {
    if (kind !== 'web' && kind !== 'project') throw Error('Source kind must be web or project');
    if (kind === 'web' && !/^https?:\/\//i.test(String(url || ''))) throw Error('A web source needs an http(s) URL');
    if (kind === 'project' && !file) throw Error('A project source needs a file');
    // The same page or file registers once; later excerpts join it.
    const existing = sources.find((s) => s.kind === kind && s.url === url && s.file === file);
    const target = existing || { id: sources.length + 1, kind, url, file, title: String(title).slice(0, 300), retrievedAt, excerpts: [], sentences: [] };
    for (const text of excerpts) {
      const hash = sha256(text);
      if (!target.excerpts.some((e) => e.sha256 === hash)) { target.excerpts.push({ sha256: hash, text }); addSentences(target, text); }
    }
    if (!existing) sources.push(target);
    return target.id;
  }
  // The sentences of the given excerpts of one source, in excerpt order, with their stable IDs.
  function sentencesOf(id, excerptTexts) {
    const source = sources.find((s) => s.id === id);
    if (!source) return [];
    const out = [];
    for (const text of excerptTexts) {
      for (const sentence of splitSentences(text)) {
        const found = source.sentences.find((x) => normalise(x.text) === normalise(sentence));
        if (found && !out.includes(found)) out.push(found);
      }
    }
    return out.map((x) => ({ ...x, sourceId: id }));
  }
  return { register, sentencesOf, sentence: (sid) => bySentenceId.get(String(sid)) || null,
    get: (id) => sources.find((s) => s.id === id) || null,
    list: () => sources.map((s) => ({ ...s, excerpts: [...s.excerpts], sentences: s.sentences.map((x) => ({ ...x })) })) };
}

// Boilerplate strip → heading-aware chunks → ranked by the sub-question → capped.
function stripBoilerplate(text) {
  return String(text)
    .replace(/<(script|style|nav|footer|header|aside|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n').replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l && !/^(cookie|accept all|subscribe|sign in|log in|share this|skip to content)\b/i.test(l))
    .join('\n');
}

function chunk(text, maxTokens = 300) {
  const out = [];
  let heading = '', buf = [];
  const flush = () => { if (buf.length) out.push({ heading, text: buf.join('\n') }); buf = []; };
  for (const line of text.split('\n')) {
    if (/^#{1,6} /.test(line)) { flush(); heading = line.replace(/^#+ /, ''); continue; }
    if (buf.length && tokens([...buf, line].join('\n')) > maxTokens) flush();
    buf.push(line);
  }
  flush();
  return out;
}

// Lexical overlap is the deterministic default; pass `score` (e.g. embedding similarity) to override.
function lexicalScore(question, chunkText) {
  const q = new Set(words(question));
  if (!q.size) return 0;
  const c = new Set(words(chunkText));
  let hit = 0;
  for (const w of q) if (c.has(w)) hit++;
  return hit / q.size;
}

async function reduce(pageText, question, { perSourceTokens = 1200, chunkTokens = 300, score = lexicalScore } = {}) {
  const chunks = chunk(stripBoilerplate(pageText), chunkTokens);
  const scored = [];
  for (const [i, c] of chunks.entries()) scored.push({ i, c, s: await score(question, `${c.heading}\n${c.text}`) });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const { i, c, s } of scored) {
    if (s <= 0 && picked.length) break;
    const t = tokens(c.text);
    if (used + t > perSourceTokens) continue;
    picked.push({ i, text: c.heading ? `${c.heading}: ${c.text}` : c.text }); used += t;
  }
  // Keep document order so excerpts read naturally.
  return picked.sort((a, b) => a.i - b.i).map((p) => p.text);
}

// Caps a sub-question's excerpts across sources, earliest-registered first.
function capExcerpts(excerptsBySource, maxTokens = 6000) {
  let used = 0;
  const out = [];
  for (const { id, excerpts } of excerptsBySource) {
    const kept = [];
    for (const e of excerpts) { const t = tokens(e); if (used + t > maxTokens) break; kept.push(e); used += t; }
    if (kept.length) out.push({ id, excerpts: kept });
  }
  return out;
}

// ---- Sentence-level evidence pack and verifier (#707) ----

// Text in a source must not read as an ID or a marker: brackets become parentheses and any
// S-number becomes "S#n", which neither the selection parser nor the verifier reads as an ID.
const packText = (text) => String(text).replace(/\[/g, '(').replace(/\]/g, ')').replace(/\bS(\d+)\b/g, 'S#$1').replace(/\s+/g, ' ').trim();

// Sentences addressed to the model rather than stating facts. They never enter the evidence the
// selection and write steps see, so an injected instruction cannot be selected and cited.
const INSTRUCTION_PATTERNS = [
  /\b(ignore|disregard|forget|override)\b[^.!?]{0,40}\b(instructions?|prompts?|rules|guidelines|above|previous|prior)\b/i,
  /\b(system|developer|hidden)\s+(prompt|message|instructions?)\b/i,
  /(^|[\s.])(system|assistant|developer)\s*:/i,
  /\b(assistant|ai|chatbot|language model|llm|the model)\b\s*,?\s*(you\s+)?(must|should|need to|have to|are (now|required|instructed))\b/i,
  /\b(you are now|act as|pretend to be|from now on|new instructions)\b/i,
  /\b(add|insert|include|write|append|output|print|state|say|repeat)\b[^.!?]{0,60}\b(your|the|this)\s+(report|answer|response|reply|summary|output)\b/i,
  /\b(state|write|say|claim|report) that\b[^.!?]{0,80}\b(instead|regardless)\b/i,
  /\bcite (source|reference|note)\s*\[?\d+/i,
  /\breveal\b[^.!?]{0,40}\b(prompt|instructions?|secrets?)\b/i,
];
const looksLikeInstruction = (text) => INSTRUCTION_PATTERNS.some((re) => re.test(String(text)));

/** One line per sentence, `[S4] text`. Groups (one per source) are separated by `---` without
 * source numbers, so the model has nothing to cite but sentence IDs. */
function evidencePack(groups) {
  return groups.filter((g) => g.length).map((g) => g.map((x) => `[${x.id}] ${packText(x.text)}`).join('\n')).join('\n---\n');
}

// ---- Numbers ----
// "2,300", "2.300" and "2 300" are 2300; "6,4" is 6.4; "one" to "twenty" are numbers; a unit that
// follows a number is part of it ("40%" is not "40 mg"), with spelling variants folded together.
const NUMBER_WORDS = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');
/** @type {Array<[string, RegExp]>} */
const UNITS = [
  ['%', /^(%|percent\b|per cent\b)/i], ['‰', /^‰/],
  ['km', /^(km|kilomet(re|er)s?)\b/i], ['cm', /^(cm|centimet(re|er)s?)\b/i], ['mm', /^(mm|millimet(re|er)s?)\b/i], ['m', /^(m|met(re|er)s?)\b/i],
  ['mg', /^(mg|milligrams?)\b/i], ['kg', /^(kg|kilograms?|kilos?)\b/i], ['g', /^(g|grams?)\b/i], ['t', /^(t|tonnes?|tons?)\b/i],
  ['kwh', /^kwh\b/i], ['mwh', /^mwh\b/i], ['wh', /^wh\b/i], ['kw', /^kw\b/i], ['mw', /^mw\b/i], ['w', /^(w|watts?)\b/i],
  ['ml', /^(ml|millilit(re|er)s?)\b/i], ['l', /^(l|lit(re|er)s?)\b/i], ['ha', /^(ha|hectares?)\b/i],
  ['h', /^(h|hrs?|hours?)\b/i], ['min', /^(min|mins|minutes?)\b/i], ['s', /^(s|secs?|seconds?)\b/i], ['ms', /^(ms|milliseconds?)\b/i],
  ['°c', /^(°\s*c|degrees? c(elsius)?)\b/i], ['°f', /^(°\s*f|degrees? f(ahrenheit)?)\b/i],
  ['million', /^(million|m(io|n))\b/i], ['billion', /^(billion|bn)\b/i],
];
function numberValue(raw) {
  const t = raw.replace(/[\s  ]/g, '');
  const marks = t.match(/[.,]/g) || [];
  if (!marks.length) return String(Number(t));
  const last = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
  const tail = t.slice(last + 1);
  // Two kinds of mark: the last is the decimal one. One kind, repeated or followed by exactly three
  // digits after a 1–3 digit lead: thousands. Otherwise a decimal point or comma.
  const kinds = new Set(marks);
  const thousands = kinds.size === 1 && (marks.length > 1 || (tail.length === 3 && /^\d{1,3}[.,]/.test(t)));
  if (thousands) return String(Number(t.replace(/[.,]/g, '')));
  return String(Number(t.slice(0, last).replace(/[.,]/g, '') + '.' + tail));
}
function numbersIn(text) {
  const src = String(text).replace(new RegExp(`\\b(${NUMBER_WORDS.join('|')})\\b`, 'gi'), (w) => String(NUMBER_WORDS.indexOf(w.toLowerCase())));
  const out = [];
  const re = /(?<![\d.,])(\d{1,3}(?:(?:,|\.|[   ])\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?![\d])/g;
  for (const m of src.matchAll(re)) {
    const after = src.slice(m.index + m[0].length).replace(/^[\s  -]?/, '');
    const unit = UNITS.find(([, u]) => u.test(after));
    out.push({ value: numberValue(m[1]), unit: unit ? unit[0] : null });
  }
  return out;
}
// Every number in the claim appears in the evidence with the same value, and with the same unit
// when the claim gives one.
function numbersMatch(claim, texts) {
  const have = numbersIn(texts.join(' \n '));
  return numbersIn(claim).every((n) => have.some((h) => h.value === n.value && (!n.unit || h.unit === n.unit)));
}
const hasDigits = (text) => /\d/.test(String(text));
const stem = (w) => w.replace(/(?:ies|es|s|ed|ing)$/, '') || w;
const negationsOf = (text) => new Set(words(text).filter((w) => NEGATIONS.has(w)));

/** Does the claim follow from the cited sentences? No model call. Always required: every number
 * matches (value and unit), the negations agree (none added, none lost), and at least 60 % of the
 * claim's content words (lightly stemmed) appear in the sentences. The §5 quote or key-phrase
 * match is not enough on its own: a true clause cannot carry an unsupported one. A claim with
 * fewer than two content words passes only when every one of them appears. */
function supportsClaim(claim, sentenceTexts, { checkNumbers = true } = {}) {
  const texts = sentenceTexts.map(String);
  if (!texts.length) return false;
  if (checkNumbers && !numbersMatch(claim, texts)) return false;
  const neg = negationsOf(claim), hayNeg = negationsOf(texts.join(' '));
  if (neg.size !== hayNeg.size || [...neg].some((w) => !hayNeg.has(w))) return false;
  // Numbers, digits or words, were checked above; the rest are the content words.
  const claimWords = [...new Set(words(claim).filter((w) => !/^\d+$/.test(w) && !NUMBER_WORDS.includes(w)).map(stem))];
  const hay = new Set(words(texts.join(' ')).map(stem));
  const found = claimWords.filter((w) => hay.has(w)).length;
  if (claimWords.length < 2) return claimWords.length === found && (claimWords.length > 0 || numbersIn(claim).length > 0);
  return found / claimWords.length >= 0.6;
}

const SENTENCE_MARK = /\s*[[(]\s*(S\d+(?:\s*[,;]\s*S?\d+)*)\s*[\])]/g;
const SOURCE_MARK = /\s*\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*\]/g;
const ONLY_MARKS = /^(?:\s*(?:[[(]\s*S\d+(?:\s*[,;]\s*S?\d+)*\s*[\])]|\[\s*\d+(?:\s*[,;]\s*\d+)*\s*\]))+\s*[.!?]?\s*$/;
const LIST_LEAD = /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/;
const REASONS = {
  'wrong-sentence': 'the cited sentence does not state this',
  'whole-source': 'it cites a whole source instead of the sentence that states it',
  'unknown-id': 'it cites a sentence that was not in the evidence',
  uncited: 'no sentence is cited for this claim',
};

/**
 * Verifies a drafted section claim by claim. Each sentence of the draft is a claim; its markers
 * are `[S4]` (sentence IDs from the evidence pack, `[S4, S9]` and `[S4][S9]` allowed). A marker
 * is valid when its sentence was in this section's evidence and supports the claim. Supported
 * claims keep reader-facing source markers `[n]`; a claim whose markers all fail is dropped
 * (`mode: 'drop'`, the default) or kept with an "Unsupported" footnote (`mode: 'flag'`). A
 * whole-source marker `[2]` is a failed citation. Every uncited claim is counted (`uncited`), and
 * one that states a number is also flagged. `footnoteStart` continues footnote numbering across
 * sections. No model call. `validity` counts markers, as in §5.
 */
function verifyClaims(markdown, registry, allowedSentenceIds, { mode = 'drop', footnoteStart = 0 } = {}) {
  const allowed = new Set(allowedSentenceIds);
  let total = 0, valid = 0;
  const claims = { total: 0, supported: 0, flagged: 0, dropped: 0, uncited: 0 };
  const flagged = [], dropped = [], cited = [];
  const note = () => `[^u${footnoteStart + flagged.length}]`;
  const out = [];
  for (const rawLine of String(markdown).split('\n')) {
    // A list marker belongs to the whole line: strip it before splitting sentences, put it back on
    // the first kept sentence, and drop the item when none is kept.
    const lead = /^\s*#/.test(rawLine) ? '' : (rawLine.match(LIST_LEAD) || [''])[0];
    // A marker written after the full stop ("Fact. [S3]", "Fact.[S3] Next") moves in front of it.
    const line = rawLine.slice(lead.length).replace(/([.!?])[ \t]*((?:[[(]\s*S\d+(?:\s*[,;]\s*S?\d+)*\s*[\])])+)/g, ' $2$1');
    const segs = [];
    for (const seg of line.split(/(?<=[.!?])\s+(?=\S)/)) {
      if (segs.length && ONLY_MARKS.test(seg)) segs[segs.length - 1] += ' ' + seg.trim();
      else segs.push(seg);
    }
    const kept = [];
    let touched = false;
    for (const seg of segs) {
      const body = seg;
      const sentenceIds = [...body.matchAll(SENTENCE_MARK)].flatMap((m) => m[1].split(/[,;]/).map((x) => x.trim()).map((x) => (/^S/.test(x) ? x : `S${x}`)));
      const sourceMarks = [...body.matchAll(SOURCE_MARK)].flatMap((m) => m[1].split(/[,;]/));
      const text = body.replace(SENTENCE_MARK, '').replace(SOURCE_MARK, '').replace(/\s+([.!?,;:])/g, '$1').trim();
      if (/^#/.test(body.trim()) || /^\[\^/.test(body.trim()) || !text) { kept.push(seg); continue; }
      touched = true;
      if (!sentenceIds.length && !sourceMarks.length) {
        // Uncited prose is counted so leaving citations out cannot raise validity unseen; one that
        // states a number, the checkable kind of fact, is also footnoted.
        if (words(text).length >= 2 || hasDigits(text)) { claims.total++; claims.uncited++; }
        if (hasDigits(text)) {
          claims.flagged++; flagged.push({ text, reason: 'uncited' });
          kept.push(`${text}${note()}`);
        } else kept.push(seg.trim());
        continue;
      }
      claims.total++;
      total += sentenceIds.length + sourceMarks.length;
      const unique = [...new Set(sentenceIds)];
      const known = unique.map((id) => (allowed.has(id) ? registry.sentence(id) : null)).filter(Boolean);
      // Sentences that support the claim on their own words; numbers are checked on their union.
      const lexical = known.filter((x) => supportsClaim(text, [x.text], { checkNumbers: false }));
      const ok = lexical.length && supportsClaim(text, lexical.map((x) => x.text)) ? lexical : [];
      valid += sentenceIds.filter((id) => ok.some((x) => x.id === id)).length;
      if (ok.length) {
        claims.supported++;
        const sources = [...new Set(ok.map((x) => x.sourceId))];
        cited.push({ text, sentences: ok.map((x) => x.id), sources });
        kept.push(text.replace(/([.!?]["”')]?)?$/, (end) => ` ${sources.map((n) => `[${n}]`).join('')}${end || ''}`));
        continue;
      }
      const reason = !sentenceIds.length ? 'whole-source' : known.length ? 'wrong-sentence' : 'unknown-id';
      if (mode === 'flag') {
        claims.flagged++; flagged.push({ text, reason, cited: unique });
        kept.push(`${text}${note()}`);
      } else {
        claims.dropped++; dropped.push({ text, reason, cited: unique });
      }
    }
    // Lines emptied by dropped claims disappear, list marker and all; blank lines stay.
    if (!kept.length && (touched || lead)) continue;
    out.push(lead + kept.join(' '));
  }
  let markdownOut = out.join('\n');
  if (flagged.length) markdownOut += '\n\n' + flagged.map((f, i) => `[^u${footnoteStart + i + 1}]: Unsupported: ${REASONS[f.reason]}.`).join('\n');
  return { markdown: markdownOut, total, valid, validity: total ? valid / total : 1, claims, flagged, dropped, cited };
}

function sourcesFooter(registry) {
  return registry.list().map((s) => `${s.id}. ${s.title || s.url || s.file} — ${s.url || s.file} (retrieved ${new Date(s.retrievedAt).toISOString().slice(0, 10)})`).join('\n');
}

module.exports = { createRegistry, stripBoilerplate, chunk, lexicalScore, reduce, capExcerpts, sourcesFooter, normalise,
  splitSentences, evidencePack, supportsClaim, verifyClaims, numbersIn, looksLikeInstruction, VERIFY_REASONS: REASONS };
