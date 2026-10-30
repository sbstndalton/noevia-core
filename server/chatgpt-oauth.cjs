'use strict';
// Sign in with ChatGPT (#447): a person connects their OWN ChatGPT account as a private AI
// provider. Behind the `chatgptOAuth` feature flag (off by default).
//
// How it works (sbstndalton/noevia#2190 round 5: the Rust front is the token broker)
//   Login     OAuth device code, the same flow the Codex CLI offers as `codex login --device-auth`,
//             answered by the Rust front (noevia-rs chatgpt_oauth_routes.rs; this core refuses the
//             routes, rust-chatgpt-oauth.cjs).
//   Storage   access + refresh token, per user, sealed enc:v2 bound to the owner by the front, in
//             chatgpt_oauth_tokens, which only the front writes (rust-auth.cjs FRONT_TABLES). This
//             process reads a row's state only, and never sees a refresh token.
//   Refresh   the front's: single-flight per account, refresh-ahead inside five minutes of expiry,
//             compare-and-swap writes. This process asks for a current access token
//             (createChatGptOAuth `session`), caches it briefly, and on a 401 asks once more with
//             the rejected token; a second 401 marks that sign-in "reconnect".
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
  codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
});
// sbstndalton/noevia#2190 round 5: the access token is cached in this process at most this long,
// and never inside the broker's refresh margin (five minutes before expiry).
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SESSION_CACHE_MS = 60 * 1000;
const SESSION_CACHE_MAX = 1000;
// One stable, honest User-Agent. The Codex CLI sends `codex_cli_rs/<version> (<os>; <arch>) <terminal>`
// (codex-rs/login/src/auth/default_client.rs get_codex_user_agent); nothing shows the backend
// requires that shape, and noevia does not pretend to be the CLI. The Rust broker sends the same.
const USER_AGENT = (() => { let v = '0'; try { v = require('../package.json').version || v; } catch { /* runtime without package.json */ } return `noevia/${v} (chatgpt-oauth; +https://github.com/sbstndalton/noevia)`; })();

const fail = (message, status = 502, code = undefined) => Object.assign(new Error(message), { status, code });
const MESSAGES = {
  disconnected: 'ChatGPT is not connected. Sign in with ChatGPT in Settings → AI providers.',
  reconnect: 'Reconnect needed: your ChatGPT sign-in expired or was revoked. Sign in with ChatGPT again in Settings → AI providers.',
  transient: 'ChatGPT sign-in could not be refreshed right now. Try again in a moment.',
};
const authError = (code) => fail(MESSAGES[code], code === 'transient' ? 503 : 401, code);

