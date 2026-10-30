'use strict';
// Test support for sbstndalton/noevia#1071: the Rust front's project store (noevia-rs
// bins/noevia-server src/project_store.rs, crates/server-projects store_api.rs) as a loopback HTTP
// stand-in, for tests and tools that run server/index.cjs without the front. Node writes
// projects.json and free-chats.json only through that store and refuses to start without one, so
// every such run needs it. Same protocol and answers as the Rust store:
//
//   POST /v1/read  { user, file }                  -> 200 { version, text|null }
//   POST /v1/write { user, file, version, text }   -> 200 { version } | 409 { version, text }
//   header x-noevia-store-token (else 401); a missing user directory is 410 (never created);
//   the version is the SHA-256 hex of the file's bytes, '' for a missing file.
//
// and a chat's transcript (sbstndalton/noevia#1071 slice 4; noevia-rs crates/server-projects
// transcript.rs), `chat` reduced to [A-Za-z0-9_-], the revision sha256 hex of JSON.stringify(history):
//
//   POST /v1/history/read  { user, chat }                 -> 200 { history, revision, exists }
//   POST /v1/history/write { user, chat, history, baseRevision?, ifAbsent?, supersedePartial? }
//        -> 200 { revision } | 409 { history, revision, exists, proposedRevision }
//         | 410 { error, code: 'CHAT_DELETED' } (tombstoned)
//   POST /v1/history/append-if-last { user, chat, message, entry } -> 200 { outcome, revision? }
//   POST /v1/history/remove-if { user, chat, history }    -> 200 { removed }
//
// and its chat change journal (sbstndalton/noevia#2153; noevia-rs journal.rs): each mutation above
// takes an optional `origin` (history|import|turn|remove|other; absent/null: other; else 400,
// nothing changed) and appends `{ seq, chatId, revision, op, origin, start, at }` to the user's
// chat-changes.jsonl, which
//
//   POST /v1/changes/read { user, after? }   -> 200 { entries, oldestSeq, latestSeq, more, start }
//
// answers (no rotation here) when the store is started with `{ changes: true }`; otherwise that op
// is 404, as an older front answers it, so a Node loaded against the stand-in leaves its journal
// reader idle (the default for every test that only needs the store).
//
// and a chat's whole delete (sbstndalton/noevia#1071 slice 6; noevia-rs chat_delete.rs):
//
//   POST /v1/chat/delete { user, chat, kind: free|project|unlisted, projectId?, origin? }
//        -> 200 { deleted, swept, leftovers } | 409 { error, code: 'CHAT_LISTED' }
//
// the tombstone (raw and reduced id), the list without the chat (`c.id === chat`), then the
// transcript, context meter, brain note and saved partial (raw and reduced id); a failed list
// write takes back the tombstone ids it added. A chat in no list that is already tombstoned is
// swept (its files removed). Journalled as op `remove`, origin default `remove`.
//
// What is written is the last 5,000 entries through core's own sanitizeHistory, as the Rust store
// does; a client save (`supersedePartial`) removes the chat's saved partial unless its running
// marker names this process's start (chat-partial.cjs START_ID).
//
// `failNext(status, body, { url, times })` makes the next request(s) answer that status and body
// instead (default: the next /v1/write, once), e.g. 503 { code: 'PROJECTS_BUSY' } as the real store
// does when its lock times out. No file locking, no 32 MB cap (one Node process per data dir in a
// test). Synthetic data only.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const FILES = new Set(['projects.json', 'free-chats.json']);
const HISTORY_OPS = new Set(['/v1/history/read', '/v1/history/write', '/v1/history/append-if-last', '/v1/history/remove-if', '/v1/changes/read', '/v1/chat/delete', '/v1/chat/move', '/v1/chat/grant-context']);
const ORIGINS = new Set(['history', 'import', 'turn', 'remove', 'other']);
const JOURNAL = 'chat-changes.jsonl';
const STORE_START = crypto.randomBytes(16).toString('hex');

function journalEntries(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, JOURNAL), 'utf8'); } catch { /* none yet */ }
  return text.split('\n').slice(0, -1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.seq > 0);
}

