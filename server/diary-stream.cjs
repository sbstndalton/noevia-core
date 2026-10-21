const { readCappedJson } = require('./http.cjs');

// #1422: what the browser (and the exchange journal) is told when an exchange fails depends on
// whether the server KNOWS nothing was saved. The companion only starts saving after the model has
// answered, and says so with a status line, so:
//  - an HTTP error before its stream starts (storage login refused, throttled, tenant refused ...)
//    means the exchange never ran;
//  - a failure reported by the companion itself after a recognised early step and before it began
//    saving ("Checking whether to save this exchange…") means nothing was written (its worker has
//    ended, it cannot continue saving);
//  - anything else (a dropped connection, a gateway timeout, a failure while saving) is genuinely
//    unknown, because the companion keeps working after the browser or this proxy lets go.
const MODEL_STATUS = 'Generating companion response…';
// Every status the companion sends before it starts saving. Any OTHER status text counts as the saving
// phase (a newer companion's new step must never be mistaken for "nothing was saved").
const PRE_SAVE_STATUSES = new Set(['Opening diary context…', 'Reading diary entries and memory…', MODEL_STATUS]);
const NOT_STARTED_STATUSES = new Set([400, 401, 403, 404, 410, 424, 428, 429, 503]);
const NOT_SAVED = ' — nothing was saved.';
const MESSAGES = {
  storageLoginRejected: `Diary storage refused the saved login${NOT_SAVED} Reconnect storage, then resend.`,
  storageThrottled: `Diary storage is limiting sign-ins right now${NOT_SAVED} Wait a moment, then resend.`,
  diaryUnavailable: `Couldn't reach the Diary companion${NOT_SAVED} You can resend.`,
  contextFailed: `Couldn't read your diary${NOT_SAVED} You can resend.`,
  modelFailed: `Couldn't reach the local model${NOT_SAVED} You can resend.`,
  modelNotServed: `The Diary companion is set to use a model the local engine does not serve${NOT_SAVED} Ask an administrator to change the Diary model.`,
};
/** An error event for a failure after which the server knows nothing was saved. */
function notSaved(code, extra = {}) {
  return { type: 'error', code, saved: false, text: MESSAGES[code] || MESSAGES.diaryUnavailable, ...extra };
}
const CONNECT_REFUSED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

