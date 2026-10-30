'use strict';
// sbstndalton/noevia#2218: what a deep research job on the Rust front still needs from this process, until the MCP
// wiring and rag.cjs move. Reached only by the front's own loopback calls (the same check as its other ones); anything
// else gets the 404 of an unknown path, because with file sharing on this listener is not bound to loopback alone.
//
//   POST /internal/research/availability {user}                      -> {reason: string|null, lastLoaded: string|null}
//   POST /internal/research/tool         {user, name, args}          -> {text} | {error}
//   POST /internal/research/retrieve     {user, projectId, question} -> {hits: [{file, text}]}
//
// Only the two search tools, only with the shapes research sends, and only from the operator's own server, with no
// fallback to a directory server (#865, #891). A call runs as that user, and the project is looked up as that user,
// so one account's job cannot read another's sources. A caller that goes away aborts the tool call.
const { callerGone } = require('./inference-admission-lease.cjs');
const { trustedFront } = require('./trusted-front.cjs');

const PREFIX = '/internal/research/';
const TEXT_CAP = 8192;

function validTool(name, args) {
  const text = (v, cap = TEXT_CAP) => typeof v === 'string' && v.length > 0 && v.length <= cap;
  if (!args || typeof args !== 'object') return null;
  if (name === 'tavily_search') return text(args.query) ? { query: args.query, max_results: 5 } : null;
  if (name === 'tavily_extract') return Array.isArray(args.urls) && args.urls.length === 1 && text(args.urls[0]) ? { urls: [args.urls[0]] } : null;
  return null;
}

function createResearchBridge({ secret, asUser, availability, executeOperatorToolCall, retrieve, json, readJson, log = (m) => console.warn(m) }) {
  return async function handle(req, res) {
    const target = String(req.url || '').split('?')[0];
    if (!target.startsWith(PREFIX)) return false;
    const notFound = () => { json(res, 404, { error: 'Not found' }); return true; };
    if (!trustedFront(req, secret) || req.method !== 'POST') return notFound();
    const op = target.slice(PREFIX.length);
    if (!['availability', 'tool', 'retrieve'].includes(op)) return notFound();
    const signal = callerGone(req, res);
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const user = body?.user;
    if (typeof user !== 'string' || !user) { json(res, 400, { error: 'A user is required.' }); return true; }
    try {
      if (op === 'availability') {
        json(res, 200, await asUser(user, availability));
      } else if (op === 'tool') {
        const args = validTool(body.name, body.args);
        if (!args) { json(res, 400, { error: 'Research asks only for its two search tools.' }); return true; }
        const text = await asUser(user, () => executeOperatorToolCall(body.name, args, signal));
        if (!signal.aborted) json(res, 200, { text: String(text ?? '') });
      } else {
        if (typeof body.projectId !== 'string' || typeof body.question !== 'string') { json(res, 400, { error: 'A project and a question are required.' }); return true; }
        const hits = await asUser(user, () => retrieve(body.projectId, body.question, user));
        if (!signal.aborted) json(res, 200, { hits });
      }
    } catch (e) {
      if (signal.aborted) { res.destroy?.(); return true; }
      log(`[research] ${op} failed: ${e?.code || e?.name || 'error'}`);
      json(res, 502, { error: e?.publicMessage || 'Research could not reach this tool.' });
    }
    return true;
  };
}

module.exports = { createResearchBridge, validTool, PREFIX };
