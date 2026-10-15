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
// #1787: the high hint used to say "Think through this step by step before answering." A model that already thinks in
// reasoning_content (gemma on the local engine) then also wrote its working into the reply: a "Reasoning:" heading,
// "Wait, let me re-calculate" and a first line its own working contradicted. High asks for care, and the reply is the
// answer only; real thinking stays in the thinking panel.
const HINTS = Object.freeze({ low: 'Answer directly and concisely; skip step-by-step reasoning.',
  high: 'Work this out carefully and check it before you reply. Then give the final answer only: do not show your working, a "Reasoning:" section, or corrections such as "Wait, let me re-calculate".' });
function validEffort(value) { return EFFORTS.includes(value); }
function resolveEffort(project, globalDefault) {
  return validEffort(project?.reasoningEffort) ? project.reasoningEffort : validEffort(globalDefault) ? globalDefault : 'default';
}
// #1788 (after #1475): the decision service routes a turn Fast when it judges it simple ("Say hello"). The account's
// default effort used to apply anyway, so a greeting got the High hint and its thinking cap and thought for ~19 s.
// An Automatic turn routed Fast runs at Low (its hint and its cap); Smart, Code and non-Automatic turns keep theirs.
// It only ever lowers.
function effortForRoute(effort, routedRole) {
  return routedRole === 'fast' && effort !== 'low' ? 'low' : effort;
}
// #1788 reopen: an Automatic turn routed Fast whose effort is the account default (no explicit project effort) runs
// with thinking off, not only at Low: Low's hint and cap still left ~28 s of thinking on a greeting.
function fastRouteThinkingOff({ auto, routedRole, projectEffort }) {
  return auto === true && routedRole === 'fast' && !validEffort(projectEffort);
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
// The configured local llama.cpp/Lemonade endpoint, whatever model it serves.
function localEngine(provider) {
  try {
    const normalize = value => new URL(value).href.replace(/\/+$/, '');
    return ['lemonade','llamacpp'].includes(process.env.MODEL_MANAGER_KIND) &&
      normalize(provider.baseUrl) === normalize(process.env.INFERENCE_BASE_URL);
  } catch { return false; }
}
// #1854: a model on an Inference machine whose own /props template reads `enable_thinking` (measured per machine +
// model, chat-machines.cjs). Never this machine's engine, and never a model or file name.
function machineThinkingSwitch(provider) {
  return provider?.machine?.thinkingSwitch === true;
}
function nativeThinking(provider, model) {
  // Only the configured local llama.cpp/Lemonade endpoint and documented Qwen3 templates, or a machine that has the switch.
  return (localEngine(provider) && /(?:^|[/_])qwen3(?:\.5)?[-_]/i.test(model)) || machineThinkingSwitch(provider);
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
  // The note goes last, so the engine keeps the prompt it already cached and does not re-prefill from the
  // start while the reply's idle clock runs (#1585). Joined to a trailing user turn when there is one, so a
  // strict template still sees alternating roles.
  const last = messages[messages.length - 1];
  const withNote = last?.role === 'user' && typeof last.content === 'string'
    ? [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${thinkingBudget.FORCED_ANSWER}` }]
    : [...messages, { role: 'user', content: thinkingBudget.FORCED_ANSWER }];
  const body = { ...rest, stream: true, messages: withNote };
  // Thinking is switched off on the local engine whatever the model: a template without the switch ignores
  // it (the other local callers send it the same way), and no model or file name decides here (#1585).
  if (localEngine(provider) || machineThinkingSwitch(provider)) body.chat_template_kwargs = { ...rest.chat_template_kwargs, enable_thinking: false };
  return body;
}
// thinkingCap (tokens, or null for no cap) is set by chat.cjs for the local engine only. Only a
// streamed reply can be cut; a non-streamed one is returned as the engine sent it.
async function requestWithEffort(fetcher, url, options, body, provider, model, effort, report, thinkingCap = null) {
  const explicitBudget=!!(body.max_tokens || body.max_completion_tokens);
  if(body.max_tokens && budgetFieldFor(provider)==='max_completion_tokens'){body={...body,max_completion_tokens:body.max_tokens};delete body.max_tokens;}
  let mode = modeFor(provider, model, effort);
  const key = capabilityKey(provider,model);
  // #1585: a cap of 0 means the output budget leaves no room to think (a context of about 4,100 tokens or
  // less). A reply with no tools is asked for its answer directly, in one request, instead of being cut at its
  // first reasoning token and sent again. One with tools stays uncapped: the forced answer would drop them.
  const noRoomToThink = thinkingCap === 0 && body.stream === true;
  const answerDirectly = noRoomToThink && !(Array.isArray(body.tools) && body.tools.length);
  if (noRoomToThink) thinkingCap = answerDirectly ? 0 : null;
  const prepare = () => {
    let value=requestBody(body,effort,mode,provider);
    if (mode === 'hint' && !explicitBudget && rejectedBudget.has(key)) {delete value.max_tokens;delete value.max_completion_tokens;}
    if (answerDirectly) value=forcedAnswerBody(value,provider,model);
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
  if (thinkingCap !== null && !answerDirectly && request.stream === true && response.ok && response.body) {
    capped = thinkingBudget.capReasoning(response, {
      cap: thinkingCap,
      retry: () => fetcher(url, { ...options, body: JSON.stringify(forcedAnswerBody(request, provider, model)) }),
      onCut: (reason) => report({ type: 'warning', text: reason === 'no-answer'
        ? 'The model stopped after thinking without an answer, so the answer was requested again.'
        : 'Thinking reached its budget, so the answer was written without further reasoning.' }),
    });
  }
  report({type:'meta',reasoning:mode,reasoningEffort:effort,outputBudget:request.max_completion_tokens || request.max_tokens,...(thinkingCap !== null ? { thinkingCap } : {})});
  return capped;
}

module.exports = { HINTS, localEngine, machineThinkingSwitch, nativeThinking, validEffort, resolveEffort, effortForRoute, fastRouteThinkingOff, modeFor, requestBody, requestWithEffort, forcedAnswerBody };
