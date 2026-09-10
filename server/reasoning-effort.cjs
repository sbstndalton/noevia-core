// Only documented model/endpoint pairs receive a provider parameter. Compatible
// wire shape or a successful generic probe does not prove reasoning support.
const crypto = require('node:crypto');
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
  try {
    const url = new URL(provider.baseUrl);
    return !url.search && !url.hash && !url.username && !url.password && url.origin === 'https://api.openai.com' && ['', '/', '/v1', '/v1/'].includes(url.pathname) &&
      model === 'gpt-5.4';
  } catch { return false; }
}
function nativeThinking(provider, model) {
  // Only the configured Lemonade endpoint and documented Qwen3 templates.
  try {
    const normalize = value => new URL(value).href.replace(/\/+$/, '');
    return process.env.MODEL_MANAGER_KIND === 'lemonade' &&
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
  const budgetField = provider?.baseUrl && new URL(provider.baseUrl).origin === 'https://api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
  return { ...body, messages: [{ role: 'system', content: HINTS[effort] }, ...body.messages],
    ...(effort === 'high' ? { [budgetField]: Math.max(body[budgetField] || 0, 8192) } : {}) };
}
async function requestWithEffort(fetcher, url, options, body, provider, model, effort, report) {
  let mode = modeFor(provider, model, effort);
  const key = capabilityKey(provider,model);
  const prepare = () => {
    const value=requestBody(body,effort,mode,provider);
    if (mode === 'hint' && rejectedBudget.has(key)) {delete value.max_tokens;delete value.max_completion_tokens;}
    return value;
  };
  let request=prepare();
  let response=await fetcher(url,{...options,body:JSON.stringify(request)});
  if (response.status >= 400 && response.status < 500) {
    const detail=await response.clone().text();
    if (mode === 'real' && /reasoning_effort|chat_template_kwargs|enable_thinking/i.test(detail)) {
      rejected.add(key);mode='hint';
      report({type:'warning',text:'This provider rejected reasoning effort. Using a best-effort hint instead.'});
      request=prepare();
      response=await fetcher(url,{...options,body:JSON.stringify(request)});
    } else if (mode === 'hint' && effort === 'high' && /max_(?:completion_)?tokens/i.test(detail)) {
      rejectedBudget.add(key);
      report({type:'warning',text:'This provider rejected the output budget. The effort hint remains active with the provider’s default budget.'});
      request=prepare();
      response=await fetcher(url,{...options,body:JSON.stringify(request)});
    }
  }
  report({type:'meta',reasoning:mode,reasoningEffort:effort,outputBudget:request.max_completion_tokens || request.max_tokens});
  return response;
}

module.exports = { nativeThinking, validEffort, resolveEffort, modeFor, requestBody, requestWithEffort };
