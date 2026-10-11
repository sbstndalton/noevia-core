'use strict';
// Sign in with ChatGPT (#447): a person connects their OWN ChatGPT account as a private AI
// provider. Behind the `chatgptOAuth` feature flag (off by default).
//
// How it works
//   Login     OAuth device code, the same flow the Codex CLI offers as `codex login --device-auth`:
//             the server asks auth.openai.com for a one-time code, the person enters it at
//             https://auth.openai.com/codex/device, and the server polls until OpenAI hands back an
//             authorization code plus its PKCE verifier, which it exchanges for tokens. No
//             redirect ever reaches this server, so it works behind Cloudflare with no callback
//             URL, and nothing depends on browser storage or ~/.codex.
//   Storage   access + refresh token, per user, encrypted by secrets.cjs in the v2 user-bound
//             format (AES-GCM with the user id as associated data), in chatgpt_oauth_tokens.
//             Never returned to the client (status and a masked e-mail only), never logged.
//   Refresh   before expiry, and once on a 401. Single-flight per user: OpenAI rotates refresh
//             tokens, so two concurrent refreshes would burn each other. A refused refresh marks
//             the account "reconnect"; a network failure does not.
//   Transport fetchFor(userId) returns a fetch-shaped function that accepts the OpenAI
//             /chat/completions body the chat loop already builds, sends it to the ChatGPT Codex
//             backend's Responses endpoint, and answers in /chat/completions shape (streamed SSE
//             chunks or one JSON completion), so chat.cjs keeps a single upstream path.
//
// Attribution: the token exchange and refresh, the account-id claim, the Codex backend headers
// and request normalisation are adapted from openai-oauth
// (https://github.com/EvanZhouDev/openai-oauth, commit ec7dab2, Apache-2.0, Copyright 2026 Evan
// Zhou and OpenAI OAuth contributors). The device-code endpoints follow OpenAI Codex's
// codex-rs/login/src/device_code_auth.rs (https://github.com/openai/codex, Apache-2.0,
// Copyright 2025 OpenAI). See THIRD_PARTY_NOTICES.md. Both were rewritten here as CommonJS with
// no dependencies; neither package is installed.

const crypto = require('node:crypto');
const { readCappedText } = require('./http.cjs');

const KIND = 'chatgpt-oauth';
const PROVIDER_ID = 'chatgpt-oauth';
const DEFAULTS = Object.freeze({
  issuer: 'https://auth.openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', // the Codex CLI's public OAuth client
  codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
  codexClientVersion: '0.155.0', // only the model catalogue reads it
});
const DEVICE_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_PER_USER = 3;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MODEL_CACHE_MS = 5 * 60 * 1000;
const MODEL_FAILURE_CACHE_MS = 60 * 1000;
const START_WINDOW_MS = 10 * 60 * 1000;
const MAX_STARTS_PER_WINDOW = 5;
const TIMEOUT_MS = 15000;
// One stable, honest User-Agent. The Codex CLI sends `codex_cli_rs/<version> (<os>; <arch>) <terminal>`
// (codex-rs/login/src/auth/default_client.rs get_codex_user_agent); nothing shows the backend
// requires that shape, and noevia does not pretend to be the CLI.
const USER_AGENT = (() => { let v = '0'; try { v = require('../package.json').version || v; } catch { /* runtime without package.json */ } return `noevia/${v} (chatgpt-oauth; +https://github.com/sbstndalton/noevia)`; })();

const fail = (message, status = 502, code = undefined) => Object.assign(new Error(message), { status, code });
const MESSAGES = {
  disconnected: 'ChatGPT is not connected. Sign in with ChatGPT in Settings → AI providers.',
  reconnect: 'Reconnect needed: your ChatGPT sign-in expired or was revoked. Sign in with ChatGPT again in Settings → AI providers.',
  transient: 'ChatGPT sign-in could not be refreshed right now. Try again in a moment.',
};
const authError = (code) => fail(MESSAGES[code], code === 'transient' ? 503 : 401, code);