const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
/** A UUID-shaped, stable digest of `text` (never reversible to it). */
function uuidFrom(text) {
  const h = crypto.createHash('sha256').update(String(text)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
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
// The levels this adapter forwards on any model (#1311 covers the rest, checked against the catalogue).
const BASIC_EFFORTS = ['minimal', 'low', 'medium', 'high'];
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
  if (BASIC_EFFORTS.includes(body.reasoning_effort)) out.reasoning = { effort: body.reasoning_effort, summary: 'auto' };
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
 * sbstndalton/noevia#2190 round 5: the Rust front is Sign in with ChatGPT's token broker (noevia-rs
 * bins/noevia-server chatgpt_oauth_routes.rs, capability rust-chatgpt-oauth): the device sign-in, the
 * token store (chatgpt_oauth_tokens, enc:v2 bound to the owner), the single-flight refresh and the
 * model catalogue cache are its own. This process keeps only the chat transport: it asks the broker
 * for a current access token over the internal store channel (project-store-client.cjs
 * chatgptSession: loopback, the per-start secret) and never holds a refresh token. The access token
 * is cached here for at most a minute, never inside the refresh margin, and dropped as soon as the
 * broker's change signal (chatgpt-token-changes.json, shared-reread.cjs fileSignal) moves or the
 * upstream answers 401. Node writes nothing to the table (rust-auth.cjs FRONT_TABLES); it only
 * creates it (Node is the schema migrator) and reads a row's state.
 *
 * @param {object} deps
 * @param {{ exec(sql:string):void, prepare(sql:string):any }} deps.db   the auth database (read-only use)
 * @param {object} deps.broker   project-store-client.cjs: chatgptSession, chatgptReject, chatgptCatalogue,
 *                               chatgptDisconnect, chatgptForget
 * @param {() => string} [deps.signal]   the broker's change signal (fileSignal of chatgpt-token-changes.json)
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {{ codexBaseUrl?: string }} [deps.config]
 */
function createChatGptOAuth({ db, broker, signal = () => '', fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now(), config = {} }) {
  const codexBase = (typeof config.codexBaseUrl === 'string' && config.codexBaseUrl ? config.codexBaseUrl : DEFAULTS.codexBaseUrl).replace(/\/+$/, '');
  db.exec(`CREATE TABLE IF NOT EXISTS chatgpt_oauth_tokens(user_id TEXT PRIMARY KEY, data_enc TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'connected', updated_at INTEGER NOT NULL)`);

  /** The account's connection state, read from the broker's row (its state only, never its tokens). */
  function status(userId) {
    if (!userId) return { state: 'disconnected' };
    const row = db.prepare('SELECT state FROM chatgpt_oauth_tokens WHERE user_id=?').get(String(userId));
    if (!row) return { state: 'disconnected' };
    return { state: row.state === 'connected' ? 'connected' : 'reconnect' };
  }

  const sessions = new Map(); // userId -> { session, until, signal }
  /** The broker's answer as core's errors: written for people, never a credential. */
  const brokerError = (r) => fail(typeof r?.error === 'string' ? r.error.slice(0, 300) : MESSAGES.transient,
    Number.isInteger(r?.status) && r.status >= 400 && r.status < 600 ? r.status : 503, typeof r?.code === 'string' ? r.code : undefined);
  /** Usable tokens for this user ({ accessToken, accountId, fedRamp, expiresAt, generation }). */
  async function session(userId, { rejectedToken = null } = {}) {
    const key = String(userId);
    const mark = (() => { try { return signal(); } catch { return null; } })();
    if (!rejectedToken && mark !== null) {
      const hit = sessions.get(key);
      if (hit && hit.signal === mark && hit.until > now()) return hit.session;
    }
    sessions.delete(key);
    let r;
    try { r = await broker.chatgptSession(key, rejectedToken); } catch { throw authError('transient'); }
    if (!r || !r.ok) throw brokerError(r);
    const s = r.session;
    const until = Math.min(now() + SESSION_CACHE_MS, Number.isFinite(s.expiresAt) && s.expiresAt > 0 ? s.expiresAt - REFRESH_MARGIN_MS : Infinity);
    if (mark !== null && until > now()) {
      sessions.set(key, { session: s, until, signal: mark });
      while (sessions.size > SESSION_CACHE_MAX) sessions.delete(sessions.keys().next().value);
    }
    return s;
  }
  async function disconnect(userId) {
    sessions.delete(String(userId));
    const r = await broker.chatgptDisconnect(String(userId));
    if (!r || !r.ok) throw brokerError(r);
  }
  async function forgetUser(userId) {
    sessions.delete(String(userId));
    const r = await broker.chatgptForget(String(userId));
    if (!r || !r.ok) throw brokerError(r);
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
    try { t = await session(userId); } catch (e) { return errorResponse(e.status || 401, e.message, e.code); }
    let r = await send(t);
    if (r.status !== 401) return r;
    try { await r.body?.cancel?.(); } catch { /* already closed */ }
    try { t = await session(userId, { rejectedToken: t.accessToken }); } catch (e) { return errorResponse(e.status || 401, e.message, e.code); }
    r = await send(t);
    if (r.status === 401) {
      try { await r.body?.cancel?.(); } catch { /* already closed */ }
      // Only the sign-in that actually failed: a newer one written meanwhile is left alone (#934).
      sessions.delete(String(userId));
      await broker.chatgptReject(String(userId), t.generation).catch(() => null);
      return errorResponse(401, MESSAGES.reconnect, 'reconnect');
    }
    return r;
  }

  /** The account's catalogue entries from the broker ({ slug, effort, summary, summaryParam, levels }). */
  async function modelCatalogue(userId) {
    const r = await broker.chatgptCatalogue(String(userId));
    if (!r || !r.ok) throw brokerError(r);
    return r.models;
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
      // #1311: an explicit effort the basic mapping does not forward (xhigh, max, ultra, or any
      // other level) is either sent, when this model's published list offers it, or refused with
      // the levels it does offer. It is never dropped, which would answer at a level nobody chose.
      const asked = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : null;
      if (asked && asked !== 'default') {
        // #1592: the basic levels are checked too, when this model publishes its levels; with no published
        // list they go through as before. The refusal names the real cause: an unreadable list, or a model
        // whose loaded entry lists no reasoning levels.
        const offered = Array.isArray(info?.levels) && info.levels.length ? info.levels : null;
        const basic = BASIC_EFFORTS.includes(asked);
        if (offered ? !offered.includes(asked) : !basic) {
          const shown = asked.slice(0, 40);
          return errorResponse(400, offered
            ? `ChatGPT does not offer "${shown}" reasoning for ${model.slice(0, 80)}. It offers ${offered.join(', ')}, or Default.`
            : info
              ? `"${shown}" reasoning is not in your account's list for ${model.slice(0, 80)}. Choose Default, Low, Medium or High.`
              : `ChatGPT's model list could not be read, so "${shown}" reasoning cannot be checked for ${model.slice(0, 80)}. Choose Default, Low, Medium or High.`);
        }
        if (!basic) request.reasoning = { ...(request.reasoning || {}), effort: asked, summary: request.reasoning?.summary || 'auto' };
      }
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

  return { status, disconnect, forgetUser, session, fetchFor };
}
/** The private provider row that points chats at this account. No credential lives in it. */
function providerRow() {
  return { id: PROVIDER_ID, kind: KIND, label: 'ChatGPT', baseUrl: DEFAULTS.codexBaseUrl, apiKey: '', defaultModel: '', shared: false, external: true };
}
const isChatGptProvider = (provider) => !!provider && provider.kind === KIND;

module.exports = { KIND, PROVIDER_ID, DEFAULTS, USER_AGENT, createChatGptOAuth, providerRow, isChatGptProvider, toResponsesRequest, chatParts };
