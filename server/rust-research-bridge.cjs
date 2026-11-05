'use strict';
// sbstndalton/noevia#2218: what a deep research job on the Rust front still needs from this process. The search tools are
// the front's own (noevia-rs mcp_exec.rs executes them, research_routes.rs asks for availability from the published
// catalogue); what is left is what only this process holds in memory. Reached only by the front's own loopback calls (the
// same check as its other ones); anything else gets the 404 of an unknown path, because with file sharing on this listener
// is not bound to loopback alone.
//
//   POST /internal/research/facts    {user}                      -> {lastLoaded: string|null}
//   POST /internal/research/retrieve {user, projectId, question} -> {hits: [{file, text}]}
//
// `retrieve` stays until the RAG index runtime moves (rag.cjs: the per-file version filter, the active embedding slot and the
// reranker are this process's state). A call runs as that user, and the project is looked up as that user, so one account's
// job cannot read another's sources. A caller that goes away aborts the retrieval.
const { callerGone } = require('./inference-admission-lease.cjs');
const { trustedFront } = require('./trusted-front.cjs');

const PREFIX = '/internal/research/';

function createResearchBridge({ secret, asUser, facts, retrieve, json, readJson, log = (m) => console.warn(m) }) {
  return async function handle(req, res) {
    const target = String(req.url || '').split('?')[0];
    if (!target.startsWith(PREFIX)) return false;
    const notFound = () => { json(res, 404, { error: 'Not found' }); return true; };
    if (!trustedFront(req, secret) || req.method !== 'POST') return notFound();
    const op = target.slice(PREFIX.length);
    if (!['facts', 'retrieve'].includes(op)) return notFound();
    const signal = callerGone(req, res);
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { error: 'invalid JSON' }); return true; }
    const user = body?.user;
    if (typeof user !== 'string' || !user) { json(res, 400, { error: 'A user is required.' }); return true; }
    try {
      if (op === 'facts') {
        json(res, 200, await asUser(user, facts));
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

module.exports = { createResearchBridge, PREFIX };
