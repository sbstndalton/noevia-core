'use strict';
// The Diary's HTTP surface (diary.cjs holds the sidecar client). Three mounts, because the
// router places them apart:
//   connector   POST /api/diary-connector — a connected app's credential, checked here, not a
//               session; mounted BEFORE the session and CSRF checks and refuses any browser origin
//   connectors  /api/profile/diary-connectors[/:id] — list, create and revoke those credentials
//   diary       /api/diary/* — recovery records, workspace trash/import/export, storage status
//               and import, files and the local exchange, the corpus reads, the operator import
//               folders and the journaled entry edit; every one gated on the Diary add-on
//
// Each returns true when it handled the request. Blocks keep their original order and an
// unmatched method falls through as it did inline.

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
 * @param {{ rateLimited: (key:string, limit:number, windowMs:number) => boolean }} deps.connectorRate
 * @param {object} deps.diaryConnectors   diary-connectors.cjs credentials (verify, list, create, revoke)
 * @param {object} deps.diary             diary.cjs: diaryHeaders, corpusSource, connectorFiles
 */
function createDiaryRoutes({ json, readBody, readJson, fetchJson, DIARY_BASE, authService, currentWorkspace, rateLimited, connectorRate, diaryConnectors, diary, clientAddress = (req) => req.socket?.remoteAddress }) {
  const { diaryHeaders, corpusSource, connectorFiles } = diary;

  async function connector(req, res, { path: p }) {
    if(p==='/api/diary-connector') {
      res.setHeader('Cache-Control','no-store');
      if(req.method!=='POST')return json(res,405,{error:'POST required'});
      if(req.headers.origin)return json(res,403,{error:'Use the authenticated connector client'});
      if(connectorRate.rateLimited('diary-connector:'+String(clientAddress(req)||'unknown'),120,60000))return json(res,429,{error:'Try later'});
      const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
      const identity=diaryConnectors.verify(token);
      if(!identity)return json(res,401,{error:'Diary connector credential required'});
      const body=await readJson(req,4*1024*1024);
      const result=await require('../diary-connectors.cjs').operate(identity,body,connectorFiles,()=>!!diaryConnectors.verify(token));
      if(body.action==='write')authService.audit('diary-connector.write',identity.userId,identity.userId,{credentialId:identity.id,path:body.path,bytes:Buffer.byteLength(body.content)});
      return json(res,200,result);
    }
    return PASS;
  }

  async function connectors(req, res, { path: p, authn }) {
    if(p==='/api/profile/diary-connectors' && req.method==='GET')return json(res,200,{connectors:diaryConnectors.list(authn.user.id)});
    if(p==='/api/profile/diary-connectors' && req.method==='POST')return json(res,201,diaryConnectors.create(authn.user.id,(await readJson(req)).name));
    const revokeConnector=p.match(/^\/api\/profile\/diary-connectors\/([a-f0-9]{32})$/);
    if(revokeConnector && req.method==='DELETE')return json(res,200,{revoked:diaryConnectors.revoke(authn.user.id,revokeConnector[1])});
    return PASS;
  }

  async function handle(req, res, { path: p, authn, url }) {
    if(p==='/api/diary/exchanges' && req.method==='GET') {
      if(!authService.diaryEnabled(authn.user.id))return json(res,404,{error:'Diary add-on is disabled'});
      try{return json(res,200,{exchanges:require('../diary-jobs.cjs').list(currentWorkspace(),url.searchParams.get('day'))});}
      catch(e){return json(res,e.status||500,{error:e.status?e.message:'Could not read recovery records'});}
    }

    if (p === '/api/diary/workspace-trash') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
      const body = req.method === 'POST' ? await readBody(req, 4096) : undefined;
      const query = req.method === 'GET' ? '?after=' + encodeURIComponent(url.searchParams.get('after') || '') : '';
      const r = await fetchJson(`${DIARY_BASE}/api/workspace-trash${query}`, { method: req.method, headers: diaryHeaders(), body }, 60000);
      res.setHeader('Cache-Control', 'no-store');
      return json(res, r.status, r.ok ? r.body : { error: r.body?.detail || 'Diary recovery request failed. Retry or refresh Trash.' });
    }

    if (p === '/api/diary/workspace-import') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      return require('../workspace-import.cjs').proxyWorkspaceImport(req, res, `${DIARY_BASE}/api/workspace-import${url.search}`, diaryHeaders());
    }

    if (p === '/api/diary/workspace-export') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      return require('../workspace-export.cjs').proxyWorkspaceExport(res, `${DIARY_BASE}/api/workspace-export`, diaryHeaders());
    }

    if (['/api/diary/storage-status', '/api/diary/storage-import'].includes(p)) {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const status = p.endsWith('storage-status');
      if (req.method !== (status ? 'GET' : 'POST')) return json(res, 405, { error: 'Method not allowed' });
      const body = status ? undefined : await readBody(req, 4096);
      const r = await fetchJson(`${DIARY_BASE}/api/${status ? 'storage-status' : 'storage-import'}`, { method: req.method, headers: diaryHeaders(), body }, status ? 60000 : 300000);
      return json(res, r.status, r.ok ? r.body : { error: r.body?.detail || 'Diary storage request failed' });
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
        return require('../diary-stream.cjs').proxyDiaryStream(res, `${DIARY_BASE}/api${suffix}`, {
          method:'POST', headers:diaryHeaders(), body,
        }, {onEvent:event=>{if(event.type==='mtp')require('../mtp.cjs').record(authn.user.id,event.model,event.timings);}});
      }
      const r = await fetchJson(`${DIARY_BASE}/api${suffix}`, { method: req.method, headers: diaryHeaders(), body }, local ? 600000 : 60000);
      return json(res, r.status, r.ok ? r.body : { error: r.body?.detail || r.body?.error || 'Diary storage request failed' });
    }

    if (p === '/api/diary/source') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const months = await corpusSource.listMonths();
      return json(res, 200, { source: corpusSource.name, months });
    }

    if (p === '/api/diary/today' || p === '/api/diary/history') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const monthId = url.searchParams.get('month');
      const data = await corpusSource.readMonth(monthId);
      return json(res, 200, data);
    }

    if (p === '/api/diary/external-sources') {
      if (authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required for server import folders' });
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const r = await fetchJson(`${DIARY_BASE}/api/external-sources`, { headers: diaryHeaders() }, 30000);
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
      const r = await fetchJson(
        `${DIARY_BASE}/api/external-sources/import`,
        { method: 'POST', headers: diaryHeaders(), body: JSON.stringify({ source_path: body.sourcePath, rel_path: body.relPath }) },
        60000,
      );
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
      const r = await fetchJson(
        `${DIARY_BASE}/api/entries/edit`,
        { method: 'POST', headers: diaryHeaders(), body: JSON.stringify(forward) },
        60000,
      );
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
  return { connector: mount(connector), connectors: mount(connectors), diary: mount(handle) };
}

module.exports = { createDiaryRoutes };