// ── JWT claims (display and routing only; the token came straight from OpenAI over TLS) ──
function jwtClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
function accountIdFrom(token) {
  const claims = jwtClaims(token);
  if (!claims) return undefined;
  const auth = record(claims['https://api.openai.com/auth']);
  if (auth && typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id) return auth.chatgpt_account_id;
  if (typeof claims.chatgpt_account_id === 'string' && claims.chatgpt_account_id) return claims.chatgpt_account_id;
  const first = Array.isArray(claims.organizations) ? record(claims.organizations[0]) : null;
  return first && typeof first.id === 'string' && first.id ? first.id : undefined;
}
/** A UUID-shaped, stable digest of `text` (never reversible to it). */
function uuidFrom(text) {
  const h = crypto.createHash('sha256').update(String(text)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const isFedRamp = (token) => record(jwtClaims(token)?.['https://api.openai.com/auth'])?.chatgpt_account_is_fedramp === true;
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [name, domain] = [email.slice(0, email.lastIndexOf('@')), email.slice(email.lastIndexOf('@') + 1)];
  return `${name.slice(0, 1)}…@${domain}`.slice(0, 120);
}

/** The token endpoint's answer, reduced to what is stored. `previous` keeps a refresh token that a refresh did not rotate. */
function tokensFrom(payload, { now, previous = null }) {
  const p = record(payload);
  if (!p || typeof p.access_token !== 'string' || !p.access_token) throw fail('ChatGPT did not issue an access token.');
  const idToken = typeof p.id_token === 'string' ? p.id_token : undefined;
  const accountId = accountIdFrom(idToken) || accountIdFrom(p.access_token) || previous?.accountId;
  if (!accountId) throw fail('ChatGPT did not say which account signed in.');
  const idClaims = jwtClaims(idToken) || {};
  const auth = record(idClaims['https://api.openai.com/auth']) || record(jwtClaims(p.access_token)?.['https://api.openai.com/auth']) || {};
  const exp = Number(jwtClaims(p.access_token)?.exp);
  const expiresAt = Number.isFinite(Number(p.expires_in)) && Number(p.expires_in) > 0 ? now() + Number(p.expires_in) * 1000
    : Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  return {
    accessToken: p.access_token,
    refreshToken: typeof p.refresh_token === 'string' && p.refresh_token ? p.refresh_token : previous?.refreshToken || null,
    accountId,
    fedRamp: isFedRamp(idToken) || isFedRamp(p.access_token),
    expiresAt,
    email: typeof idClaims.email === 'string' ? idClaims.email : previous?.email || null,
    plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type.slice(0, 40) : previous?.plan || null,
  };
}

// ── /chat/completions → Responses (request) ─────────────────────────────────
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (record(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
}
function userParts(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  const parts = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (!record(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
    else if (part.type === 'image_url' && typeof part.image_url?.url === 'string') parts.push({ type: 'input_image', image_url: part.image_url.url });
  }
  return parts.length ? parts : [{ type: 'input_text', text: '' }];
}
function toolChoice(choice) {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (record(choice) && choice.type === 'function' && typeof choice.function?.name === 'string') return { type: 'function', name: choice.function.name };
  return undefined;
}
/** The Codex backend takes Responses input, always streams and never stores (store:false; every
 *  turn replays the whole conversation, never previous_response_id). The body is built from an
 *  allowlist, so nothing the backend rejects is ever forwarded: temperature, top_p, top_k, min_p,
 *  max_tokens / max_output_tokens, stream_options, user, safety_identifier (openai-oauth #22),
 *  prompt_cache_retention (#38), metadata, service_tier, seed, stop, n, logprobs and the like. */
function toResponsesRequest(body) {
  const input = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!record(m)) continue;
    if (m.role === 'system' || m.role === 'developer') {
      const text = textOf(m.content);
      if (text) input.push({ role: 'developer', content: [{ type: 'input_text', text }] });
    } else if (m.role === 'user') {
      input.push({ role: 'user', content: userParts(m.content) });
    } else if (m.role === 'assistant') {
      const text = textOf(m.content);
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!record(call) || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || !call.function.name) continue;
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: typeof call.function.arguments === 'string' && call.function.arguments ? call.function.arguments : '{}' });
      }
    } else if (m.role === 'tool' && typeof m.tool_call_id === 'string') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') });
    }
  }
  const out = { model: String(body.model || ''), instructions: '', input, stream: true, store: false, include: ['reasoning.encrypted_content'] };
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((t) => record(t) && t.type === 'function' && typeof t.function?.name === 'string' && t.function.name)
    .map((t) => ({ type: 'function', name: t.function.name, description: typeof t.function.description === 'string' ? t.function.description : undefined,
      // Chat Completions tools are non-strict unless they opt in; the Responses bridge must keep
      // that default or optional parameters are rejected (openai-oauth #44).
      parameters: record(t.function.parameters) || { type: 'object', properties: {} }, strict: t.function.strict === true }));
  if (tools.length) {
    out.tools = tools;
    out.tool_choice = toolChoice(body.tool_choice) || 'auto';
  }
  // An explicit effort also asks for the reasoning summary, or the summary deltas chatParts
  // forwards never arrive (forks YangKeao@d72dec5, twaldin@b471a45). Model defaults are added in
  // fetchFor from the account catalogue.
  if (['minimal', 'low', 'medium', 'high'].includes(body.reasoning_effort)) out.reasoning = { effort: body.reasoning_effort, summary: 'auto' };
  // Structured output (openai-oauth #9/#40): chat's response_format becomes Responses text.format,
  // the same field the Codex CLI's --output-schema sends to this backend.
  const format = responseFormat(body.response_format);
  if (format) out.text = { format };
  return out;
}
function responseFormat(rf) {
  if (!record(rf)) return null;
  if (rf.type === 'json_object') return { type: 'json_object' };
  if (rf.type !== 'json_schema' || !record(rf.json_schema) || !record(rf.json_schema.schema)) return null;
  const js = rf.json_schema;
  return { type: 'json_schema', name: typeof js.name === 'string' && js.name ? js.name.slice(0, 64) : 'response', schema: js.schema,
    strict: js.strict === true, ...(typeof js.description === 'string' ? { description: js.description } : {}) };
}

