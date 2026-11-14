'use strict';
const { frameUntrusted } = require('./prompt-framing.cjs');
// D9: offline Wikipedia (or any ZIM) through an internal kiwix-serve, as a read-only built-in
// toolbox. Off unless features.kiwix is on and KIWIX_URL names the internal service.
// Content is untrusted data: results are plain text, bounded, and labelled as reference.
const { stripBoilerplate } = require('./strip-boilerplate.cjs');
const { readCappedText } = require('./http.cjs');

const ID = 'offline-wikipedia';
const decode = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]).trim() : ''; };

/** Track R5: what the model is told when the Rust front could not run an Offline Wikipedia tool (both only read). */
const NATIVE_UNAVAILABLE = 'ERROR: offline Wikipedia is unavailable right now. Try again in a moment.';
/** How long a 404 (a front that runs no Offline Wikipedia tools) keeps this process running them itself. */
const NATIVE_RECHECK_MS = 60 * 1000;

/**
 * @param {{ enabled(): boolean, tool(payload): Promise<{ status, body }> }} [native] track R5: the Rust front's
 *   Offline Wikipedia tools (`POST /v1/kiwix/tool`, noevia-rs kiwix_tools.rs). While `enabled()`
 *   (NOEVIA_RUST_KIWIX_TOOLS=1) a call is the front's; a 404 (a front that runs none) leaves it to this process.
 */
function createKiwixTools({ baseUrl, fetchImpl = fetch, cap = 8000, timeoutMs = 10000, native = null, now = Date.now, warn = console.warn }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search) throw Error('KIWIX_URL must be a plain http(s) origin');
  const origin = base.origin + base.pathname.replace(/\/+$/, '');
  const get = async (pathAndQuery) => {
    const r = await fetchImpl(origin + pathAndQuery, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw Error(`offline Wikipedia answered ${r.status}`);
    const { text } = await readCappedText(r, 2_000_000);
    return text;
  };
  const schemas = [
    { type: 'function', function: { name: 'wikipedia_search', description: 'Search the offline Wikipedia. Returns titles with a path for wikipedia_read.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'wikipedia_read', description: 'Read one offline Wikipedia article by the path wikipedia_search returned. Use offset to continue.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['path'] } } },
  ];
  async function execute(name, args) {
    if (name === 'wikipedia_search') {
      const query = String(args.query || '').trim().slice(0, 200);
      if (!query) return 'ERROR: a query is required';
      const xml = await get(`/search?pattern=${encodeURIComponent(query)}&format=xml&pageLength=6`);
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({ title: tag(m[1], 'title'), link: tag(m[1], 'link'), snippet: stripBoilerplate(tag(m[1], 'description')).replace(/\s+/g, ' ').slice(0, 240) }))
        .filter((i) => i.title && /^\/content\//.test(i.link.replace(/^https?:\/\/[^/]+/, '')));
      if (!items.length) return `Offline Wikipedia has nothing for "${query}".`;
      return items.map((i, n) => `${n + 1}. ${i.title}\n   path: ${i.link.replace(/^https?:\/\/[^/]+/, '')}\n   ${i.snippet}`).join('\n').slice(0, cap);
    }
    if (name === 'wikipedia_read') {
      const raw = String(args.path || '').trim();
      // Only article paths on this server; no scheme, host, traversal or query to aim elsewhere.
      if (!/^\/content\/[^?#\s]+$/.test(raw) || raw.split('/').some((s) => s === '..' || s === '.') || raw.includes('//') || raw.length > 400) return 'ERROR: use a path returned by wikipedia_search';
      const offset = Math.max(0, Number.parseInt(args.offset ?? 0, 10) || 0);
      const text = stripBoilerplate(await get(raw.split('/').map((s, i) => (i < 2 ? s : encodeURIComponent(decodeURIComponentSafe(s)))).join('/')));
      const slice = text.slice(offset, offset + cap);
      const more = offset + cap < text.length ? `\n…[continues; call again with offset ${offset + cap}]` : '';
      return frameUntrusted('Offline Wikipedia article', '', `${slice}${more}`);
    }
    return undefined;
  }
  let nativeOffUntil = 0;
  const nativeOn = () => !!native && now() >= nativeOffUntil && native.enabled();
  const NOT_NATIVE = Symbol('not native');
  /** The front's answer: its text, undefined for a name that is not one of its tools, or NOT_NATIVE after a 404. */
  async function viaFront(name, args) {
    let answer;
    try { answer = await native.tool({ name, arguments: args, cap }); } catch { return NATIVE_UNAVAILABLE; }
    if (answer && answer.status === 404) {
      warn('[kiwix] NOEVIA_RUST_KIWIX_TOOLS is on here, but the front runs no Offline Wikipedia tools: this process runs them for a minute');
      nativeOffUntil = now() + NATIVE_RECHECK_MS;
      return NOT_NATIVE;
    }
    if (!answer || answer.status !== 200 || !answer.body || typeof answer.body !== 'object') return NATIVE_UNAVAILABLE;
    const { text } = answer.body;
    return typeof text === 'string' ? text : text === null ? undefined : NATIVE_UNAVAILABLE;
  }
  return {
    box: { id: ID, label: 'Offline Wikipedia', description: 'Search and read the offline Wikipedia copy on this server. Read-only.', source: 'builtin', tools: schemas, reads: schemas.map((s) => s.function.name) },
    names: new Set(schemas.map((s) => s.function.name)),
    execute: async (name, args) => {
      if (nativeOn()) { const r = await viaFront(name, args); if (r !== NOT_NATIVE) return r; }
      try { return await execute(name, args); } catch (e) { return `ERROR: ${String(e.message || e).slice(0, 200)}`; }
    },
  };
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

module.exports = { createKiwixTools, ID, NATIVE_UNAVAILABLE, NATIVE_RECHECK_MS };
