'use strict';
// The Diary's HTTP surface that stays in this process (diary.cjs holds the sidecar client):
//   diary   /api/diary/* — workspace trash, files and the local exchange, the history read, the
//           operator import folders and the journaled entry edit; every one gated on the Diary add-on.
// The rest is the Rust front's: the corpus source and day reads, the storage import and the workspace
// import and export (#2185, rust-diary.cjs), and the storage status, the recovery records, the Diary
// context, the connector endpoint and the connector credentials (#2206, rust-diary-routes.cjs).
// What keeps the local exchange here is the model throttle chat shares and the inference gate.
//
// Returns true when it handled the request. Blocks keep their original order and an unmatched
// method falls through as it did inline.

const PASS = Symbol('unhandled');

/**
 * @param {object} deps
 * @param {(res, status, body) => any} deps.json
 * @param {(req, limit?:number) => Promise<string>} deps.readBody
 * @param {(req) => Promise<any>} deps.readJson
 * @param {(url:string, init:object, timeoutMs?:number) => Promise<{ok:boolean,status:number,body:any}>} deps.fetchJson
 * @param {string} deps.DIARY_BASE
 * @param {object} deps.authService
 * @param {() => object} deps.currentWorkspace
 * @param {(userId:string) => boolean} deps.rateLimited      the shared LLM throttle, for the local exchange
 * @param {object} deps.diary             diary.cjs: diaryHeaders, corpusSource, diaryFetchJson, withStorageCredential
 * @param {object} [deps.storageLatch]    storage-latch.cjs: an explicit Retry that works clears the hold (#1589)
 */