function journalAppend(dir, chatId, revision, op, origin) {
  const seq = (journalEntries(dir).at(-1)?.seq || 0) + 1;
  fs.appendFileSync(path.join(dir, JOURNAL), `${JSON.stringify({ seq, chatId, revision, op, origin, start: STORE_START, at: Date.now() })}\n`, { mode: 0o600 });
}
const HISTORY_CAP = 5000;
const server = (m) => require(path.join(__dirname, '..', '..', 'server', m));
const revisionOf = (history) => sha(JSON.stringify(history));
let tmpSeq = 0;

/** `/v1/chat/delete` (see the header) for a user directory that exists. */
function chatDeleteOp(body, dir) {
  const raw = typeof body.chat === 'string' ? body.chat : null;
  if (raw === null) return [400, { error: 'user and chat required' }];
  if (!raw) return [400, { error: 'invalid chat id' }];
  const kind = body.kind;
  const pid = body.projectId;
  const ok = (kind === 'free' && pid == null) || (kind === 'unlisted' && pid == null) || (kind === 'project' && typeof pid === 'string');
  if (!ok) return [400, { error: 'kind must be free, unlisted, or project with a projectId' }];
  const origin = body.origin === undefined || body.origin === null ? 'remove' : body.origin;
  if (!ORIGINS.has(origin)) return [400, { error: 'origin must be one of history, import, turn, remove, other' }];
  const lists = server('chat-lists.cjs');
  const safe = lists.safeChatId(raw);
  const ids = [...new Set([raw, safe].filter(Boolean))];
  const tombFile = path.join(dir, 'deleted-chats.json');
  const readTomb = () => [...lists.readTombstones(dir)];
  const writeTomb = (list) => { const tmp = `${tombFile}.${process.pid}.${tmpSeq++}.tmp`; fs.writeFileSync(tmp, JSON.stringify(list.slice(-5000)), { mode: 0o600 }); fs.renameSync(tmp, tombFile); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
  const freeFile = path.join(dir, 'free-chats.json'), projFile = path.join(dir, 'projects.json');
  const isChat = (c, set) => !!c && typeof c === 'object' && typeof c.id === 'string' && set.includes(c.id);
  const listedAnywhere = () => {
    const free = readJson(freeFile);
    if (Array.isArray(free) && free.some((c) => isChat(c, ids))) return true;
    const projects = readJson(projFile)?.projects;
    return Array.isArray(projects) && projects.some((p) => p && Array.isArray(p.chats) && p.chats.some((c) => isChat(c, ids)));
  };
  const tombstoned = () => ids.some((i) => lists.readTombstones(dir).has(i));
  const addTomb = () => { const before = readTomb(); const fresh = ids.filter((i) => !before.includes(i)); writeTomb([...before.filter((x) => !ids.includes(x)), ...ids]); return fresh; };
  const removeFiles = () => {
    let had = false;
    if (safe) { const h = path.join(dir, `history-${safe}.json`); had = fs.existsSync(h); fs.rmSync(h, { force: true }); }
    const fp = (sub, id) => path.join(dir, sub, `${sha(String(id))}.json`);
    for (const id of ids) {
      fs.rmSync(path.join(dir, `context-${sha(JSON.stringify(String(id)))}.json`), { force: true });
      fs.rmSync(fp('chat-brains', id), { force: true });
      fs.rmSync(fp('chat-partials', id), { force: true });
    }
    return had;
  };
  const note = () => journalAppend(dir, safe || raw, null, 'remove', origin);
  const writeAtomic = (file, text) => { const tmp = `${file}.store-stub.tmp`; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); };
  let removed = false;
  if (kind === 'unlisted') {
    if (listedAnywhere()) return [409, { error: 'a list still holds this chat', code: 'CHAT_LISTED' }];
    addTomb();
    removed = true;
  } else if (kind === 'free') {
    const list = readJson(freeFile);
    const items = Array.isArray(list) ? list : [];
    const kept = items.filter((c) => !isChat(c, [raw]));
    if (kept.length !== items.length) {
      const fresh = addTomb();
      try { writeAtomic(freeFile, JSON.stringify(kept, null, 2)); }
      catch { writeTomb(readTomb().filter((x) => !fresh.includes(x))); return [500, { error: 'Internal error' }]; }
      removed = true;
    }
  } else {
    const file = readJson(projFile);
    const projects = Array.isArray(file?.projects) ? file.projects : [];
    const project = projects.find((p) => p && p.id === pid);
    const chats = project && Array.isArray(project.chats) ? project.chats : [];
    const kept = chats.filter((c) => !isChat(c, [raw]));
    if (project && kept.length !== chats.length) {
      const fresh = addTomb();
      project.chats = kept;
      for (const p of projects) server('instruction-skills.cjs').reconcile(p);
      try { writeAtomic(projFile, JSON.stringify({ projects }, null, 2)); }
      catch { writeTomb(readTomb().filter((x) => !fresh.includes(x))); return [500, { error: 'Internal error' }]; }
      removed = true;
    }
  }
  if (removed) { removeFiles(); note(); return [200, { deleted: true, swept: false, leftovers: 0 }]; }
  if (tombstoned() && !listedAnywhere()) { if (removeFiles()) note(); return [200, { deleted: false, swept: true, leftovers: 0 }]; }
  return [200, { deleted: false, swept: false, leftovers: 0 }];
}

