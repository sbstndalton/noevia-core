'use strict';
// Deep research foundations (docs/spec-deep-research.md §5–6): a per-job source registry,
// deterministic page reduction and a citation verifier. No model call happens here.
const crypto = require('node:crypto');
const { tokens } = require('./chat-context.cjs');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const normalise = (text) => String(text).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set('a an and are as at be but by for from has have in is it its of on or that the this to was were which with not no into than then there their they also can may will'.split(' '));
const words = (text) => normalise(text).split(' ').filter((w) => w.length > 2 && !STOP.has(w));

function createRegistry() {
  const sources = [];
  function register({ kind, url = null, file = null, title = '', retrievedAt = Date.now(), excerpts = [] }) {
    if (kind !== 'web' && kind !== 'project') throw Error('Source kind must be web or project');
    if (kind === 'web' && !/^https?:\/\//i.test(String(url || ''))) throw Error('A web source needs an http(s) URL');
    if (kind === 'project' && !file) throw Error('A project source needs a file');
    // The same page or file registers once; later excerpts join it.
    const existing = sources.find((s) => s.kind === kind && s.url === url && s.file === file);
    const target = existing || { id: sources.length + 1, kind, url, file, title: String(title).slice(0, 300), retrievedAt, excerpts: [] };
    for (const text of excerpts) {
      const hash = sha256(text);
      if (!target.excerpts.some((e) => e.sha256 === hash)) target.excerpts.push({ sha256: hash, text });
    }
    if (!existing) sources.push(target);
    return target.id;
  }
  return { register, get: (id) => sources.find((s) => s.id === id) || null, list: () => sources.map((s) => ({ ...s, excerpts: [...s.excerpts] })) };
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

// §5: every [n] must name a source used by this section, and its sentence must share a quoted
// span or a key phrase (three consecutive content words) with one of that source's excerpts.
function supports(sentence, excerpts) {
  const hay = excerpts.map((e) => normalise(e.text ?? e));
  for (const [, quote] of sentence.matchAll(/["“]([^"”]{8,})["”]/g)) if (hay.some((h) => h.includes(normalise(quote)))) return true;
  const w = words(sentence.replace(/\[\d+\]/g, ''));
  const hayWords = hay.map((h) => ` ${h.split(' ').filter((x) => x.length > 2 && !STOP.has(x)).join(' ')} `);
  for (let i = 0; i + 3 <= w.length; i++) {
    const phrase = ` ${w.slice(i, i + 3).join(' ')} `;
    if (hayWords.some((h) => h.includes(phrase))) return true;
  }
  return false;
}

function verifyCitations(markdown, registry, usedIds) {
  const allowed = new Set(usedIds);
  const unsupported = [];
  let valid = 0, total = 0;
  const sentences = String(markdown).split(/(?<=[.!?])\s+(?=\S)|\n/);
  const text = sentences.map((sentence) => {
    if (!/\[\d+\]/.test(sentence)) return sentence;
    let flagged = false;
    const cleaned = sentence.replace(/\s?\[(\d+)\]/g, (marker, n) => {
      total++;
      const id = Number(n), source = allowed.has(id) ? registry.get(id) : null;
      if (source && supports(sentence, source.excerpts)) { valid++; return marker; }
      flagged = true; return '';
    });
    if (!flagged) return cleaned;
    unsupported.push(cleaned.trim());
    return `${cleaned}[^u${unsupported.length}]`;
  });
  // Rejoin with the separators the split consumed: newlines stay newlines, sentences get a space.
  let out = '', cursor = 0;
  const src = String(markdown);
  for (const [i, s] of sentences.entries()) {
    const at = src.indexOf(sentences[i], cursor);
    out += (i ? src.slice(cursor, at) : '') + text[i];
    cursor = at + s.length;
  }
  if (unsupported.length) out += '\n\n' + unsupported.map((s, i) => `[^u${i + 1}]: Unsupported: no cited source contains this claim.`).join('\n');
  return { markdown: out, total, valid, validity: total ? valid / total : 1, unsupported };
}

function sourcesFooter(registry) {
  return registry.list().map((s) => `${s.id}. ${s.title || s.url || s.file} — ${s.url || s.file} (retrieved ${new Date(s.retrievedAt).toISOString().slice(0, 10)})`).join('\n');
}

module.exports = { createRegistry, stripBoilerplate, chunk, lexicalScore, reduce, capExcerpts, verifyCitations, sourcesFooter, normalise };
