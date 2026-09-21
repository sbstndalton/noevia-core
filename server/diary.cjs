'use strict';
// ── The Diary sidecar, as seen from noevia ────────────────────────────────
// Every call to the diary-companion carries the tenant: diaryHeaders() puts
// the user id, the legacy-owner marker and the user's own storage descriptor
// on the request, or a blocked descriptor when that storage fails the
// member-origin policy. The corpus-source adapter is the Diary tab's read
// side; callDiaryFile runs one file operation as a given user for the
// connector bridge (diary-connectors.cjs) and the DAV listener.
//
// Nothing here writes on its own: writes go through the sidecar's own
// journaled endpoints, and the connector bridge only forwards what a
// verified credential asked for.

/**
 * @param {object} deps
 * @param {object} deps.fs
 * @param {object} deps.path
 * @param {(url:string, init:object, timeoutMs?:number) => Promise<{ok:boolean,status:number,body:any}>} deps.fetchJson
 * @param {string} deps.DIARY_BASE
 * @param {string} deps.DIARY_TOKEN
 * @param {string} deps.DIARY_SOURCE
 * @param {object} deps.requestScope        AsyncLocalStorage carrying { workspace, authn }
 * @param {object} deps.authService
 * @param {(authn, url:string) => boolean} deps.endpointApproved
 * @param {{ get: (userId:string) => object }} deps.workspaceStore
 */
function createDiary({ fs, path, fetchJson, DIARY_BASE, DIARY_TOKEN, DIARY_SOURCE, requestScope, authService, endpointApproved, workspaceStore }) {
  function diaryHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (DIARY_TOKEN) h.Authorization = `Bearer ${DIARY_TOKEN}`;
    const workspace = requestScope.getStore()?.workspace;
    if (workspace) {
      h['X-Cowork-User-ID'] = workspace.userId;
      if (fs.existsSync(path.join(workspace.dir, 'migration.json'))) h['X-Cowork-Legacy-Owner'] = '1';
      const storage = authService.getStorage(workspace.userId, true);
      if (storage.kind !== 'local' && !endpointApproved(requestScope.getStore()?.authn, storage.baseUrl)) {
        // The sidecar may serve an already-active app diary, but must never
        // resolve a legacy remote or send credentials to this rejected endpoint.
        h['X-Cowork-Storage-Blocked'] = '1';
        h['X-Cowork-Storage'] = Buffer.from(JSON.stringify({ kind: 'blocked' })).toString('base64url');
        return h;
      }
      h['X-Cowork-Storage'] = Buffer.from(JSON.stringify(storage)).toString('base64url');
    }
    return h;
  }

  // ── Corpus-source adapter (Diary tab reads) ────────────────────────────────
  // Contract: listMonths() → [{id,label}]; readMonth(id) → {todayLog, standing}.
  // v1 source: 'sidecar' (Nextcloud via diary-companion's read API). Planned:
  // 'local' (DIARY_LOCAL_DIR) when/if the corpus moves off Nextcloud. WRITES are
  // never here — they go through the sidecar pipeline via the diary alias.
  const corpusSource =
    DIARY_SOURCE === 'sidecar'
      ? {
          name: 'sidecar',
          async listMonths() {
            // Real month list from the sidecar (PROPFIND over the corpus dir).
            // Returns only months that actually have a corpus file — the client
            // synthesizes a "Today" entry itself, and a first-run user must see
            // an empty list so the diary zero-state can trigger. Tolerant: on
            // failure, return an empty list (today's file still renders when
            // navigated to directly).
            try {
              const r = await fetchJson(`${DIARY_BASE}/api/months`, { headers: diaryHeaders() }, 15000);
              return (r.ok && Array.isArray(r.body?.months) ? r.body.months : [])
                .filter((m) => m && typeof m.id === 'string' && /^\d{4}-\d{2}$/.test(m.id))
                .map((m) => ({ id: m.id, label: m.label || m.id }))
                .sort((a, b) => a.id.localeCompare(b.id));
            } catch {
              return [];
            }
          },
          async readMonth(monthId) {
            const q = monthId ? `?month=${encodeURIComponent(monthId)}` : '';
            const r = await fetchJson(`${DIARY_BASE}/api/day${q}`, { headers: diaryHeaders() }, 15000);
            if (!r.ok) throw new Error(`sidecar ${r.status}`);
            // Whole-month mode returns { month, log }; today mode returns { today_log }.
            const log = (r.body && (r.body.log ?? r.body.today_log)) || '';
            return { todayLog: log, standing: (r.body && r.body.standing) || '' };
          },
        }
      : {
          name: DIARY_SOURCE,
          async listMonths() {
            throw new Error(`corpus source '${DIARY_SOURCE}' not implemented yet (planned: local)`);
          },
          async readMonth() {
            throw new Error(`corpus source '${DIARY_SOURCE}' not implemented yet (planned: local)`);
          },
        };

  async function callDiaryFile(userId, endpoint, method, body) {
    const workspace = workspaceStore.get(userId);
    const user = authService.publicUser(authService.db.prepare('SELECT * FROM users WHERE id=? AND disabled_at IS NULL').get(userId));
    if(!user || !authService.diaryEnabled(userId))throw Object.assign(Error('Diary unavailable'),{status:403});
    return requestScope.run({workspace,authn:{user,legacy:false}},async()=>{
      const r=await fetchJson(`${DIARY_BASE}/api${endpoint}`,{method,headers:diaryHeaders(),body:body===undefined?undefined:JSON.stringify(body)},60000);
      if(!r.ok)throw Object.assign(Error(r.body?.detail || 'Diary request interrupted; read the current version before retrying a write'),{status:r.status||502});
      return r.body;
    });
  }
  const connectorFiles={
    list:async(id,path)=>(await callDiaryFile(id,'/files?path='+encodeURIComponent(path),'GET')).files,
    read:(id,path)=>callDiaryFile(id,'/file','POST',{path}),
    write:(id,body)=>callDiaryFile(id,'/file','PUT',body),
  };

  return { diaryHeaders, corpusSource, callDiaryFile, connectorFiles };
}

module.exports = { createDiary };
