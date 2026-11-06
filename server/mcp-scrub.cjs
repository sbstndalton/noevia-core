'use strict';
// The credential values an MCP request carried, taken out of any text a server sends back before that text goes anywhere
// else (a log line, the discovery state, the catalogue published to the Rust front and shown in the admin directory, the
// toolbox picker). A server can echo what it was sent -- in an HTTP body, a JSON-RPC message or code, a tool's name or
// description -- and clipping or hiding the field it came in is not redaction. This is the Node half of the front's
// bins/noevia-server mcp_scrub.rs (sbstndalton/noevia#2218) and keeps its rules:
//
// What counts as a credential value, at every length (a one-byte key is as much a credential as a long one): every
// header value, the part after an auth scheme (`Bearer x` gives `x`), and for `Basic` the decoded `user:secret` and its
// two halves; each also in its JSON-escaped and percent-encoded spelling when that differs. The account id a Nextcloud
// server is told (X-Cowork-User-ID) is an identifier, not a credential.
//
// How it is looked for: a value of SUBSTRING_MIN bytes or more anywhere in the text; a shorter one only as a whole token
// (not touching a letter, digit or underscore on either side), so that a 2-byte key does not blank the words that happen
// to contain it. Scrub FIRST, clip afterwards.
const SUBSTRING_MIN = 8;
const REDACTED = '[redacted]';
const WORD = /[\p{L}\p{N}_]/u;

const percentEncoded = (v) => [...Buffer.from(v, 'utf8')].map((b) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');

function createSecrets(headers = null) {
  const forms = [];
  const add = (v) => {
    if (typeof v !== 'string' || !v.trim()) return;
    for (const form of [v, JSON.stringify(v).slice(1, -1), percentEncoded(v)]) if (!forms.includes(form)) forms.push(form);
  };
  const addValue = (value) => {
    if (typeof value !== 'string') return;
    add(value);
    const at = value.indexOf(' ');
    if (at < 0) return;
    const scheme = value.slice(0, at);
    const rest = value.slice(at + 1).trim();
    add(rest);
    if (scheme.toLowerCase() === 'basic' && /^[A-Za-z0-9+/]*={0,2}$/.test(rest)) {
      const raw = Buffer.from(rest, 'base64').toString('utf8');
      add(raw);
      const colon = raw.indexOf(':');
      if (colon >= 0) { add(raw.slice(0, colon)); add(raw.slice(colon + 1)); }
    }
  };
  const addHeaders = (h) => {
    for (const [name, value] of Object.entries(h || {})) if (String(name).toLowerCase() !== 'x-cowork-user-id') addValue(value);
  };
  addHeaders(headers);
  const bounded = (text, start, end) => {
    const before = start > 0 ? [...text.slice(Math.max(0, start - 2), start)].pop() : '';
    const after = end < text.length ? [...text.slice(end, end + 2)][0] : '';
    return !(before && WORD.test(before)) && !(after && WORD.test(after));
  };
  return {
    addHeaders, addValue,
    isEmpty: () => forms.length === 0,
    /** `text` with every credential value replaced by [redacted]. Anything that is not text is made text first. */
    scrub(input) {
      const text = typeof input === 'string' ? input : String(input);
      const spans = [];
      for (const v of forms) {
        const wholeToken = Buffer.byteLength(v, 'utf8') < SUBSTRING_MIN;
        let from = 0;
        for (;;) {
          const i = text.indexOf(v, from);
          if (i < 0) break;
          const end = i + v.length;
          if (!wholeToken || bounded(text, i, end)) spans.push([i, end]);
          from = i + 1;
        }
      }
      if (!spans.length) return text;
      spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const merged = [];
      for (const [start, end] of spans) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
      }
      let out = '';
      let at = 0;
      for (const [start, end] of merged) { out += text.slice(at, start) + REDACTED; at = end; }
      return out + text.slice(at);
    },
    /** Scrub, then keep the first `n` UTF-16 units. */
    scrubClip(input, n) { return this.scrub(input).slice(0, n); },
  };
}

/** A failure of an upstream exchange with the credentials taken out of its message; its HTTP status (a number the caller may show) and a plain upper-case error code are kept. */
function scrubbedError(err, secrets) {
  const out = new Error(secrets.scrub(String((err && err.message) || err)));
  if (err && Number.isInteger(err.httpStatus)) out.httpStatus = err.httpStatus;
  if (err && typeof err.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code)) out.code = err.code;
  return out;
}

module.exports = { createSecrets, scrubbedError, SUBSTRING_MIN, REDACTED };
