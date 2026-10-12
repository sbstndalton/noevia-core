// Only documented model/endpoint pairs receive a provider parameter. Compatible
// wire shape or a successful generic probe does not prove reasoning support.
const crypto = require('node:crypto');
const { readCappedText, discardBody } = require('./http.cjs');
const thinkingBudget = require('./thinking-budget.cjs');
// Only the start of a provider's 4xx body is checked for the rejected parameter (#903).
const ERROR_BODY_CAP = 64 * 1024;
const EFFORTS = ['default', 'low', 'high'];
const rejected = new Set();
const rejectedBudget = new Set();
const HINTS = { low: 'Answer directly and concisely; skip step-by-step reasoning.', high: 'Think through this step by step before answering.' };
function validEffort(value) { return EFFORTS.includes(value); }
function resolveEffort(project, globalDefault) {
  return validEffort(project?.reasoningEffort) ? project.reasoningEffort : validEffort(globalDefault) ? globalDefault : 'default';
}
function capabilityKey(provider, model) {
  // Credential digest prevents one tenant's rejection from changing another's
  // behavior, without retaining plaintext credentials in capability keys.
  return [provider.baseUrl, provider.id, model, crypto.createHash('sha256').update(provider.apiKey || '').digest('hex')].join('|');
}
function documented(provider, model) {
  // Provider capabilities are data on the row (providers.cjs), never a host or model named here.
  const caps = provider?.capabilities;
  if (!caps || caps.reasoningEffortParam !== true) return false;
  return !Array.isArray(caps.reasoningEffortModels) || caps.reasoningEffortModels.includes(model);
}
function budgetFieldFor(provider) {
  return provider?.capabilities?.tokenBudgetField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
}
function nativeThinking(provider, model) {
  // Only the configured local llama.cpp/Lemonade endpoint and documented Qwen3 templates.
  try {
    const normalize = value => new URL(value).href.replace(/\/+$/, '');
    return ['lemonade','llamacpp'].includes(process.env.MODEL_MANAGER_KIND) &&
      normalize(provider.baseUrl) === normalize(process.env.INFERENCE_BASE_URL) &&
      /(?:^|[/_])qwen3(?:\.5)?[-_]/i.test(model);
  } catch { return false; }
}
function modeFor(provider, model, effort) {
  return effort === 'default' ? 'off' : (documented(provider, model) || nativeThinking(provider, model)) && !rejected.has(capabilityKey(provider, model)) ? 'real' : 'hint';
}
function requestBody(body, effort, mode, provider) {
  if (mode === 'off') return body;
  if (mode === 'real') return nativeThinking(provider, body.model)
    ? { ...body, chat_template_kwargs: { ...body.chat_template_kwargs, enable_thinking: effort === 'high' } }
    : { ...body, reasoning_effort: effort };
  const budgetField = budgetFieldFor(provider);
  return { ...body, messages: [{ role: 'system', content: HINTS[effort] }, ...body.messages],
    ...(effort === 'high' ? { [budgetField]: body[budgetField] || body.max_tokens || 8192 } : {}) };
}
// #1475/#1477: the request that asks for the answer after a thinking cut. Tools are dropped so the
// reply must be text; thinking is switched off where the template has a native switch (Qwen3 on the
// local engine), and otherwise the system note asks for the answer without further reasoning.
function forcedAnswerBody(request, provider, model) {
  const { tools, tool_choice, ...rest } = request;
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const body = { ...rest, stream: true, messages: [{ role: 'system', content: thinkingBudget.FORCED_ANSWER }, ...messages] };
  if (nativeThinking(provider, model)) body.chat_template_kwargs = { ...rest.chat_template_kwargs, enable_thinking: false };
  return body;
}
// thinkingCap (tokens, or null for no cap) is set by chat.cjs for the local engine only. Only a
// streamed reply can be cut; a non-streamed one is returned as the engine sent it.
async function requestWithEffort(fetcher, url, options, body, provider, model, effort, report, thinkingCap = null) {
  const explicitBudget=!!(body.max_tokens || body.max_completion_tokens);
  if(body.max_tokens && budgetFieldFor(provider)==='max_completion_tokens'){body={...body,max_completion_tokens:body.max_tokens};delete body.max_tokens;}
  let mode = modeFor(provider, model, effort);
  const key = capabilityKey(provider,model);
  const prepare = () => {
    const value=requestBody(body,effort,mode,provider);
    if (mode === 'hint' && !explicitBudget && rejectedBudget.has(key)) {delete value.max_tokens;delete value.max_completion_tokens;}
    return value;
  };
  let request=prepare();
  let response=await fetcher(url,{...options,body:JSON.stringify(request)});
  if (response.status >= 400 && response.status < 500) {
    const detail=(await readCappedText(response.clone(),ERROR_BODY_CAP)).text;
    if (mode === 'real' && /reasoning_effort|chat_template_kwargs|enable_thinking/i.test(detail)) {
      rejected.add(key);mode='hint';
      report({type:'warning',text:'This provider rejected reasoning effort. Using a best-effort hint instead.'});
      request=prepare();
      discardBody(response); // the rejected reply is replaced; close it
      response=await fetcher(url,{...options,body:JSON.stringify(request)});
    } else if (mode === 'hint' && !explicitBudget && effort === 'high' && /max_(?:completion_)?tokens/i.test(detail)) {
      rejectedBudget.add(key);
      report({type:'warning',text:'This provider rejected the output budget. The effort hint remains active with the provider’s default budget.'});
      request=prepare();
      discardBody(response); // the rejected reply is replaced; close it
      response=await fetcher(url,{...options,body:JSON.stringify(request)});
    }
  }
  let capped = response;
  if (thinkingCap !== null && request.stream === true && response.ok && response.body) {
    capped = thinkingBudget.capReasoning(response, {
      cap: thinkingCap,
      retry: () => fetcher(url, { ...options, body: JSON.stringify(forcedAnswerBody(request, provider, model)) }),
      onCut: () => report({ type: 'warning', text: 'Thinking reached its budget, so the answer was written without further reasoning.' }),
    });
  }
  report({type:'meta',reasoning:mode,reasoningEffort:effort,outputBudget:request.max_completion_tokens || request.max_tokens,...(thinkingCap !== null ? { thinkingCap } : {})});
  return capped;
}

module.exports = { nativeThinking, validEffort, resolveEffort, modeFor, requestBody, requestWithEffort, forcedAnswerBody };
