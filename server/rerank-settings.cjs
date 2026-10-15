'use strict';
// #1665: the reranker's runtime switch, saved in Settings (the settings store, like the decision service's,
// decision-settings.cjs) and applied over the deployment's environment. Admin-only, audited, and resettable to
// the deployment default (#1765 style). The environment stays the seed: with nothing saved, rerankTarget() reads
// exactly what it read before (NOEVIA_FEATURE_RAG_RERANK, RERANK_BACKEND, RERANK_BASE_URL, RERANK_MODEL).
//
// What can be chosen is limited to rerankers the deployment has an address for. The browser never sees one:
// a choice is an id ('tei', or 'llamacpp:<installed reranker preset>') and the server maps it to the address.
//   - 'tei': the text-embeddings-inference sidecar (the gte-multilingual reranker, #1665 core#121). Offered when
//     RERANK_BACKEND=tei (its RERANK_BASE_URL, default http://rerank:8080) or RERANK_TEI_BASE_URL is set.
//   - 'llamacpp:<name>': an installed reranker preset (labels 'reranking', file present) on a llama.cpp
//     `--reranking` server. Offered when RERANK_BACKEND is llamacpp with a RERANK_BASE_URL, or
//     RERANK_LLAMACPP_BASE_URL is set. rerankTarget() still refuses the shared engine (#697).
// Fail-open is unchanged: a reranker that errors or misses its deadline leaves retrieval on cosine ranking.

const { rerankBackendName, DEFAULT_TEI_URL } = require('./rerank-target.cjs');

const KEY = 'rerank:configuration';
const DEFAULT_TEI_MODEL = 'gte-multilingual-reranker-base';
const trim = (v) => (typeof v === 'string' ? v.trim() : '');
const isRerankModel = (m) => !!m && typeof m.name === 'string' && ((m.labels || []).some((l) => /^rerank/i.test(l)) || /rerank/i.test(m.name));
const fail = (message, messageId, status = 400) => Object.assign(Error(message), { status, messageId });

/** The addresses and model names the deployment provides for each backend. Server-side only. */
function endpoints(env) {
  const backend = rerankBackendName(env);
  const envUrl = trim(env.RERANK_BASE_URL);
  const tei = trim(env.RERANK_TEI_BASE_URL) || (backend === 'tei' ? envUrl || DEFAULT_TEI_URL : '');
  const llamacpp = trim(env.RERANK_LLAMACPP_BASE_URL) || (backend === 'llamacpp' ? envUrl : '');
  const teiModel = trim(env.RERANK_TEI_MODEL) || (backend === 'tei' ? trim(env.RERANK_MODEL) : '') || DEFAULT_TEI_MODEL;
  return { tei: tei || null, llamacpp: llamacpp || null, teiModel };
}

/** The host of a URL, lower-cased, or ''. */
const hostOf = (value) => { try { return new URL(String(value || '').trim()).hostname.toLowerCase(); } catch { return ''; } };

