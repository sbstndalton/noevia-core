'use strict';
// Deep research's model (D12; routes/research.cjs, research-service.cjs): which model a research step asks, and the
// one non-streaming chat completion it sends. Moved out of index.cjs for #1849; the local path is unchanged.
//
// #1849: with the Smart role on an Inference machine (#1840), research follows it: the step goes to the model that
// machine serves, under the same rules as an Automatic turn there (chat-machines.cjs): the on-this-network fetch
// (LAN/Tailscale only, link-local refused, no redirects), no local API key, the health and served-model check first
// with its "unreachable" / "wrong model" text, and nothing admitted, loaded or unloaded on this machine (no
// maintenance gate, no inference budget: the engine here is not used). Smart here: exactly as before.

/**
 * @param {object} o
 * @param {() => object|null} o.autoRoles
 * @param {() => string|null} o.lastLoadedModel
 * @param {object|null} [o.chatMachines]  chat-machines.cjs (null: everything local, as before)
 * @param {(id: string) => object} o.getProvider
 * @param {string} o.DEFAULT_PROVIDER_ID
 * @param {(p: object, extra?: object) => object} o.providerHeaders
 * @param {Function} o.fetch  the local engine's fetch
 * @param {object} o.modelManager
 * @param {(model: string, signal?: AbortSignal) => Promise<void>} o.admitEngineModel
 * @param {(r: Response, cap: number) => Promise<any>} o.readCappedJson
 */
function createResearchModel({ autoRoles, lastLoadedModel, chatMachines = null, getProvider, DEFAULT_PROVIDER_ID, providerHeaders, fetch, modelManager, admitEngineModel, readCappedJson }) {
  const publicError = (message) => Object.assign(Error(message), { publicMessage: message });
  const smartOnMachine = () => (chatMachines ? chatMachines.target('smart') : null);

  function model(project) {
    const remote = smartOnMachine();
    if (remote) return remote.model;
    return autoRoles()?.smart || project?.model || lastLoadedModel() || null;
  }

  function answerOf(choice) {
    if (choice?.finish_reason === 'length') throw publicError('A research step was cut off by the output limit.');
    return String(choice?.message?.content || '');
  }

  async function completeOnMachine(remote, messages, { signal, maxTokens }) {
    const ready = await chatMachines.ready(remote);
    if (!ready.ok) throw Object.assign(publicError(ready.error), { code: ready.code || 'machineUnreachable' });
    let r;
    try {
      r = await chatMachines.fetch(`${remote.baseUrl}/v1/chat/completions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        body: JSON.stringify({ model: remote.model, stream: false, max_tokens: maxTokens, messages }) });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw Object.assign(publicError(chatMachines.connectError(remote, err)), { code: 'machineUnreachable' });
    }
    if (!r.ok) throw publicError(`The model provider answered ${r.status}.`);
    return answerOf((await readCappedJson(r, 4 * 1024 * 1024)).choices?.[0]);
  }

  async function complete(project, messages, { signal, maxTokens }) {
    const remote = smartOnMachine();
    if (remote) return completeOnMachine(remote, messages, { signal, maxTokens });
    const provider = getProvider(DEFAULT_PROVIDER_ID), m = model(project);
    // Same maintenance gate as chat and RAG: tuning/calibration must not share the engine.
    let leave;
    try { leave = modelManager.enterInference?.() || (() => {}); }
    catch (e) { throw Object.assign(e, { publicMessage: e.publicMessage || (e.status === 503 ? e.message : 'The model is busy. Try again shortly.') }); }
    try {
      await admitEngineModel(m, signal);
      const r = await fetch(`${provider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`, { method: 'POST', redirect: 'error',
        headers: providerHeaders(provider, { 'Content-Type': 'application/json' }), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        body: JSON.stringify({ model: m, stream: false, max_tokens: maxTokens, messages }) });
      if (!r.ok) throw publicError(`The model provider answered ${r.status}.`);
      return answerOf((await readCappedJson(r, 4 * 1024 * 1024)).choices?.[0]);
    } finally { leave(); }
  }

  return { model, complete };
}

module.exports = { createResearchModel };