/** Slice7 protocol double ONLY. Real locking/intent/fsync/recovery proofs live in Rust.
 * Reads the latest account files, preserves metadata/attachments, never creates an account. */
function chatMoveOp(body, dir, moving = true) {
  if (!fs.existsSync(dir)) return [410, { error: 'account no longer exists' }];
  const lists = server('chat-lists.cjs'), safe = lists.safeChatId(body.chat);
  if (!safe) return [400, { error: 'invalid chat id' }];
  const read = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')); } catch(e) { if(e.code==='ENOENT')return fallback;throw e; } };
  const projectsDoc=read('projects.json',{projects:[]}), free=read('free-chats.json',[]);
  if(!Array.isArray(projectsDoc.projects)||!Array.isArray(free))return[500,{error:'Internal error'}];
  const projects=projectsDoc.projects, found=[];
  for(const c of free)if(c&&lists.safeChatId(c.id)===safe)found.push({holder:{kind:'free'},meta:c,list:free});
  for(const p of projects)for(const c of p.chats||[])if(c&&lists.safeChatId(c.id)===safe)found.push({holder:{kind:'project',id:p.id},meta:c,list:p.chats,project:p});
  if(found.length>1)return[409,{error:'ambiguous canonical chat identity',code:'CHAT_ID_AMBIGUOUS'}];
  const state=read('chat-move-state.json',{version:1,generations:{},pending:null,completed:null});
  const generation=state.generations[safe]||'0', from=found[0]?.holder||{kind:'absent'};
  const tombstoned=[...lists.readTombstones(dir)].some(id=>lists.safeChatId(id)===safe);
  if(!moving)return[200,{canonicalChatId:safe,holder:from,generation,start:server('chat-partial.cjs').START_ID,tombstoned}];
  if(!(body.projectId===null||typeof body.projectId==='string'))return[400,{error:'projectId (or null) required'}];
  const owner=found[0], target=body.projectId===null?null:projects.find(p=>p.id===body.projectId);
  const internal=p=>p&&(p.id==='cowork-diary-extras'||p.id.startsWith('cowork-chat-context-'));
  if(tombstoned||!owner||owner.meta.id!==body.chat||internal(owner.project)||(body.projectId!==null&&(!target||internal(target)))||
    (target&&target!==owner.project&&target.archived))return[404,{error:'no such chat or project'}];
  const to=target?{kind:'project',id:target.id}:{kind:'free'}, destination=target?(target.chats||[]):free;
  let meta={...owner.meta};
  if(Object.hasOwn(body,'frame')){
    if(body.frame!==null&&!server('chat-framing.cjs').normalizeFrame(body.frame))return[400,{error:'invalid frame'}];
    meta.frame=body.frame===null?null:server('chat-framing.cjs').normalizeFrame(body.frame);
  }
  const same=JSON.stringify(from)===JSON.stringify(to);
  if(!same&&destination.length>=1000)return[409,{error:'the move would evict chat metadata',code:'CHAT_DESTINATION_FULL'}];
  const merged=lists.mergeChats(destination,[meta]);
  if(merged.length<destination.filter(c=>c&&c.id!==body.chat).length+1)return[409,{error:'the move would evict chat metadata',code:'CHAT_DESTINATION_FULL'}];
  if(same&&JSON.stringify(meta)===JSON.stringify(owner.meta))return[200,{from,to,generation}];
  if(!same&&BigInt(generation)>=18446744073709551615n)return[500,{error:'Internal error'}];
  const next=same?generation:(BigInt(generation)+1n).toString();
  const write=(name,value)=>{const file=path.join(dir,name),tmp=file+'.move-stub.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);};
  owner.list.splice(0,owner.list.length,...owner.list.filter(c=>c.id!==body.chat));
  if(target)target.chats=merged;else free.splice(0,free.length,...merged);
  state.generations[safe]=next;write('chat-move-state.json',state);
  if(to.kind==='free'){write('free-chats.json',free);write('projects.json',projectsDoc);}
  else{write('projects.json',projectsDoc);write('free-chats.json',free);}
  const seq=(journalEntries(dir).at(-1)?.seq||0)+1;
  fs.appendFileSync(path.join(dir,JOURNAL),JSON.stringify({seq,chatId:safe,rawChatId:body.chat,revision:null,op:'move',origin:'other',eventId:crypto.randomBytes(16).toString('hex'),generation:next,delivery:'live',start:server('chat-partial.cjs').START_ID,at:Date.now()})+'\n');
  return[200,{from,to,generation:next}];
}

/** The transcript ops (see the header) for a user directory that exists. */
function historyOp(url, body, dir) {
  if (url === '/v1/chat/delete') return chatDeleteOp(body, dir);
  if (url === '/v1/chat/move' || url === '/v1/chat/grant-context') return chatMoveOp(body,dir,url === '/v1/chat/move');
  const chat = typeof body.chat === 'string' ? body.chat.replace(/[^a-zA-Z0-9_-]/g, '') : '';
  if (url === '/v1/changes/read') {
    const after = body.after === undefined || body.after === null ? 0 : body.after;
    if (!Number.isInteger(after) || after < 0) return [400, { error: 'after must be a non-negative integer' }];
    const all = journalEntries(dir);
    const newer = all.filter((e) => e.seq > after);
    return [200, { entries: newer.slice(0, 1000), oldestSeq: all[0]?.seq ?? null, latestSeq: all.at(-1)?.seq ?? null, more: newer.length > 1000, start: STORE_START }];
  }
  if (!chat) return [400, { error: typeof body.chat === 'string' ? 'invalid chat id' : 'user and chat required' }];
  const origin = body.origin === undefined || body.origin === null ? 'other' : body.origin;
  if (url !== '/v1/history/read' && !ORIGINS.has(origin)) return [400, { error: 'origin must be one of history, import, turn, remove, other' }];
  const file = path.join(dir, `history-${chat}.json`);
  const parsed = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
  const current = () => {
    const v = parsed();
    const history = (v && typeof v === 'object' && !Array.isArray(v) ? v.history : undefined) || [];
    return { history, revision: revisionOf(history), exists: fs.existsSync(file) };
  };
  const tombstoned = () => server('chat-lists.cjs').readTombstones(dir).has(chat);
  const bounded = (list) => server('chat-sources.cjs').sanitizeHistory(list.slice(-HISTORY_CAP));
  const write = (next) => {
    const tmp = `${file}.${process.pid}.${tmpSeq++}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ history: next }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  };
  if (url === '/v1/history/read') return [200, current()];
  if (url === '/v1/history/append-if-last') {
    if (typeof body.message !== 'string' || !body.entry || typeof body.entry !== 'object' || Array.isArray(body.entry)) return [400, { error: 'message and entry required' }];
    if (tombstoned()) return [200, { outcome: 'deleted' }];
    const history = parsed()?.history;
    if (!Array.isArray(history)) return [200, { outcome: 'no-user-message' }];
    const last = history[history.length - 1];
    if (!last || last.role !== 'user' || last.content !== body.message) return [200, { outcome: 'not-last' }];
    const next = bounded([...history, body.entry]);
    write(next);
    journalAppend(dir, chat, revisionOf(next), 'append', origin);
    return [200, { outcome: 'saved', revision: revisionOf(next) }];
  }
  if (!Array.isArray(body.history)) return [400, { error: 'history must be a list' }];
  let next;
  try { next = bounded(body.history); } catch { return [400, { error: 'invalid history' }]; }
  const proposed = revisionOf(next);
  if (url === '/v1/history/remove-if') {
    const now = current();
    if (!now.exists || now.revision !== proposed) return [200, { removed: false }];
    fs.rmSync(file, { force: true });
    journalAppend(dir, chat, null, 'remove', origin);
    return [200, { removed: true }];
  }
  if (tombstoned()) return [410, { error: 'This chat was deleted.', code: 'CHAT_DELETED' }];
  const now = current();
  const holds = typeof body.baseRevision === 'string' ? body.baseRevision === now.revision : body.ifAbsent === true ? !now.exists : true;
  if (!holds) return [409, { ...now, proposedRevision: proposed }];
  write(next);
  if (body.supersedePartial === true) {
    const partial = server('chat-partial.cjs');
    const saved = partial.readPartial(dir, chat);
    if (!(saved && saved.running && saved.running.start === partial.START_ID)) fs.rmSync(partial.fileFor(dir, chat), { force: true });
  }
  journalAppend(dir, chat, proposed, 'write', origin);
  return [200, { revision: proposed }];
}
const USER = /^[0-9a-f-]{36}$/i;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function snapshot(file) {
  try { const bytes = fs.readFileSync(file); return { version: sha(bytes), text: bytes.toString('utf8') }; }
  catch (e) { if (e.code === 'ENOENT') return { version: '', text: null }; throw e; }
}

function valid(file, text) {
  let v;
  try { v = JSON.parse(text); } catch { return 'text is not JSON'; }
  if (file === 'projects.json') return v && typeof v === 'object' && Array.isArray(v.projects) ? null : 'projects.json must be { "projects": [...] }';
  return Array.isArray(v) ? null : 'free-chats.json must be a list';
}

/** The request handler over `<dataDir>/users/<user>/<file>`; `writes` lists the files written. */
function createHandler(dataDir, token, writes = [], failures = [], { changes = false } = {}) {
  // Reuse the existing test-only source journal stand-in across HTTP calls. Production
  // clients still have no Node journal fallback; Rust tests cover the actual store.
  // Test-only transport stand-in for unrelated index fixtures. It never claims
  // native cleanup/lease/ownership qualification; real Rust two-process tests do.
  const contextIncarnation=crypto.randomBytes(16).toString('hex');
  let contextInstalled=false;
  const contextReply=body=>{
    const db=new (require(require.resolve('better-sqlite3',{paths:[path.join(__dirname,'..','..','server')]})))(path.join(dataDir,'cowork.db'),{fileMustExist:true});
    try {
      if(body.op==='hello') {
        if(!contextInstalled) {db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('native:feature-runtime:incarnation',contextIncarnation);contextInstalled=true;}
        return {op:'hello',request:body.request,start:body.start,incarnation:contextIncarnation};
      }
      if(!contextInstalled||body.incarnation!==contextIncarnation||!['register','renew','release'].includes(body.op))throw Error('context unavailable');
      return {op:body.op,request:body.request,start:body.start,incarnation:contextIncarnation,boot:body.boot,session:body.session,sequence:body.sequence,status:body.op==='release'?'released':'ready',...(body.op==='release'?{}:{leaseMs:15000})};
    } finally {db.close();}
  };

  return (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        if (req.method !== 'POST' || !(['/v1/read', '/v1/write','/v1/features/context'].includes(req.url) || HISTORY_OPS.has(req.url))) return send(res, 404, { error: 'not found' });
        if (req.url === '/v1/changes/read' && !changes) return send(res, 404, { error: 'not found' });
        if (req.headers['x-noevia-store-token'] !== token) return send(res, 401, { error: 'unauthorised' });
        const planned = failures.find((f) => f.url === req.url && f.times > 0);
        if (planned) { planned.times -= 1; return send(res, planned.status, planned.body); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        if(req.url==='/v1/features/context')return send(res,200,contextReply(body));
        if (!body || typeof body.user !== 'string') return send(res, 400, { error: 'user required' });
        if (!HISTORY_OPS.has(req.url) && !FILES.has(body.file)) return send(res, 400, { error: 'file must be projects.json or free-chats.json' });
        if (!USER.test(body.user)) return send(res, 400, { error: 'invalid user' });
        const dir = path.join(dataDir, 'users', body.user);
        if (!fs.existsSync(dir)) return send(res, 410, { error: 'account no longer exists' });
        if (HISTORY_OPS.has(req.url)) {
          const [status, answer] = historyOp(req.url, body, dir);
          return send(res, status, answer);
        }
        const file = path.join(dir, body.file);
        if (req.url === '/v1/read') return send(res, 200, snapshot(file));
        if (typeof body.version !== 'string' || typeof body.text !== 'string') return send(res, 400, { error: 'version and text required' });
        const why = valid(body.file, body.text);
        if (why) return send(res, 400, { error: why });
        const now = snapshot(file);
        if (now.version !== body.version) return send(res, 409, now);
        const tmp = `${file}.store-stub.tmp`;
        fs.writeFileSync(tmp, body.text, { mode: 0o600 });
        fs.renameSync(tmp, file);
        writes.push(body.file);
        return send(res, 200, { version: sha(Buffer.from(body.text, 'utf8')) });
      } catch {
        return send(res, 500, { error: 'Internal error' });
      }
    });
  };
}

/** Starts the store on 127.0.0.1 (port 0 by default); resolves { port, token, server, writes, close }. */
async function startProjectStore(dataDir, { port = 0, token = crypto.randomBytes(32).toString('hex'), changes = false } = {}) {
  const writes = [];
  const failures = [];
  const server = http.createServer(createHandler(dataDir, token, writes, failures, { changes }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const failNext = (status, body, { url = '/v1/write', times = 1 } = {}) => { failures.push({ status, body, url, times }); };
  const clearFailures = () => { failures.length = 0; };
  return { port: server.address().port, token, server, writes, failNext, clearFailures, close: () => new Promise((r) => server.close(() => r())) };
}

/** A free loopback port, found synchronously (a child binds port 0 and reports it). */
function freePortSync() {
  const r = spawnSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();})"], { encoding: 'utf8', timeout: 10000 });
  const port = Number(r.stdout);
  if (!Number.isInteger(port) || port < 1) throw new Error(`could not find a free port for the project store: ${r.stderr || r.status}`);
  return port;
}

/** For tests that load server/index.cjs in-process: sets NOEVIA_PROJECT_STORE_PORT and
 *  NOEVIA_PROJECT_STORE_TOKEN in `env` now (index.cjs reads them when it loads, and takes the
 *  secret out of the environment) and starts the store on that port, unref'd so it never keeps
 *  the test process alive. Call it before requiring index.cjs. */
function installProjectStore(dataDir, env = process.env) {
  if(!/^[0-9a-f]{32}$/.test(env.NOEVIA_START_ID||''))env.NOEVIA_START_ID=crypto.randomBytes(16).toString('hex');
  const port = freePortSync();
  const token = crypto.randomBytes(32).toString('hex');
  env.NOEVIA_PROJECT_STORE_PORT = String(port);
  env.NOEVIA_PROJECT_STORE_TOKEN = token;
  const writes = [];
  const failures = [];
  const server = http.createServer(createHandler(dataDir, token, writes, failures));
  const failNext = (status, body, { url = '/v1/write', times = 1 } = {}) => { failures.push({ status, body, url, times }); };
  server.on('error', (e) => { console.error(`project store stand-in on ${port}: ${e.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1');
  server.unref();
  return { port, writes, server, failNext };
}

/** For unit tests that hand a workspace its `transcripts` directly (workspace.cjs gets them from
 *  project-store-client.cjs transcriptsFor): the same ops over `dir` in process, answered as that
 *  client answers them. `calls` records each op. */
function localTranscripts(dir, calls = []) {
  const run = (url, body) => {
    calls.push({ url, body });
    if (!fs.existsSync(dir)) throw Object.assign(new Error('account no longer exists'), { status: 410 });
    const [status, answer] = historyOp(url, body, dir);
    if (status === 400) throw Object.assign(new Error(answer.error), { status: 400 });
    return { status, answer };
  };
  return {
    calls,
    read: async (chat) => run('/v1/history/read', { chat }).answer,
    write: async (chat, history, { baseRevision, ifAbsent = false, supersedePartial = false, origin } = {}) => {
      const { status, answer } = run('/v1/history/write', { chat, history, baseRevision, ifAbsent, supersedePartial, origin });
      if (status === 200) return { ok: true, revision: answer.revision };
      if (status === 409) return { conflict: true, ...answer };
      return { deleted: true };
    },
    appendIfLast: async (chat, message, entry, { origin } = {}) => run('/v1/history/append-if-last', { chat, message, entry, origin }).answer.outcome,
    removeIf: async (chat, history, { origin } = {}) => run('/v1/history/remove-if', { chat, history, origin }).answer.removed,
    deleteChat: async (chat, { kind, projectId, origin } = {}) => {
      const { status, answer } = run('/v1/chat/delete', { chat, kind, projectId, origin });
      if (status === 409) return { deleted: false, swept: false, leftovers: 0, listed: true };
      if (status !== 200) throw Object.assign(new Error(answer.error || 'store failed'), { status: 500 });
      return answer;
    },
  };
}

/** The Rust front's `POST /api/chats/{chatId}/history` (noevia-rs crates/server-projects
 *  history.rs, sbstndalton/noevia#1071 slice 5), in process over `<dataDir>/users/<user>`, for
 *  tests that need a chat saved the way a browser saves it now that Node refuses that route
 *  (rust-projects.cjs OWNED_ROUTES). Same answers: 410 for a tombstoned chat, 400 for a body that
 *  is not an object with a `history` list, else the store's write with `supersedePartial` and
 *  origin `history` -> 200 { ok, revision } | 409 { error, history, revision } | 410.
 *  Resolves { status, text } like the tests' request helpers. */
function rustHistorySave(dataDir, user, rawChatId, body) {
  const lists = require('../../server/chat-lists.cjs');
  const answer = (status, value) => ({ status, text: JSON.stringify(value) });
  const chat = lists.safeChatId(String(rawChatId));
  if (!chat) return answer(400, { error: 'invalid chat id' });
  const dir = path.join(dataDir, 'users', user);
  if (!fs.existsSync(dir)) return answer(410, { error: 'account no longer exists' });
  if (lists.readTombstones(dir).has(chat)) return answer(410, { error: 'This chat was deleted.' });
  const parsed = typeof body === 'string' ? (() => { try { return JSON.parse(body); } catch { return undefined; } })() : body;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return answer(400, { error: 'request body must be a JSON object' });
  if (!Array.isArray(parsed.history)) return answer(400, { error: 'history must be a list' });
  const baseRevision = typeof parsed.baseRevision === 'string' ? parsed.baseRevision : undefined;
  const [status, out] = historyOp('/v1/history/write', { chat, history: parsed.history, baseRevision, supersedePartial: true, origin: 'history' }, dir);
  if (status === 200) return answer(200, { ok: true, revision: out.revision });
  if (status === 409) return answer(409, { error: 'This chat changed on another device.', history: out.history, revision: out.revision });
  if (status === 410) return answer(410, { error: 'This chat was deleted.' });
  return answer(status, out);
}

/** The Rust front's `DELETE /api/freechats/{id}` and `DELETE /api/projects/{p}/chats/{c}`
 *  (noevia-rs crates/server-projects chat_delete.rs, sbstndalton/noevia#1071 slice 6), in process
 *  over `<dataDir>/users/<user>`, for tests that delete a chat the way a browser does now that Node
 *  refuses those routes. 200 { ok: true } | 404 { error: 'no such chat' } | 410. Resolves
 *  { status, text } like the tests' request helpers. `projectId` null: the free list. */
function rustChatDelete(dataDir, user, projectId, rawChatId) {
  const answer = (status, value) => ({ status, text: JSON.stringify(value) });
  const dir = path.join(dataDir, 'users', user);
  if (!fs.existsSync(dir)) return answer(410, { error: 'account no longer exists' });
  const body = projectId == null ? { chat: String(rawChatId), kind: 'free' } : { chat: String(rawChatId), kind: 'project', projectId: String(projectId) };
  const [status, out] = chatDeleteOp(body, dir);
  if (status !== 200) return answer(status, out);
  return out.deleted ? answer(200, { ok: true }) : answer(404, { error: 'no such chat' });
}

/** Synthetic public-front move adapter for Node lifecycle fixtures; real HTTP/auth is Rust-tested. */
function rustChatMove(dataDir,user,encodedChat,body) {
  const answer=(status,value)=>({status,text:JSON.stringify(value)});
  let chat;try{chat=decodeURIComponent(encodedChat);}catch{return answer(400,{error:'invalid chat id'});}
  let parsed=body;try{if(typeof body==='string')parsed=JSON.parse(body);}catch{return answer(400,{error:'invalid JSON'});}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!(parsed.projectId===null||typeof parsed.projectId==='string'))return answer(400,{error:'projectId (or null) required'});
  const [status,out]=chatMoveOp({chat,projectId:parsed.projectId,...(Object.hasOwn(parsed,'frame')?{frame:parsed.frame}:{})},path.join(dataDir,'users',user));
  if(status!==200)return answer(status,out);
  return answer(200,{ok:true,from:out.from.kind==='free'?null:out.from.id,projectId:out.to.kind==='free'?null:out.to.id});
}

module.exports = { rustChatMove, chatMoveOp, startProjectStore, installProjectStore, createHandler, freePortSync, localTranscripts, historyOp, rustHistorySave, rustChatDelete };
