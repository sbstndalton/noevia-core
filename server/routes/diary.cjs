'use strict';
// The local exchange stays in this process (diary.cjs holds the sidecar client):
// POST /api/diary/local-exchange retains the shared inference gate and throttle.
// Other Diary proxies are owned by the paired front and refused by rust-diary.cjs.
//
// Returns true when it handled the request. Blocks keep their original order and an unmatched
// method falls through as it did inline.

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req) => Promise<any>} deps.readJson
 * @param {(url:string, init:object, timeoutMs?:number) => Promise<{ok:boolean,status:number,body:any}>} deps.fetchJson
 * @param {string} deps.DIARY_BASE
 * @param {object} deps.authService
 * @param {(userId:string) => boolean} deps.rateLimited      the shared LLM throttle, for the local exchange
 * @param {object} deps.diary             diary.cjs: diaryHeaders, corpusSource, diaryFetchJson, withStorageCredential
 */
function createDiaryRoutes({ json, readJson, fetchJson, DIARY_BASE, authService, rateLimited, diary }) {
  const { diaryHeaders } = diary;
  const log = diary.log || ((line) => console.info(line));
  // Older fakes pass only diaryHeaders; fall back to a single send without the 428 retry.
  const diaryFetchJson = diary.diaryFetchJson || ((url, { method = 'GET', body, storageRetry = false } = {}, timeoutMs) => fetchJson(url, { method, headers: diaryHeaders(method, url, { body, storageRetry }), body }, timeoutMs));

  // #2232: a Diary that cannot be reached is a status the page can word, not a bare 500. The call
  // throws (connection refused, a stalled reply); nothing of the error is passed on.
  const unavailable = (res) => json(res, 503, { error: 'Diary is unavailable right now. Try again shortly.', code: 'diaryUnavailable' });
  // Only a network or abort failure is "unavailable"; fetchJson uses redirect:'error', and the call also builds the
  // tenant headers and signs, so a redirect or a throw there is a bug and stays the generic 500 (logged by class).
  // Socket codes (ECONNREFUSED, ETIMEDOUT), resolver codes (EAI_AGAIN) and undici's; not Node's ERR_* (ERR_INVALID_URL: a bad DIARY_BASE, TLS faults), which are bugs. The one exception is
  // ERR_SOCKET_CONNECTION_TIMEOUT: Node documents it as no address answering within the family auto-selection timeout, a connect timeout (#2255).
  const NETWORK = /^(E[A-Z0-9]+|EAI_[A-Z]+|UND_ERR_[A-Z_]+|ERR_SOCKET_CONNECTION_TIMEOUT)$/;
  const isUnreachable = (e) => e?.name === 'AbortError' || e?.name === 'TimeoutError' || (e instanceof TypeError && NETWORK.test(String(e.cause?.code || '')));
  const reach = async (res, call) => {
    try { return await call(); } catch (e) {
      log(`[diary] sidecar call failed: ${e?.name || 'Error'}${e?.cause?.code ? ' ' + e.cause.code : ''}${isUnreachable(e) ? ' (unavailable)' : ' (internal)'}`);
      if (isUnreachable(e)) { unavailable(res); return null; }
      throw e;
    }
  };

  async function handle(req, res, { path: p, authn, url }) {
    if (p === '/api/diary/local-exchange') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      if (rateLimited(authn.user.id)) return json(res, 429, { error: 'Please wait before sending another message' });
      const parsed = await readJson(req, 16 * 1024 * 1024);
      const body = JSON.stringify(parsed);
      const suffix = '/local-exchange';
      if (parsed?.stream === true) {
        const target = `${DIARY_BASE}/api${suffix}`;
        return require('../diary-stream.cjs').proxyDiaryStream(res, target, {
          method:'POST', headers:(secret)=>diaryHeaders('POST', target, { secret, body }), body,
        }, {withStorageCredential:diary.withStorageCredential});
      }
      const r = await reach(res, () => diaryFetchJson(`${DIARY_BASE}/api${suffix}`, { method: req.method, body }, 600000));
      if (!r) return;
      if (r.ok) return json(res, r.status, r.body);
      // #849 / #1166: the sidecar tags a storage login the server refused (424 storageLoginRejected) and a
      // storage server that is throttling us (503 storageThrottled + Retry-After). The code and the wait
      // are passed on so the browser words them in the interface language. Nothing else is passed.
      const error = r.body?.detail || r.body?.error || 'Diary storage request failed';
      if (r.body?.code === 'storageThrottled') {
        const wait = Number(r.body.retryAfter);
        const retryAfter = Number.isFinite(wait) && wait > 0 ? Math.min(Math.ceil(wait), 86400) : null;
        return json(res, r.status, { error, code: 'storageThrottled', ...(retryAfter ? { retryAfter } : {}) }, retryAfter ? { 'Retry-After': String(retryAfter) } : undefined);
      }
      return json(res, r.status, { error, ...(r.body?.code === 'storageLoginRejected' ? { code: r.body.code } : {}) });
    }

    return PASS;
  }

  const mount = (fn) => async (req, res, ctx) => (await fn(req, res, ctx)) !== PASS;
  return { diary: mount(handle) };
}

module.exports = { createDiaryRoutes };