// #1638: `machine` is where Settings → Inference machines puts the reranker: () => { url, protocol } or null while it
// is on this machine. Assigned, the machine's address replaces the deployment's for that protocol (so the choices are
// what that machine can serve), and RERANK_API_KEY, which belongs to the deployment's reranker, is only sent when the
// machine is the same host as RERANK_BASE_URL (the #1753 rule of decision-settings.cjs).
function createRerankSettings({ store, env = process.env, audit = () => {}, onChange = () => {}, machine = () => null }) {
  const onMachine = () => { try { const m = machine(); return m && typeof m.url === 'string' && m.url ? { url: m.url, protocol: m.protocol === 'llamacpp' ? 'llamacpp' : 'tei' } : null; } catch { return null; } };
  /** The deployment's endpoints, with an assigned machine's address over them. */
  function endpointsNow() {
    const ep = endpoints(env);
    const m = onMachine();
    if (!m) return ep;
    return { ...ep, tei: m.protocol === 'tei' ? m.url : null, llamacpp: m.protocol === 'llamacpp' ? m.url : null };
  }
  let saved;
  try { saved = JSON.parse(store.get(KEY) || 'null'); } catch { saved = null; }
  if (saved && (typeof saved.enabled !== 'boolean' || (saved.choice !== null && typeof saved.choice !== 'string'))) saved = null;

  /** Choosable rerankers ({ id, backend, model }); `installed` null = the catalogue could not be read. */
  function options(installed) {
    const ep = endpointsNow();
    const out = [];
    if (ep.tei) out.push({ id: 'tei', backend: 'tei', model: ep.teiModel });
    if (ep.llamacpp && Array.isArray(installed)) {
      for (const m of installed) if (isRerankModel(m) && !m.missingFile) out.push({ id: `llamacpp:${m.name}`, backend: 'llamacpp', model: m.name });
    }
    return out;
  }
  /** The choice id the deployment's own environment amounts to, or null. */
  function deploymentChoice() {
    const m = onMachine();
    const backend = m ? m.protocol : rerankBackendName(env);
    if (backend === 'tei') return 'tei';
    const model = trim(env.RERANK_MODEL);
    return backend === 'llamacpp' && model ? `llamacpp:${model}` : null;
  }
  /** The environment rerankTarget() and the reranker backend read: the deployment's, with a saved choice over it. */
  function effectiveEnv() {
    const m = onMachine();
    if (!saved && !m) return env;
    const ep = endpointsNow();
    const out = { ...env };
    if (m) {
      // Nothing saved: the deployment's switch and model, at the machine's address.
      Object.assign(out, { RERANK_BACKEND: m.protocol, RERANK_BASE_URL: m.url, ...(m.protocol === 'tei' ? { RERANK_MODEL: ep.teiModel } : {}) });
      if (hostOf(m.url) !== hostOf(env.RERANK_BASE_URL)) out.RERANK_API_KEY = '';
    }
    if (!saved) return out;
    out.NOEVIA_FEATURE_RAG_RERANK = saved.enabled ? 'true' : 'false';
    const choice = saved.choice;
    if (choice === 'tei' && ep.tei) Object.assign(out, { RERANK_BACKEND: 'tei', RERANK_BASE_URL: ep.tei, RERANK_MODEL: ep.teiModel });
    else if (choice && choice.startsWith('llamacpp:') && ep.llamacpp) Object.assign(out, { RERANK_BACKEND: 'llamacpp', RERANK_BASE_URL: ep.llamacpp, RERANK_MODEL: choice.slice('llamacpp:'.length) });
    else if (choice) out.NOEVIA_FEATURE_RAG_RERANK = 'false'; // its address is gone from the deployment: off, never a guess
    return out;
  }
  /** What the admin sees: on/off, the chosen id, where it comes from, the options. Never an address. */
  function get(installed) {
    const e = effectiveEnv();
    const enabled = /^(1|true|on)$/i.test(trim(e.NOEVIA_FEATURE_RAG_RERANK));
    return { enabled, choice: saved ? saved.choice : deploymentChoice(), source: saved ? 'admin' : 'deployment', options: options(installed) };
  }
  function save(value, actor, installed) {
    if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' || (value.choice !== undefined && value.choice !== null && typeof value.choice !== 'string'))
      throw fail('Send whether reranking is on and which reranker to use.', 'invalidInput');
    const current = get(installed);
    const choice = value.choice === undefined ? current.choice : value.choice === null ? null : value.choice.trim();
    const known = options(installed);
    // #1817: turning off while keeping the saved choice (even one no longer offered) must always succeed.
    const keepsSaved = value.enabled === false && choice === current.choice;
    if (choice && !keepsSaved && !known.some((o) => o.id === choice)) {
      // A llama.cpp preset cannot be checked while the catalogue is unreadable; say so instead of "unknown".
      if (choice.startsWith('llamacpp:') && !Array.isArray(installed)) throw fail('The installed models could not be read. Try again in a moment.', 'catalogueUnavailable', 503);
      throw fail('That reranker is not available on this server.', 'unknownReranker');
    }
    if (value.enabled && !choice) throw fail('Choose a reranker before turning reranking on.', 'noReranker');
    const next = { enabled: value.enabled, choice: choice || null };
    store.set(KEY, JSON.stringify(next));
    saved = next;
    const picked = known.find((o) => o.id === next.choice);
    audit('rerank.configure', actor, { enabled: next.enabled, backend: picked ? picked.backend : null, model: picked ? picked.model : null });
    onChange();
    return get(installed);
  }
  /** Forgets the saved switch, so the deployment's environment applies again. Audited even when nothing was saved. */
  function reset(actor, installed) {
    const had = !!saved;
    if (typeof store.delete === 'function') store.delete(KEY); else store.set(KEY, 'null');
    saved = null;
    audit('rerank.reset', actor, { hadSaved: had });
    onChange();
    return get(installed);
  }
  return { get, save, reset, options, effectiveEnv, source: () => (saved ? 'admin' : 'deployment') };
}

// The process's reranker settings, for modules that are not handed them (llamacpp-manager.cjs keepAlongside: a
// reranker on another machine is not resident on this engine, #1638). Set once by index.cjs.
let installed = null;
function install(settings) { installed = settings; return settings; }
function current() { return installed; }

module.exports = { createRerankSettings, endpoints, DEFAULT_TEI_MODEL, KEY, install, current };
