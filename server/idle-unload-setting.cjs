'use strict';
// noevia#1863: how long an idle chat model stays loaded before llama.cpp frees it (#1747), as an
// admin setting under Settings → Models. Default 30 min; CHAT_MODEL_IDLE_UNLOAD_SECONDS (on the
// model loader) seeds it; 0 is "Never".
//
// The model manager owns the value and the chat preset's `[*] sleep-idle-seconds` key
// (`GET/PUT /api/v1/idle-unload`, noevia-rs#130); it keeps the admin's choice across its own
// restarts and every models.ini save. llama.cpp passes the key to a model's process when it
// starts it, and the router only re-reads presets on a reload, so after a change this asks the
// router to reload (reloadPresets, #1012). With a model running, a reload would unload it: that
// is refused here and the admin is offered "Apply now" (POST /api/models/presets/reload with
// unload), exactly as other preset changes are. Any model the router runs (loaded, loading or
// sleeping after its idle time) blocks that reload, so a save is usually NOT live yet: `applied`
// says whether the router is known to run on the saved value (see presetsInRouter), and it is
// computed on every GET, so it survives a page reload. #2219: the write and the reload share one
// maintenance hold (writePresets); a refused hold is a 409 and the file stays as it was.

/** The `[*]` `sleep-idle-seconds` value in a models.ini text, as the model manager writes it
 *  (noevia-rs idle_unload.rs: `ident = value`, optional leading dashes; no key means Never, 0).
 *  null when the text has a value that is not a whole number. */
function globalIdleSeconds(text) {
  let inGlobal = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) { inGlobal = line === '[*]'; continue; }
    if (!inGlobal) continue;
    const at = raw.indexOf('=');
    if (at < 0) continue;
    const key = raw.slice(0, at).trim().replace(/^--?/, '');
    if (key !== 'sleep-idle-seconds') continue;
    const value = raw.slice(at + 1).trim();
    return /^\d+$/.test(value) ? Number(value) : null;
  }
  return 0;
}

const MIN_SECONDS = 300, MAX_SECONDS = 86400, DEFAULT_SECONDS = 1800;

/** null clears the admin choice (back to the deployment value); 0 is Never. */
function validSeconds(value) {
  if (value === null) return true;
  return Number.isInteger(value) && (value === 0 || (value >= MIN_SECONDS && value <= MAX_SECONDS));
}

function view(body) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const source = ['setting', 'env', 'default'].includes(body?.source) ? body.source : null;
  const seconds = n(body?.seconds);
  if (seconds === null || source === null) return null;
  return {
    seconds, source,
    fallbackSeconds: n(body.fallbackSeconds), fallbackSource: ['env', 'default'].includes(body.fallbackSource) ? body.fallbackSource : null,
    defaultSeconds: n(body.defaultSeconds) ?? DEFAULT_SECONDS,
    minSeconds: n(body.minSeconds) ?? MIN_SECONDS, maxSeconds: n(body.maxSeconds) ?? MAX_SECONDS,
  };
}

function createIdleUnloadSetting({ env = process.env, fetchJson, reloadPresets = null, writePresets = null, presetsInRouter = null, audit = () => {} } = {}) {
  const base = () => String(env.MODEL_LOADER_URL || '').replace(/\/+$/, '');
  const headers = () => ({ 'Content-Type': 'application/json', ...(env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : {}) });
  const fail = (status, error, errorId) => Object.assign(Error(error), { status, errorId });
  const call = async (method, body) => {
    if (!base()) throw fail(404, 'The idle unload setting needs the model manager.', 'idleUnloadUnavailable');
    let r;
    try { r = await fetchJson(`${base()}/api/v1/idle-unload`, { method, headers: headers(), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, 30000); }
    catch { r = null; }
    // An older model manager has no such route.
    if (r?.status === 404 || r?.status === 405) throw fail(404, 'This model manager cannot change the idle unload time yet.', 'idleUnloadUnavailable');
    if (r?.status === 400) throw fail(400, `Choose Never or a time from ${MIN_SECONDS / 60} minutes to ${MAX_SECONDS / 3600} hours.`, 'idleUnloadInvalid');
    if (r?.status === 503) throw fail(503, 'The model manager has no place to keep this setting.', 'idleUnloadUnavailable');
    if (!r?.ok) throw fail(502, 'The model manager did not answer. Try again in a moment.', 'idleUnloadEngine');
    const v = view(r.body);
    if (!v) throw fail(502, 'The model manager gave an unexpected answer.', 'idleUnloadEngine');
    return { view: v, preset: ['written', 'unchanged', 'failed'].includes(r.body?.preset) ? r.body.preset : null };
  };

  /** Is the router known to run on `seconds`? false when it runs on another value or that is
   *  unknowable (it re-read the file on its own since noevia's last reload). */
  async function applied(seconds) {
    if (typeof presetsInRouter !== 'function') return false;
    let text = null;
    try { text = await presetsInRouter(); } catch { text = null; }
    return typeof text === 'string' && globalIdleSeconds(text) === seconds;
  }

  async function get() { const { view: v } = await call('GET'); return { ...v, applied: await applied(v.seconds) }; }

  async function save(body, actor) {
    const seconds = body && Object.prototype.hasOwnProperty.call(body, 'seconds') ? body.seconds : undefined;
    if (!validSeconds(seconds)) throw Object.assign(fail(400, `Choose Never or a time from ${MIN_SECONDS / 60} minutes to ${MAX_SECONDS / 3600} hours.`, 'idleUnloadInvalid'), { minSeconds: MIN_SECONDS, maxSeconds: MAX_SECONDS });
    // For the audit only: read just before the write, so a concurrent save by another
    // administrator between the two calls can make it stale. Accepted: the model manager has one
    // writer route and saves are rare; the audit's `seconds` (from the PUT answer) is exact.
    let previous = null;
    try { previous = (await call('GET')).view.seconds; } catch { previous = null; }
    const put = () => call('PUT', { seconds });
    // #2219: with a gate, the write and its reload run under one hold; a refused hold changes nothing.
    let written, r = null, askReload = typeof reloadPresets === 'function';
    if (typeof writePresets === 'function') {
      askReload = false;
      try {
        const held = await writePresets(put, (w) => w.preset !== 'failed');
        written = held.written; r = held.reload;
      } catch (e) {
        if (e?.holdRefused) throw fail(409, 'Models are busy, so the idle unload time was not changed. Try again shortly.', 'idleUnloadBusy');
        throw e;
      }
    } else written = await put();
    const { view: next, preset } = written;
    audit('models.idle_unload', actor, { seconds: next.seconds, source: next.source, previous });
    // Make the router read the new key. Running models keep their old timer until they restart.
    if (preset !== 'failed' && askReload) { try { r = await reloadPresets({ unload: false }); } catch { r = null; } }
    let apply;
    if (preset === 'failed') apply = { state: 'failed' };
    else apply = r?.ok ? { state: 'applied' } : { state: 'pending', ...(Array.isArray(r?.body?.loaded) ? { loaded: r.body.loaded.filter((x) => typeof x === 'string') } : {}) };
    return { ...next, apply, applied: apply.state === 'applied' ? await applied(next.seconds) : false };
  }

  return { get, save };
}

module.exports = { createIdleUnloadSetting, validSeconds, globalIdleSeconds, MIN_SECONDS, MAX_SECONDS, DEFAULT_SECONDS };