// Keep the browser/proxy connection alive throughout one journaled operation.
// options.headers may be `(withSecret) => headers`; withStorageCredential (diary.cjs) then resends once
// with the storage secret when the sidecar answers 428 before any stream starts.
// diagnose (optional): async () => { code, ...extra } | null, asked once when the companion fails
// while generating, to name a cause that the companion's own error event does not carry (#1422).
async function proxyDiaryStream(res, url, options, { heartbeatMs = 5000, onEvent, job, withStorageCredential = (send) => send(true), diagnose } = {}) {
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded && !job) controller.abort(); };
  res.on('close', close);
  res.on('error', () => {});
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  const send = event => { job?.event(event); if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, heartbeatMs);
  const deadline = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  // 'start' (the companion has not reported a recognised step: nothing can be claimed) -> 'context' ->
  // 'model' (generating) -> 'save' (the companion began saving, or sent a step this proxy does not know).
  let stage = 'start';
  const track = event => {
    if (event?.type !== 'status' || typeof event.text !== 'string') return;
    if (!PRE_SAVE_STATUSES.has(event.text)) stage = 'save';
    else if (stage !== 'save') stage = event.text === MODEL_STATUS ? 'model' : stage === 'start' ? 'context' : stage;
  };
  // The companion's own error event, reworded when its stage proves nothing was saved.
  // #228: the companion names why the model failed in a string `reason` (chat_timeout, length_cap). A
  // reworded event keeps it, so the browser can say the real cause; the browser words it, not this proxy.
  const refine = async event => {
    if (event?.type !== 'error' || event.saved !== undefined || stage === 'save' || stage === 'start') return event;
    const reason = typeof event.reason === 'string' ? { reason: event.reason } : {};
    if (stage === 'model') {
      let found = null;
      try { found = diagnose ? await diagnose() : null; } catch { /* the plain wording below stands */ }
      if (found?.code && MESSAGES[found.code]) return notSaved(found.code, { ...reason, ...Object.fromEntries(Object.entries(found).filter(([key]) => key !== 'code')) });
      return notSaved('modelFailed', reason);
    }
    return notSaved('contextFailed', reason);
  };
  try {
    send({type:'status',text:'Connecting to diary companion…'});
    const headersFor = typeof options.headers === 'function' ? options.headers : () => options.headers;
    const upstream = await withStorageCredential((secret) => fetch(url, {...options, headers:headersFor(secret), signal:controller.signal}));
    if (!upstream.ok || !upstream.body) {
      // The streaming route answers its HTTP errors before any work starts, so a refusal it names (or
      // an ordinary 4xx/503) means this exchange never ran. Gateway-style errors stay unknown.
      let detail = {};
      try { detail = await readCappedJson(upstream, 64 * 1024) || {}; } catch { /* HTML or empty: no detail */ }
      const code = detail.code === 'storageLoginRejected' || upstream.status === 424 ? 'storageLoginRejected'
        : detail.code === 'storageThrottled' ? 'storageThrottled'
        : detail.code === 'storageUpstream' || NOT_STARTED_STATUSES.has(upstream.status) ? 'diaryUnavailable' : null;
      const wait = Number(detail.retryAfter ?? upstream.headers?.get?.('retry-after'));
      const extra = code === 'storageThrottled' && Number.isFinite(wait) && wait > 0 ? { retryAfter: Math.min(Math.ceil(wait), 86400) } : {};
      throw Object.assign(new Error('Diary upstream unavailable'), code ? { failure: notSaved(code, extra) } : {});
    }
    if ((upstream.headers.get('content-type') || '').includes('text/event-stream')) {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of upstream.body) {
        if (res.destroyed && !job) break;
        buffer += decoder.decode(chunk, {stream:true});
        let boundary;
        // Heartbeats must never be inserted inside a fragmented JSON event.
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          let frame = buffer.slice(0, boundary + 2), event = null;
          try { const line = frame.split('\n').find(l => l.startsWith('data: ')); if (line) event = JSON.parse(line.slice(6)); } catch { /* A non-JSON data frame (e.g. `[DONE]`) must not look like an interrupted stream. */ }
          if (event && typeof event === 'object') {
            track(event);
            // #228: `reason` is relayed only as the string the companion sent; anything else is dropped.
            if (event.type === 'error' && 'reason' in event && typeof event.reason !== 'string') {
              const { reason: _dropped, ...rest } = event;
              event = rest; frame = `data: ${JSON.stringify(event)}\n\n`;
            }
            const refined = await refine(event);
            if (refined !== event) { event = refined; frame = `data: ${JSON.stringify(event)}\n\n`; }
            if (onEvent) { try { onEvent(event); } catch { /* Optional telemetry must never break diary capture. */ } }
            if (job) { try { job.event(event); } catch { /* A failed recovery write must not look like an interrupted stream. */ } }
          }
          if (!res.destroyed) res.write(frame);
          buffer = buffer.slice(boundary + 2);
        }
      }
      if (buffer.trim() && (!res.destroyed || job)) throw new Error('Incomplete diary stream');
    } else {
      // Compatibility with a previous sidecar during a rolling upgrade.
      const full = await readCappedJson(upstream, 4 * 1024 * 1024), choice = full.choices?.[0]?.message;
      if (choice) {
        if (choice.reasoning_content) send({type:'reasoning',text:choice.reasoning_content});
        if (!choice.content) throw new Error('No companion answer');
        send({type:'answer',text:choice.content});
        send({type:'diary',...full.diary});
      } else {
        if (typeof full.reply !== 'string') throw new Error('No companion answer');
        if (full.reasoning) send({type:'reasoning',text:full.reasoning});
        send({type:'answer',text:full.reply});
        send({type:'diary',...full});
      }
      send({type:'done'});
    }
  } catch (error) {
    // No connection at all (refused, unresolvable) also means the request was never delivered.
    const failure = error?.failure || (CONNECT_REFUSED.has(error?.cause?.code) ? notSaved('diaryUnavailable') : null);
    try { send(failure || {type:'error',text:'The diary connection was interrupted. The entry may still be saving; check the saved diary before sending again.'}); } catch { /* Failed recovery storage must not turn into an unhandled rejection. */ }
  } finally {
    clearInterval(heartbeat); clearTimeout(deadline); res.off('close', close);
    try { job?.finish(); } catch { /* A running record will recover as uncertain after restart. */ }
    if (!res.destroyed) res.end();
  }
}
module.exports = {proxyDiaryStream, notSaved};