// ── Responses SSE → /chat/completions (response) ────────────────────────────
async function* sseEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return null;
    try { return JSON.parse(data); } catch { return null; }
  };
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) { const evt = parse(block); if (evt) yield evt; }
  }
  const evt = parse(buffer);
  if (evt) yield evt;
}
const usageOf = (u) => (record(u) ? { prompt_tokens: u.input_tokens ?? null, completion_tokens: u.output_tokens ?? null,
  total_tokens: u.total_tokens ?? (Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens) ? u.input_tokens + u.output_tokens : null) } : null);
/** A person-readable line for an upstream error object, or null if it is not a known kind.
 *  Shapes follow the Codex CLI's own parser (codex-rs/codex-api/src/api_bridge.rs): a 429 with
 *  error.type "usage_limit_reached", plan_type and resets_at (unix seconds). */
function knownError(e, nowMs = Date.now()) {
  if (!record(e)) return null;
  const type = String(e.type || e.code || '');
  const message = typeof e.message === 'string' ? e.message : typeof e.detail === 'string' ? e.detail : '';
  if (type === 'usage_limit_reached' || /usage limit/i.test(message)) {
    const at = Number(e.resets_at) > 0 ? Number(e.resets_at) * 1000 : Number(e.resets_in_seconds) > 0 ? nowMs + Number(e.resets_in_seconds) * 1000 : null;
    const plan = typeof e.plan_type === 'string' && /^[a-z_]{1,20}$/i.test(e.plan_type) ? ` on your ${e.plan_type[0].toUpperCase()}${e.plan_type.slice(1)} plan` : '';
    const when = at ? ` It resets at ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : '';
    return `ChatGPT usage limit reached${plan}.${when} Pick another provider in the model popup until then.`;
  }
  if (type === 'usage_not_included') return 'Your ChatGPT plan does not include the Codex usage that Sign in with ChatGPT relies on.';
  if (['insufficient_quota', 'credit_balance_exhausted', 'organization_usage_limit_exceeded'].includes(type)) return 'Your ChatGPT account has no usage quota left.';
  return null;
}
const errorObject = (value) => (record(value?.error) ? { ...value, ...value.error } : record(value) ? value : null);
const errorText = (value, fallback) => {
  const e = errorObject(value);
  return String(knownError(e) || (e && (e.message || e.detail)) || fallback).slice(0, 300);
};

/** Turns the upstream event stream into the parts the chat loop understands, in order. */
async function* chatParts(stream) {
  const toolIndex = new Map(); // upstream item id -> tool_calls index
  const argsSent = new Set();
  const textSent = new Set(); // message item ids whose text already streamed
  let sawText = false;
  let anonymousText = false; // a text delta without an item id: rebuilding could then duplicate it
  const unsentMessage = (it) => (it.id ? !textSent.has(it.id) && !anonymousText : !sawText);
  let finish = null;
  let usage = null;
  let sawTool = false;
  // openai-oauth #11: Codex sometimes streams a message only as a finished item, or leaves
  // response.completed.output empty after streaming items. Text is rebuilt from whichever arrived.
  const messageText = (item) => (Array.isArray(item.content) ? item.content : [])
    .map((c) => (record(c) && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string' ? c.text : '')).join('');
  for await (const evt of sseEvents(stream)) {
    const item = record(evt.item);
    switch (evt.type) {
      case 'response.output_text.delta':
        if (typeof evt.delta === 'string' && evt.delta) {
          if (typeof evt.item_id === 'string') textSent.add(evt.item_id); else anonymousText = true;
          sawText = true;
          yield { delta: { content: evt.delta } };
        }
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof evt.delta === 'string' && evt.delta) yield { delta: { reasoning_content: evt.delta } };
        break;
      case 'response.output_item.added':
        if (item && item.type === 'function_call' && typeof item.name === 'string') {
          const index = toolIndex.size;
          toolIndex.set(item.id, index);
          sawTool = true;
          yield { delta: { tool_calls: [{ index, id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: '' } }] } };
        }
        break;
      case 'response.function_call_arguments.delta': {
        const index = toolIndex.get(evt.item_id);
        if (index === undefined || typeof evt.delta !== 'string') break;
        argsSent.add(evt.item_id);
        yield { delta: { tool_calls: [{ index, function: { arguments: evt.delta } }] } };
        break;
      }
      case 'response.output_item.done':
        if (item && item.type === 'message' && unsentMessage(item)) {
          const text = messageText(item);
          if (item.id) textSent.add(item.id);
          if (text) { sawText = true; yield { delta: { content: text } }; }
        }
        if (item && item.type === 'function_call') {
          // Some models send a call's arguments only here, never as deltas.
          let index = toolIndex.get(item.id);
          if (index === undefined) {
            index = toolIndex.size;
            toolIndex.set(item.id, index);
            sawTool = true;
            yield { delta: { tool_calls: [{ index, id: item.call_id || item.id, type: 'function', function: { name: String(item.name || ''), arguments: '' } }] } };
          }
          if (!argsSent.has(item.id) && typeof item.arguments === 'string' && item.arguments) {
            argsSent.add(item.id);
            yield { delta: { tool_calls: [{ index, function: { arguments: item.arguments } }] } };
          }
        }
        break;
      case 'response.completed':
      case 'response.incomplete': {
        // Items only present in the final output (nothing streamed for them) still count.
        for (const out of Array.isArray(evt.response?.output) ? evt.response.output : []) {
          if (!record(out)) continue;
          if (out.type === 'message' && unsentMessage(out)) {
            const text = messageText(out);
            if (out.id) textSent.add(out.id);
            if (text) { sawText = true; yield { delta: { content: text } }; }
          } else if (out.type === 'function_call' && !toolIndex.has(out.id) && typeof out.name === 'string') {
            const index = toolIndex.size;
            toolIndex.set(out.id, index);
            sawTool = true;
            yield { delta: { tool_calls: [{ index, id: out.call_id || out.id, type: 'function', function: { name: out.name, arguments: typeof out.arguments === 'string' ? out.arguments : '' } }] } };
          }
        }
        usage = usageOf(evt.response?.usage);
        // An incomplete terminal response is a finished reply with a reason, not an error.
        const reason = evt.type === 'response.incomplete' ? evt.response?.incomplete_details?.reason : null;
        finish = reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'content_filter' : sawTool ? 'tool_calls' : 'stop';
        break;
      }
      case 'response.failed':
        yield { error: errorText(evt.response?.error || evt.response, 'ChatGPT could not finish this reply.'), status: 502 };
        return;
      case 'error':
        yield { error: errorText(evt, 'ChatGPT returned an error.'), status: knownError(errorObject(evt)) ? 429 : 502 };
        return;
      default:
        break;
    }
    if (finish) break;
  }
  if (!finish) { yield { error: 'ChatGPT ended the reply early.' }; return; }
  yield { finish, usage };
}

/** `parts` is a chatParts() iterator whose first result was already read (`first`), so an error
 *  that arrives before any output becomes a real HTTP error instead of 200 + a cut-off stream
 *  (openai-oauth #39). Later errors are sent as an explicit error frame, then [DONE]. */
function chatStream(parts, first, model) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const frame = (value) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  const chunk = (delta, finish_reason = null) => frame({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }] });
  let opened = false;
  let pending = first;
  return new ReadableStream({
    async pull(controller) {
      try {
        if (!opened) { opened = true; controller.enqueue(chunk({ role: 'assistant' })); return; }
        const { value, done } = pending || await parts.next();
        pending = null;
        if (done) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); return; }
        if (value.error) { controller.enqueue(frame({ error: { message: value.error, source: 'chatgpt' } })); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); return; }
        if (value.delta) { controller.enqueue(chunk(value.delta)); return; }
        controller.enqueue(chunk({}, value.finish));
        if (value.usage) controller.enqueue(frame({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: value.usage }));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() { await parts.return?.(); },
  });
}

async function chatCompletion(upstreamBody, model) {
  let content = '';
  let reasoning = '';
  const calls = [];
  let finish = 'stop';
  let usage = null;
  for await (const part of chatParts(upstreamBody)) {
    if (part.error) return { error: { message: part.error, status: part.status } };
    if (part.delta?.content) content += part.delta.content;
    if (part.delta?.reasoning_content) reasoning += part.delta.reasoning_content;
    for (const tc of part.delta?.tool_calls || []) {
      const slot = calls[tc.index] || (calls[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
    if (part.finish) { finish = part.finish; usage = part.usage; }
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) message.tool_calls = calls.filter(Boolean);
  return { id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) };
}

/** An answer in the shape the chat loop reads. The header tells chat.cjs the message is safe to show as is. */
function errorResponse(status, message, code) {
  return new Response(JSON.stringify({ error: { message, ...(code ? { code } : {}) } }), {
    status, headers: { 'content-type': 'application/json', 'x-noevia-provider-message': '1' },
  });
}
function upstreamMessage(text, status) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  const e = errorObject(parsed);
  const known = knownError(e) || (!e && /usage limit/i.test(String(text)) ? knownError({ type: 'usage_limit_reached' }) : null);
  if (known) return known.slice(0, 300);
  const detail = e ? (typeof e.detail === 'string' ? e.detail : typeof e.message === 'string' ? e.message : '') : '';
  if (status === 429) return `ChatGPT is rate-limiting this account${detail ? `: ${detail}` : ''}. Try again shortly.`.slice(0, 300);
  return `ChatGPT returned ${status}${detail ? `: ${detail}` : ''}`.slice(0, 300);
}

/**
 * @param {object} deps
 * @param {{ exec(sql:string):void, prepare(sql:string):any }} deps.db   the auth database
 * @param {{ encrypt(v:string, userId?:string):string, decrypt(v:string, userId?:string):string }} deps.secrets
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {(action:string, userId:string|null, detail:object) => void} [deps.audit]
 * @param {Partial<typeof DEFAULTS>} [deps.config]
 */
function createChatGptOAuth({ db, secrets, fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now(), audit = () => {}, config = {} }) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([, v]) => typeof v === 'string' && v)) };
  const issuer = cfg.issuer.replace(/\/+$/, '');
  const codexBase = cfg.codexBaseUrl.replace(/\/+$/, '');
  db.exec(`CREATE TABLE IF NOT EXISTS chatgpt_oauth_tokens(user_id TEXT PRIMARY KEY, data_enc TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'connected', updated_at INTEGER NOT NULL)`);

  // ── storage (v2, bound to the owning user) ──
  function read(userId) {
    if (!userId) return null;
    const row = db.prepare('SELECT data_enc, state FROM chatgpt_oauth_tokens WHERE user_id=?').get(String(userId));
    if (!row) return null;
    let data = null;
    try { data = JSON.parse(secrets.decrypt(row.data_enc, String(userId))); } catch { data = null; }
    return { state: row.state, data: record(data), raw: row.data_enc };
  }
  function write(userId, data, state = 'connected') {
    db.prepare(`INSERT INTO chatgpt_oauth_tokens(user_id, data_enc, state, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET data_enc=excluded.data_enc, state=excluded.state, updated_at=excluded.updated_at`)
      .run(String(userId), secrets.encrypt(JSON.stringify(data), String(userId)), state, now());
  }
  /** Marks THIS stored sign-in (by its ciphertext) as needing a reconnect; a newer one is left alone. */
  function markReconnect(userId, raw = null) {
    const r = raw
      ? db.prepare("UPDATE chatgpt_oauth_tokens SET state='reconnect', updated_at=? WHERE user_id=? AND data_enc=?").run(now(), String(userId), raw)
      : db.prepare("UPDATE chatgpt_oauth_tokens SET state='reconnect', updated_at=? WHERE user_id=?").run(now(), String(userId));
    if (r.changes) audit('chatgpt.oauth.reconnect_needed', String(userId), {});
  }

  async function postJson(url, body, { form = false } = {}) {
    const r = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
    const text = (await readCappedText(r, 256 * 1024).catch(() => ({ text: '' }))).text;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { ok: r.ok, status: r.status, body: parsed };
  }

  // ── device-code login ──
  // Endpoints and bodies match the Codex CLI's `codex login --device-auth`
  // (openai/codex codex-rs/login/src/device_code_auth.rs @985cf47: usercode L63-70 and L167-175,
  // token poll L107-131, redirect_uri L206; code exchange as a form, oauth/client.rs L58-67).
  const pending = new Map(); // loginId -> { userId, deviceAuthId, userCode, interval, expires, nextPollAt, polling, cancelled, generation }
  const models = new Map(); // userId -> { until, ids }: the account's model catalogue (ids null = unavailable)
  const generations = new Map(); // userId -> number, bumped by disconnect: an exchange in flight must not reconnect
  const starts = new Map(); // userId -> start timestamps (rate limit)
  const generation = (userId) => generations.get(userId) || 0;
  const bump = (userId) => generations.set(userId, generation(userId) + 1);
  const prune = () => { for (const [k, v] of pending) if (v.expires < now()) pending.delete(k); };
  const dropPending = (userId) => { for (const [k, v] of pending) if (v.userId === userId) { v.cancelled = true; pending.delete(k); } };

  async function startDeviceLogin(userId) {
    if (!userId) throw fail('Sign in to noevia first.', 401);
    const recent = (starts.get(userId) || []).filter((at) => at > now() - START_WINDOW_MS);
    if (recent.length >= MAX_STARTS_PER_WINDOW) throw fail('Too many ChatGPT sign-in attempts. Wait a few minutes and try again.', 429);
    starts.set(userId, [...recent, now()]);
    prune();
    const own = [...pending].filter(([, v]) => v.userId === userId).map(([k]) => k);
    while (own.length >= MAX_PENDING_PER_USER) { const k = own.shift(); pending.get(k).cancelled = true; pending.delete(k); }
    let r;
    try { r = await postJson(`${issuer}/api/accounts/deviceauth/usercode`, { client_id: cfg.clientId }); }
    catch { throw fail('ChatGPT sign-in could not be reached. Try again.', 502); }
    if (r.status === 404) throw fail('ChatGPT device sign-in is not available right now.', 502);
    const deviceAuthId = r.body?.device_auth_id;
    const userCode = r.body?.user_code ?? r.body?.usercode;
    if (!r.ok || typeof deviceAuthId !== 'string' || typeof userCode !== 'string' || !deviceAuthId || !userCode || deviceAuthId.length > 512 || userCode.length > 64) {
      throw fail(`ChatGPT sign-in could not start (${r.status}).`, 502);
    }
    const interval = Math.min(30, Math.max(1, Number.parseInt(String(r.body.interval ?? '5'), 10) || 5));
    const loginId = crypto.randomBytes(18).toString('base64url');
    const expires = now() + DEVICE_TTL_MS;
    pending.set(loginId, { userId, deviceAuthId, userCode, interval, expires, nextPollAt: now() + interval * 1000, polling: false, cancelled: false, generation: generation(userId) });
    audit('chatgpt.oauth.start', userId, {});
    return { loginId, userCode, verificationUrl: `${issuer}/codex/device`, interval, expiresAt: expires };
  }

  async function exchange(code, verifier) {
    let r;
    try {
      r = await postJson(`${issuer}/oauth/token`, { grant_type: 'authorization_code', code, redirect_uri: `${issuer}/deviceauth/callback`,
        client_id: cfg.clientId, code_verifier: verifier }, { form: true });
    } catch { throw fail('ChatGPT sign-in could not be completed. Start again.', 502); }
    if (!r.ok) throw fail(`ChatGPT sign-in was refused (${r.status}). Start again.`, 502);
    return tokensFrom(r.body, { now });
  }

  /** Poll one pending login. Only the account that started it may poll or cancel it. The entry
   *  stays pending through the token exchange, so a Cancel or Disconnect during it still wins. */
  async function pollDeviceLogin(userId, loginId) {
    const p = pending.get(String(loginId || ''));
    if (p && p.userId !== userId) throw fail('This sign-in was started by a different account.', 403);
    if (!p || p.expires < now()) { if (p) pending.delete(loginId); return { state: 'expired' }; }
    if (p.polling || now() < p.nextPollAt) return { state: 'pending', interval: p.interval };
    p.polling = true;
    p.nextPollAt = now() + p.interval * 1000;
    const abandoned = () => p.cancelled || p.generation !== generation(userId);
    try {
      let r;
      try { r = await postJson(`${issuer}/api/accounts/deviceauth/token`, { device_auth_id: p.deviceAuthId, user_code: p.userCode }); }
      catch { return { state: 'pending', interval: p.interval }; }
      if (r.status === 403 || r.status === 404) return { state: 'pending', interval: p.interval };
      const code = r.body?.authorization_code;
      const verifier = r.body?.code_verifier;
      if (!r.ok || typeof code !== 'string' || typeof verifier !== 'string' || !code || !verifier) {
        pending.delete(loginId);
        throw fail(`ChatGPT sign-in failed (${r.status}). Start again.`, 502);
      }
      if (abandoned()) return { state: 'cancelled' };
      let tokens;
      try { tokens = await exchange(code, verifier); } finally { if (pending.get(loginId) === p) pending.delete(loginId); }
      // Checked after the exchange and before the (synchronous) write: nothing can slip in between.
      if (abandoned()) { audit('chatgpt.oauth.cancelled', userId, {}); return { state: 'cancelled' }; }
      write(userId, { ...tokens, connectedAt: now() });
      models.delete(userId);
      audit('chatgpt.oauth.connect', userId, { plan: tokens.plan || undefined });
      return { state: 'connected', account: { email: maskEmail(tokens.email), plan: tokens.plan } };
    } finally {
      p.polling = false;
    }
  }

  function cancelDeviceLogin(userId, loginId) {
    const p = pending.get(String(loginId || ''));
    if (!p) return false;
    if (p.userId !== userId) throw fail('This sign-in was started by a different account.', 403);
    p.cancelled = true;
    return pending.delete(loginId);
  }

  // ── tokens in use ──
  // Known limit: if OpenAI completes a refresh but the answer never reaches us (timeout), the old
  // refresh token is already spent and the next refresh is refused, so the account shows
  // "Reconnect needed". There is no safe automatic recovery; signing in again fixes it.
  const refreshing = new Map(); // userId -> Promise<{ data, raw }>  (raw: ciphertext of the row those tokens live in)
  function refresh(userId, row) {
    if (refreshing.has(userId)) return refreshing.get(userId);
    const current = row.data;
    const run = (async () => {
      if (!current.refreshToken) { markReconnect(userId, row.raw); throw authError('reconnect'); }
      let r;
      try { r = await postJson(`${issuer}/oauth/token`, { grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: cfg.clientId }); }
      catch { throw authError('transient'); }
      if ([400, 401, 403].includes(r.status)) {
        markReconnect(userId, row.raw);
        const latest = read(userId);
        // A re-sign-in that landed meanwhile is still good: use it rather than failing.
        if (latest && latest.raw !== row.raw && latest.state === 'connected' && latest.data) return { data: latest.data, raw: latest.raw };
        throw authError('reconnect');
      }
      if (!r.ok) throw authError('transient');
      let next;
      try { next = { ...tokensFrom(r.body, { now, previous: current }), connectedAt: current.connectedAt || now() }; }
      catch { throw authError('transient'); }
      // Compare-and-set on the ciphertext this refresh started from: a disconnect or a newer
      // sign-in that landed while the refresh was in flight wins, never the stale refresh.
      const nextRaw = secrets.encrypt(JSON.stringify(next), String(userId));
      const kept = db.prepare("UPDATE chatgpt_oauth_tokens SET data_enc=?, updated_at=? WHERE user_id=? AND state='connected' AND data_enc=?")
        .run(nextRaw, now(), String(userId), row.raw);
      if (kept.changes) return { data: next, raw: nextRaw };
      const latest = read(userId);
      if (latest && latest.state === 'connected' && latest.data) return { data: latest.data, raw: latest.raw };
      throw authError(latest ? 'reconnect' : 'disconnected');
    })();
    refreshing.set(userId, run);
    run.then(() => refreshing.delete(userId), () => refreshing.delete(userId));
    return run;
  }
  /** Usable tokens for this user, with the ciphertext of the stored row they came from (`raw`, for
   *  markReconnect; never returned to callers outside this module): refreshed near expiry, or after
   *  a 401 on `rejectedToken`. */
  async function sessionRow(userId, { rejectedToken = null } = {}) {
    const row = read(userId);
    if (!row) throw authError('disconnected');
    if (row.state !== 'connected' || !row.data || typeof row.data.accessToken !== 'string') throw authError('reconnect');
    const t = row.data;
    if (rejectedToken) {
      // Another request may already have refreshed; use that rather than burning a refresh token.
      if (t.accessToken !== rejectedToken) return { data: t, raw: row.raw };
      return refresh(userId, row);
    }
    if (t.expiresAt && t.expiresAt - now() <= REFRESH_MARGIN_MS) {
      try { return await refresh(userId, row); } catch (e) {
        // A soft failure inside the early-refresh window keeps the still-valid token (fork 3b04587).
        if (e.code === 'transient' && t.expiresAt > now()) return { data: t, raw: row.raw };
        throw e;
      }
    }
    return { data: t, raw: row.raw };
  }
  async function session(userId, opts) { return (await sessionRow(userId, opts)).data; }

  function status(userId) {
    const row = read(userId);
    if (!row) return { state: 'disconnected' };
    if (row.state !== 'connected' || !row.data) return { state: 'reconnect' };
    return { state: 'connected', account: { email: maskEmail(row.data.email), plan: row.data.plan || null } };
  }
  function disconnect(userId) {
    bump(userId);
    db.prepare('DELETE FROM chatgpt_oauth_tokens WHERE user_id=?').run(String(userId));
    dropPending(userId);
    models.delete(userId);
    audit('chatgpt.oauth.disconnect', String(userId), {});
  }
  function forgetUser(userId) {
    bump(userId);
    db.prepare('DELETE FROM chatgpt_oauth_tokens WHERE user_id=?').run(String(userId));
    dropPending(userId);
    models.delete(userId);
    starts.delete(userId);
  }

  /** The protocol headers the Codex client itself sends (openai/codex @985cf47):
   *  Authorization + ChatGPT-Account-ID, and X-OpenAI-Fedramp for FedRAMP accounts
   *  (codex-rs/model-provider/src/bearer_auth_provider.rs L32-44: the Codex source DOES send it,
   *  so a fork's advice to drop it is not followed); per conversation, `session-id` and
   *  `x-client-request-id` (codex-rs/codex-api/src/endpoint/responses.rs L86-90,
   *  requests/headers.rs L5-11). Not sent: `originator: codex_cli_rs` and the CLI's User-Agent
   *  (that would claim to be the CLI; upstream openai-oauth works without them), installation,
   *  window and turn-metadata telemetry. */
  function upstreamHeaders(t, accept, conversationId = null) {
    const h = { 'content-type': 'application/json', accept, authorization: `Bearer ${t.accessToken}`, 'chatgpt-account-id': t.accountId, 'user-agent': USER_AGENT };
    if (t.fedRamp) h['x-openai-fedramp'] = 'true';
    if (conversationId) { h['session-id'] = conversationId; h['x-client-request-id'] = conversationId; }
    return h;
  }
  /** One authorised upstream call with the refresh-once-on-401 rule. Returns a Response or an error Response. */
  async function authorised(userId, send) {
    let t;
    let raw;
    try { ({ data: t, raw } = await sessionRow(userId)); } catch (e) { return errorResponse(e.status || 401, e.message, e.code); }
    let r = await send(t);
    if (r.status !== 401) return r;
    try { await r.body?.cancel?.(); } catch { /* already closed */ }
    try { ({ data: t, raw } = await sessionRow(userId, { rejectedToken: t.accessToken })); } catch (e) { return errorResponse(e.status || 401, e.message, e.code); }
    r = await send(t);
    if (r.status === 401) {
      try { await r.body?.cancel?.(); } catch { /* already closed */ }
      // Only the sign-in that actually failed: a newer one written meanwhile is left alone (#934).
      markReconnect(userId, raw);
      return errorResponse(401, MESSAGES.reconnect, 'reconnect');
    }
    return r;
  }

  /** A fetch for the chat loop: /chat/completions in, /chat/completions out, the user's bearer on the wire. */
  function fetchFor(userId, { conversation = null } = {}) {
    // An opaque, stable id per (account, conversation): the session the backend caches prompts
    // under (prompt_cache_key, as the Codex client sends). Derived, so no internal id leaves.
    const conversationId = conversation ? uuidFrom(`${userId}:${conversation}`) : null;
    return async function chatgptFetch(url, init = {}) {
      let pathname = '';
      try { pathname = new URL(String(url)).pathname; } catch { /* checked below */ }
      // Chat only: never the images route (openai-oauth #31: its token has no image scope).
      if (!/\/chat\/completions$/.test(pathname)) return errorResponse(404, 'Only chat completions are available through ChatGPT.');
      let body;
      try { body = JSON.parse(String(init.body || '')); } catch { return errorResponse(400, 'The chat request was not valid JSON.'); }
      const model = String(body.model || '');
      // The account's catalogue is the allowlist (fork 1bc2913/3b04587). If it cannot be read the
      // request goes ahead and the backend decides; a known miss is refused plainly.
      if (!model) return errorResponse(400, 'Choose a ChatGPT model in the model popup.');
      const catalogue = await modelCatalogue(userId).catch(() => null);
      if (Array.isArray(catalogue) && catalogue.length && !catalogue.some((m) => m.slug === model)) {
        return errorResponse(400, `${model.slice(0, 80)} is not available on your ChatGPT account. Choose one of: ${catalogue.slice(0, 8).map((m) => m.slug).join(', ')}.`);
      }
      const wantsStream = body.stream === true;
      const request = toResponsesRequest(body);
      const info = catalogue?.find((m) => m.slug === model);
      if (info) {
        // The model's own defaults, as the Codex client applies them (ModelInfo in
        // codex-rs/protocol/src/openai_models.rs: default_reasoning_level, default_reasoning_summary,
        // supports_reasoning_summary_parameter).
        const reasoning = { ...(request.reasoning || {}) };
        if (!reasoning.effort && info.effort) reasoning.effort = info.effort;
        if (info.summaryParam && info.summary !== 'none') reasoning.summary = info.summary || 'auto';
        else delete reasoning.summary;
        if (Object.keys(reasoning).length) request.reasoning = reasoning; else delete request.reasoning;
      }
      if (conversationId) request.prompt_cache_key = conversationId;
      const upstreamBody = JSON.stringify(request);
      const r = await authorised(userId, (t) => fetchImpl(`${codexBase}/responses`, {
        method: 'POST', redirect: 'error', signal: init.signal, headers: upstreamHeaders(t, 'text/event-stream', conversationId), body: upstreamBody,
      }));
      if (r.headers.get('x-noevia-provider-message') === '1') return r;
      if (!r.ok || !r.body) {
        const text = (await readCappedText(r, 64 * 1024).catch(() => ({ text: '' }))).text;
        return errorResponse(r.status || 502, upstreamMessage(text, r.status));
      }
      if (wantsStream) {
        const parts = chatParts(r.body);
        let first;
        try { first = await parts.next(); } catch (e) { return errorResponse(502, `ChatGPT stream failed: ${String(e?.message || e).slice(0, 200)}`); }
        if (!first.done && first.value.error) { await parts.return?.(); return errorResponse(first.value.status || 502, first.value.error); }
        return new Response(chatStream(parts, first, model), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const completion = await chatCompletion(r.body, model);
      if (completion.error) return errorResponse(completion.error.status || 502, completion.error.message);
      return new Response(JSON.stringify(completion), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  }

  /** The account's model catalogue (public ids only), cached for five minutes per user; a failure
   *  is remembered for a minute so a broken catalogue does not add a call to every chat. */
  async function listModels(userId) {
    return (await modelCatalogue(userId)).map((m) => m.slug);
  }
  async function modelCatalogue(userId) {
    const cached = models.get(userId);
    if (cached && cached.until > now()) { if (cached.ids) return cached.ids; throw fail(cached.error, 502); }
    const r = await authorised(userId, (t) => fetchImpl(`${codexBase}/models?client_version=${encodeURIComponent(cfg.codexClientVersion)}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: upstreamHeaders(t, 'application/json'),
    }));
    const text = (await readCappedText(r, 2 * 1024 * 1024).catch(() => ({ text: '' }))).text;
    if (r.headers.get('x-noevia-provider-message') === '1') { let m = ''; try { m = JSON.parse(text).error.message; } catch { /* fallthrough */ } throw fail(m || MESSAGES.reconnect, r.status); }
    const remember = (error) => { models.set(userId, { until: now() + MODEL_FAILURE_CACHE_MS, ids: null, error }); return fail(error, 502); };
    if (!r.ok) throw remember(upstreamMessage(text, r.status));
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const word = (v) => (typeof v === 'string' && /^[a-z_]{1,20}$/.test(v) ? v : null);
    const ids = (Array.isArray(parsed?.models) ? parsed.models : [])
      .filter((m) => record(m) && typeof m.slug === 'string' && m.slug && m.supported_in_api !== false && (m.visibility === undefined || m.visibility === 'list'))
      .map((m) => ({ slug: m.slug.slice(0, 120), effort: word(m.default_reasoning_level), summary: word(m.default_reasoning_summary),
        summaryParam: m.supports_reasoning_summary_parameter !== false })).slice(0, 50);
    if (!ids.length) throw remember('ChatGPT returned no models for this account.');
    models.set(userId, { until: now() + MODEL_CACHE_MS, ids });
    return ids;
  }

  return { startDeviceLogin, pollDeviceLogin, cancelDeviceLogin, status, disconnect, forgetUser, session, fetchFor, listModels };
}

/** The private provider row that points chats at this account. No credential lives in it. */
function providerRow() {
  return { id: PROVIDER_ID, kind: KIND, label: 'ChatGPT', baseUrl: DEFAULTS.codexBaseUrl, apiKey: '', defaultModel: '', shared: false, external: true };
}
const isChatGptProvider = (provider) => !!provider && provider.kind === KIND;

module.exports = { KIND, PROVIDER_ID, DEFAULTS, createChatGptOAuth, providerRow, isChatGptProvider, toResponsesRequest, chatParts, maskEmail, accountIdFrom };