function createDiaryRoutes({ json, readBody, readJson, fetchJson, DIARY_BASE, authService, currentWorkspace, rateLimited, diary, storageLatch = null }) {
  const { diaryHeaders, corpusSource } = diary;
  const log = diary.log || ((line) => console.info(line));
  // Older fakes pass only diaryHeaders; fall back to a single send without the 428 retry.
  const diaryFetchJson = diary.diaryFetchJson || ((url, { method = 'GET', body, storageRetry = false } = {}, timeoutMs) => fetchJson(url, { method, headers: diaryHeaders(method, url, { body, storageRetry }), body }, timeoutMs));

  // #2232: a Diary that cannot be reached is a status the page can word, not a bare 500. The call
  // throws (connection refused, a stalled reply); nothing of the error is passed on.
  const unavailable = (res) => json(res, 503, { error: 'Diary is unavailable right now. Try again shortly.', code: 'diaryUnavailable' });
  // Only a network or abort failure is "unavailable"; fetchJson uses redirect:'error', and the call also builds the
  // tenant headers and signs, so a redirect or a throw there is a bug and stays the generic 500 (logged by class).
  const NETWORK = /^(E[A-Z0-9_]+|UND_ERR_[A-Z_]+)$/;
  const isUnreachable = (e) => e?.name === 'AbortError' || e?.name === 'TimeoutError' || (e instanceof TypeError && NETWORK.test(String(e.cause?.code || '')));
  const reach = async (res, call) => {
    try { return await call(); } catch (e) {
      log(`[diary] sidecar call failed: ${e?.name || 'Error'}${e?.cause?.code ? ' ' + e.cause.code : ''}${isUnreachable(e) ? ' (unavailable)' : ' (internal)'}`);
      if (isUnreachable(e)) { unavailable(res); return null; }
      throw e;
    }
  };

  async function handle(req, res, { path: p, authn, url }) {
    if (p === '/api/diary/workspace-trash') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
      const body = req.method === 'POST' ? await readBody(req, 4096) : undefined;
      const query = req.method === 'GET' ? '?after=' + encodeURIComponent(url.searchParams.get('after') || '') : '';
      const r = await reach(res, () => diaryFetchJson(`${DIARY_BASE}/api/workspace-trash${query}`, { method: req.method, body }, 60000));
      if (!r) return;
      res.setHeader('Cache-Control', 'no-store');
      return json(res, r.status, r.ok ? r.body : { error: r.body?.detail || 'Diary recovery request failed. Retry or refresh Trash.' });
    }

    if (['/api/diary/files', '/api/diary/file', '/api/diary/local-exchange'].includes(p)) {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const local = p.endsWith('/local-exchange');
      const listing = p.endsWith('/files');
      if (!(listing ? req.method === 'GET' : local ? req.method === 'POST' : ['POST', 'PUT'].includes(req.method))) return json(res, 405, { error: 'Method not allowed' });
      if (local && rateLimited(authn.user.id)) return json(res, 429, { error: 'Please wait before sending another message' });
      const parsed = local ? await readJson(req, 16 * 1024 * 1024) : undefined;
      const body = local ? JSON.stringify(parsed) : listing ? undefined : await readBody(req, 1024 * 1024);
      const suffix = listing ? '/files?path=' + encodeURIComponent(url.searchParams.get('path') || '') : local ? '/local-exchange' : '/file';
      if (local && parsed?.stream === true) {
        const target = `${DIARY_BASE}/api${suffix}`;
        return require('../diary-stream.cjs').proxyDiaryStream(res, target, {
          method:'POST', headers:(secret)=>diaryHeaders('POST', target, { secret, body }), body,
        }, {withStorageCredential:diary.withStorageCredential});
      }
      // #1168: only an explicit Retry press (the browser sends X-Cowork-Storage-Retry: 1) may reset the
      // sidecar's rejected-login cool-down; every automatic read goes without it.
      const storageRetry = !local && req.headers['x-cowork-storage-retry'] === '1';
      // #1198: live QA could not tell whether a Retry press reached this point. Method, route and the
      // account's id only: no path, no storage address, no credential.
      if (storageRetry) log(`[diary] forwarding X-Cowork-Storage-Retry: 1 (${req.method} ${p}, user ${authn.user.id})`);
      const r = await reach(res, () => diaryFetchJson(`${DIARY_BASE}/api${suffix}`, { method: req.method, body, storageRetry }, local ? 600000 : 60000));
      if (!r) return;
      if (r.ok) {
        // #1589: an explicit Retry that works proves the saved login is good, so automatic calls resume.
        // #1607: but only when the listing really went to the storage server. A Diary account kept in the app
        // (managed mode) answers /files and /file from its own database and never contacts Nextcloud
        // (diary/agent/app.py workspace_files -> ManagedCorpusBackend.list_dir), so that reply proves nothing
        // about the saved login; the Diary's own storage-status tells which kind of account this is.
        if (storageRetry && storageLatch) {
          let reachedStorage = false;
          try {
            const st = await diaryFetchJson(`${DIARY_BASE}/api/storage-status`, { method: 'GET' }, 60000);
            reachedStorage = !!(st.ok && st.body && st.body.mode === 'legacy');
          } catch { /* unknown: the hold stays */ }
          if (reachedStorage) { try { storageLatch.clear(authn.user.id); } catch { /* the hold stays */ } }
        }
        return json(res, r.status, r.body);
      }
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

    // /api/diary/source and /api/diary/today are the Rust front's (rust-diary.cjs); /history is the same
    // read under the name the web client does not use, and stays here.
    if (p === '/api/diary/history') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const monthId = url.searchParams.get('month');
      const data = await reach(res, () => corpusSource.readMonth(monthId));
      if (!data) return;
      return json(res, 200, data);
    }

    if (p === '/api/diary/external-sources') {
      if (authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required for server import folders' });
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const r = await reach(res, () => diaryFetchJson(`${DIARY_BASE}/api/external-sources`, {}, 30000));
      if (!r) return;
      if (!r.ok) return json(res, r.status >= 500 ? 502 : r.status, { error: `diary sidecar ${r.status}` });
      return json(res, 200, r.body);
    }

    if (p === '/api/diary/external-sources/import' && req.method === 'POST') {
      if (authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required for server import folders' });
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body || typeof body.sourcePath !== 'string' || typeof body.relPath !== 'string') {
        return json(res, 400, { error: 'sourcePath and relPath required' });
      }
      const r = await reach(res, () => diaryFetchJson(
        `${DIARY_BASE}/api/external-sources/import`,
        { method: 'POST', body: JSON.stringify({ source_path: body.sourcePath, rel_path: body.relPath }) },
        60000,
      ));
      if (!r) return;
      if (!r.ok) {
        const detail = r.body?.detail || `diary sidecar ${r.status}`;
        return json(res, r.status >= 500 ? 502 : r.status, { error: String(detail) });
      }
      return json(res, 200, r.body);
    }

    if (p === '/api/diary/entries/edit' && req.method === 'POST') {
      // Diary integrity guarantee: editing past entries is an explicit,
      // human-initiated correction routed to the sidecar's guarded, journaled
      // edit endpoint. The assistant never rewrites the user's own words on
      // its own; the xid identifies exactly one logged exchange.
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body || typeof body.xid !== 'string' || typeof body.me !== 'string' || (body.assistant !== undefined && typeof body.assistant !== 'string')) {
        return json(res, 400, { error: 'xid and me required' });
      }
      if (body.base_hash !== undefined && body.base_hash !== null && typeof body.base_hash !== 'string') {
        return json(res, 400, { error: 'base_hash must be a string' });
      }
      const forward = { xid: body.xid, me: body.me, assistant: body.assistant || '', month: body.month || null };
      // Optimistic concurrency: pass the loaded exchange's hash through so the
      // sidecar can refuse a stale edit instead of silently overwriting.
      if (typeof body.base_hash === 'string') forward.base_hash = body.base_hash;
      const r = await reach(res, () => diaryFetchJson(
        `${DIARY_BASE}/api/entries/edit`,
        { method: 'POST', body: JSON.stringify(forward) },
        60000,
      ));
      if (!r) return;
      // A 409 edit conflict carries current_hash/current_text the client needs
      // to keep the draft and re-base; relay that body unchanged.
      if (r.status === 409 && r.body && r.body.conflict === true) return json(res, 409, r.body);
      if (!r.ok) {
        const detail = r.body?.detail || r.body?.error || `diary sidecar ${r.status}`;
        return json(res, r.status >= 500 ? 502 : r.status, { error: String(detail) });
      }
      return json(res, 200, r.body);
    }
    return PASS;
  }

  const mount = (fn) => async (req, res, ctx) => (await fn(req, res, ctx)) !== PASS;
  return { diary: mount(handle) };
}

module.exports = { createDiaryRoutes };
