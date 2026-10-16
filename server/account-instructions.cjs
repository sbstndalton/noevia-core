'use strict';
// Settings → Assistant → Custom instructions and response style: one standing instruction for
// every chat of this user (not the Diary, which has its own prompt). Stored per user beside
// projects.json. The Rust front writes it (PUT /api/account/instructions, sbstndalton/noevia#1071);
// chat.cjs reads it here.
//
// The style is a quick-start preset (default/concise/detailed) plus four optional advanced
// controls (#229) and a default response language (#231). Every advanced control starts at
// 'auto', which adds nothing to the prompt, so records saved before these existed read back
// exactly as they did.
const fs = require('node:fs');
const path = require('node:path');

const MAX_CHARS = 4000;
const MAX_LANGUAGE_CHARS = 40;
const FILE = 'account-instructions.json';
const STYLES = {
  default: null,
  concise: 'Keep replies short and direct: lead with the answer, skip preamble, and expand only when asked.',
  detailed: 'Be thorough: explain reasoning, cover edge cases and give examples where they help.',
};
// Each control: 'auto' (the model decides, nothing sent) and two opinions with their phrasing.
const ADVANCED = {
  length: { short: 'Prefer brief answers, a few sentences where possible.', long: 'Prefer complete, longer answers.' },
  tone: { casual: 'Use a relaxed, conversational tone.', formal: 'Use a formal, professional tone.' },
  formatting: { minimal: 'Write in plain paragraphs; avoid headings and bullet lists unless asked.', structured: 'Organise longer answers with headings and bullet lists.' },
  emoji: { none: 'Do not use emoji.', some: 'An occasional emoji is fine where it fits.' },
};
const ADVANCED_DEFAULT = Object.freeze({ length: 'auto', tone: 'auto', formatting: 'auto', emoji: 'auto' });

function cleanAdvanced(value) {
  const out = { ...ADVANCED_DEFAULT };
  if (!value || typeof value !== 'object') return out;
  for (const key of Object.keys(ADVANCED)) if (Object.hasOwn(ADVANCED[key], value[key])) out[key] = value[key];
  return out;
}

// A language name, not a prompt: letters (any script), spaces and a few separators, at most four words.
function cleanLanguage(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length <= MAX_LANGUAGE_CHARS && trimmed.split(' ').length <= 4 && /^[\p{L}][\p{L}\p{M} ()'-]*$/u.test(trimmed) ? trimmed : '';
}

function empty() { return { text: '', style: 'default', advanced: { ...ADVANCED_DEFAULT }, language: '', updatedAt: null }; }

function read(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return {
      text: typeof data.text === 'string' ? data.text.slice(0, MAX_CHARS) : '',
      style: Object.hasOwn(STYLES, data.style) ? data.style : 'default',
      advanced: cleanAdvanced(data.advanced),
      language: cleanLanguage(data.language),
      updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : null,
    };
  } catch { return empty(); }
}

/** The lines the model sees, in order: preset, advanced controls, language, then free text.
 *  Pure, so Settings can preview exactly what is sent. */
function styleLines(settings) {
  const s = settings || {};
  const advanced = cleanAdvanced(s.advanced);
  const language = cleanLanguage(s.language);
  return [
    STYLES[Object.hasOwn(STYLES, s.style) ? s.style : 'default'],
    ...Object.keys(ADVANCED).map((key) => ADVANCED[key][advanced[key]]),
    language ? `Reply in ${language} unless the user writes in or asks for another language.` : null,
  ].filter(Boolean);
}

/** Accepts the old (text, style) form or the whole read() record. */
function systemPart(textOrSettings, style = 'default') {
  const settings = typeof textOrSettings === 'object' && textOrSettings ? textOrSettings : { text: textOrSettings, style };
  const lines = [...styleLines(settings), typeof settings.text === 'string' ? settings.text : ''].filter(Boolean);
  if (!lines.length) return null;
  return `The user's custom instructions for all chats (project instructions, and any format or language the user asks for in a message, take precedence where they conflict):\n${lines.join('\n')}`;
}

module.exports = { read, systemPart, styleLines, MAX_CHARS, MAX_LANGUAGE_CHARS, STYLES: Object.keys(STYLES), ADVANCED: Object.fromEntries(Object.entries(ADVANCED).map(([k, v]) => [k, ['auto', ...Object.keys(v)]])) };
