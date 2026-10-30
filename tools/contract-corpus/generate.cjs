#!/usr/bin/env node
'use strict';
// Synthetic HTTP contract corpus for noevia-rs tools/replay (full-Rust migration M0).
//
//   node tools/contract-corpus/generate.cjs --out <dir>
//
// Boots server/index.cjs on 127.0.0.1 with NOEVIA_CONTRACT_RECORD=<dir>/exchanges, a fresh
// throwaway UI_DATA_DIR, mock inference and Diary servers on loopback, and net-guard.cjs, which
// refuses every other outbound connection. The child gets a clean environment (PATH and the
// variables below only), so no real key, token or data directory can leak into the run. It
// drives the web client's paths Node still answers (projects, a streamed chat, a second account
// for the tenant boundary, admin reads, probes of the rest), stops the server, then writes
// <dir>/manifest.json (how to replay: the seed, which placeholders are inputs) and refuses to
// finish if any synthetic secret value reached the corpus.
//
// Sign-in and the account are the Rust front's (sbstndalton/noevia#1071): Node no longer answers
// setup, sign-in, invitations, recovery or the profile, so the two accounts and their sessions are
// seeded in the throwaway data dir (tests/server/seed-account.cjs) once the server has migrated it.
// Their exchanges stay in the noevia-rs corpus recorded at its contracts/http/core.ref.
//
// No model is loaded, no real Diary is called: the mocks answer every model and Diary request.
// The chat prompt's date line states mocks.cjs CORPUS_NOW (NOEVIA_CONTRACT_FIXED_NOW), not today, so the
// corpus does not change with the day it is recorded or replayed on.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { MARKER } = require('../../server/contract-record.cjs');
const { MODEL, SERVER, GUARD, startMocks, serverEnv } = require('./mocks.cjs');
const { seedAccount } = require('../../tests/server/seed-account.cjs');
const { startProjectStore } = require('../../tests/server/project-store-server.cjs');
const { createProjectAs } = require('../../tests/server/front-projects.cjs');
// Synthetic accounts for a throwaway data dir; the recorder writes their cookies as placeholders only.
const ADMIN = { username: 'synthetic-admin', displayName: 'Synthetic Admin' };
const MEMBER = { username: 'synthetic-member', displayName: 'Synthetic Member', role: 'member' };

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

class Client {
  constructor(base, origin) { this.base = base; this.origin = origin; this.jar = new Map(); }
  async call(method, p, body) {
    const headers = { Origin: this.origin, Accept: 'application/json, text/event-stream' };
    if (this.jar.size) headers.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = this.jar.get('cowork_csrf');
    if (csrf && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(60000) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';'); const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim(); const value = pair.slice(eq + 1).trim();
      if (!value || /max-age=0/i.test(c)) this.jar.delete(name); else this.jar.set(name, value);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE or text */ }
    return { status: res.status, json, text };
  }
}

function sseEvents(text) {
  return text.split(/\n\n/).map((b) => b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'))
    .filter(Boolean).map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
}

async function waitReady(base, child) {
  for (let i = 0; i < 150; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try { const r = await fetch(`${base}/api/ready`); if (r.ok && (await r.json()).ready) return; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become ready in 30 s');
}

// GETs for client paths no scenario step reaches; {x} params are filled from the run. The Rust
// front's permanent routes (sbstndalton/noevia#1071: sign-in and the account, usage, stats,
// sampling, routing mode and default, ChatGPT status, the provider registry's list and writes since
// #2190 round 6, the MCP keys and sign-ins since #2202, storage metadata/list/read, export, and since
// #2185 the Diary source, today, storage-import and workspace export/import) are not
// Node's to record any more;
// their exchanges stay in the noevia-rs corpus recorded at its contracts/http/core.ref.
const PROBES = [
  '/api/account/retention',
  '/api/admin/decision-settings', '/api/admin/features', '/api/admin/mcp-directory', '/api/admin/offsite-backup', '/api/admin/web-address',
  '/api/auto-roles', '/api/chat-framing/preferences', '/api/chat-vault-mirror/preferences', '/api/code/active',
  '/api/connectors', '/api/connectors/gdrive/policy', '/api/connectors/nextcloud/policy', '/api/diary', '/api/diary-connector', '/api/diary/storage-status',
  '/api/model-manager',
  '/api/models/autotune', '/api/models/autotune/settings', '/api/models/autotune/untuned', '/api/models/calibration', '/api/models/capabilities', '/api/models/evidence',
  '/api/models/hardware', '/api/models/inference-budget', '/api/models/installed', '/api/plugins/directory',
  '/api/profile/diary-connectors', '/api/profile/sharing',
  '/api/providers/{providerId}/models', '/api/reasoning-settings',
  '/api/toolboxes', '/api/toolboxes/permitted',
  '/api/projects/{projectId}/browser', '/api/projects/{projectId}/code', '/api/projects/{projectId}/instruction-skills', '/api/projects/{projectId}/instruction-skills/manifests', '/api/projects/{projectId}/research',
];

// Validation-path probes for writes no scenario step makes: an empty or minimal body on the
// throwaway data dir. Anything they would reach outside loopback is refused by net-guard.cjs.
// Left out on purpose: offsite-backup run/copy/google connect, gdrive connect/backup-copy and
// uploads (multipart), which start flows a probe cannot finish.
const WRITE_PROBES = [
  ['POST', '/api/admin/decision-settings/test', {}], ['POST', '/api/admin/mcp-directory/custom/preview', {}],
  ['POST', '/api/admin/offsite-backup/verify', {}],
  ['POST', '/api/chat-framing/suggest', {}], ['POST', '/api/connectors/gdrive/disconnect', {}],
  ['POST', '/api/integrations/storage/test', { kind: 'local' }], ['POST', '/api/models/estimate', {}],
  ['POST', '/api/models/presets/reload', {}], ['POST', '/api/models/autotune/cancel', {}], ['POST', '/api/models/calibration/cancel', {}],
  ['POST', '/api/providers/test', {}],
  // A free chat's delete (DELETE /api/freechats/{id}) is the Rust front's since #1071 slice 6: its
  // exchanges stay in the noevia-rs corpus recorded at its core.ref.
];

async function main() {
  const out = path.resolve(arg('--out') || '');
  if (!arg('--out')) throw new Error('usage: generate.cjs --out <dir>');
  const exchanges = path.join(out, 'exchanges');
  // --out is wiped before a run, so it may only be a directory this tool made: missing, empty, or
  // holding nothing but manifest.json and exchanges/. Only those two are deleted.
  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) throw new Error(`refusing --out ${out}: not a directory`);
    const foreign = fs.readdirSync(out).filter((n) => n !== 'manifest.json' && n !== 'exchanges');
    if (foreign.length) throw new Error(`refusing --out ${out}: it holds ${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', ...' : ''}; use a new or previous-corpus directory`);
    fs.rmSync(path.join(out, 'manifest.json'), { force: true });
    fs.rmSync(exchanges, { recursive: true, force: true });
  }
  fs.mkdirSync(exchanges, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-contract-data-'));
  fs.writeFileSync(path.join(dataDir, MARKER), 'synthetic data dir made by tools/contract-corpus/generate.cjs\n', { mode: 0o600 });
  const mocks = await startMocks();
  const port = await new Promise((resolve) => { const srv = http.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  // Node saves projects.json and free-chats.json only through the Rust front's project store and
  // refuses to start without one (sbstndalton/noevia#1071): a loopback stand-in with the same
  // protocol, on this throwaway data dir.
  const store = await startProjectStore(dataDir);
  const env = serverEnv({ port, dataDir, origin: base, mocks, record: exchanges });
  // The stand-in also answers the feature runtime's context exchange, under this run's start id.
  Object.assign(env, { NOEVIA_PROJECT_STORE_PORT: String(store.port), NOEVIA_PROJECT_STORE_TOKEN: store.token, NOEVIA_START_ID: require('node:crypto').randomBytes(16).toString('hex') });
  env.NOEVIA_CORPUS_ALLOWED_PORTS = `${env.NOEVIA_CORPUS_ALLOWED_PORTS},${store.port}`;
  const log = [];
  const child = spawn(process.execPath, ['--require', GUARD, SERVER], { env, cwd: path.dirname(SERVER), stdio: ['ignore', 'pipe', 'pipe'] });
  // The first-run setup code is printed to the log; keep the log in memory only.
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const steps = [];
  // The seeded sessions' raw values, which must never reach the corpus.
  const secrets = [store.token];
  try {
    await waitReady(base, child);
    const admin = new Client(base, base);
    const member = new Client(base, base);
    const anon = new Client(base, base);
    const step = async (client, method, p, body, expect) => {
      const r = await client.call(method, p, body);
      steps.push({ method, path: p.replace(/\?.*/, ''), status: r.status });
      console.log(`${r.status} ${method} ${p.replace(/\?.*/, '')}`);
      if (expect && !expect.includes(r.status)) throw new Error(`${method} ${p}: expected ${expect.join('/')}, got ${r.status}: ${r.text.slice(0, 300)}`);
      return r;
    };
    // The accounts and their sessions, as the Rust front writes them (#1071).
    const seeded = { admin: seedAccount(dataDir, { ...ADMIN, publicOrigin: base }), member: seedAccount(dataDir, MEMBER) };
    for (const [client, account] of [[admin, seeded.admin], [member, seeded.member]]) {
      client.jar.set('cowork_session', account.session);
      client.jar.set('cowork_csrf', account.csrf);
    }
    secrets.push(...Object.values(seeded).flatMap((a) => [a.session, a.csrf]));

    // Signed out, and signed in.
    await step(anon, 'GET', '/api/health');
    await step(anon, 'GET', '/api/workspace');
    await step(admin, 'GET', '/api/workspace', undefined, [200]);
    // The feature settings are the Rust front's (sbstndalton/noevia-rs#338): Node refuses them.
    const featureRead = await step(admin, 'GET', '/api/features', undefined, [503]);
    if (featureRead.json?.code !== 'RUST_FEATURES_OWNED') throw new Error('Expected the Rust feature ownership refusal.');
    // A write without the CSRF header is refused.
    const noCsrf = new Client(base, base); noCsrf.jar = new Map([...admin.jar].filter(([k]) => k !== 'cowork_csrf'));
    await step(noCsrf, 'POST', '/api/projects', { name: 'no csrf' });

    // Projects.
    // A project's create and delete are the Rust front's (sbstndalton/noevia#2191): Node refuses them
    // before auth, and their exchanges stay in the noevia-rs corpus recorded at its core.ref. The
    // project is seeded the way the front's create writes it (tests/server/front-projects.cjs).
    const projectBody = { name: 'Synthetic project', goal: 'Contract corpus', instructions: 'Answer briefly.', model: MODEL, files: [{ name: 'notes.md', content: '# Synthetic notes\n\nAlpha beta gamma.' }] };
    const createRefused = await step(admin, 'POST', '/api/projects', projectBody, [503]);
    if (createRefused.json?.code !== 'RUST_PROJECT_LIFECYCLE_OWNED') throw new Error('Expected the Rust project lifecycle ownership refusal.');
    const projectId = createProjectAs(dataDir, seeded.admin.id, projectBody).id;
    await step(admin, 'GET', '/api/workspace', undefined, [200]);
    await step(admin, 'POST', `/api/projects/${encodeURIComponent(projectId)}/config`, { instructions: 'Answer very briefly.' });

    // A streamed chat turn against the mock model.
    const chat = await step(admin, 'POST', '/api/chat', { spaceId: projectId, projectId, chatId: null, message: 'Say hello.', history: [] });
    const chatId = sseEvents(chat.text).map((e) => e.chatId).find(Boolean);
    if (chatId) {
      await step(admin, 'GET', `/api/chats/${encodeURIComponent(chatId)}/history`);
      await step(admin, 'GET', `/api/chats/${encodeURIComponent(chatId)}/context`);
      await step(admin, 'GET', `/api/chats/${encodeURIComponent(chatId)}/context-window`);
      await step(admin, 'GET', `/api/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`);
    }

    // A second account (seeded above): the tenant boundary is part of the contract.
    await step(member, 'GET', '/api/workspace');
    if (chatId) await step(member, 'GET', `/api/chats/${encodeURIComponent(chatId)}/history`);
    // Address GETs are refused before Node's auth: the Rust front owns this read for every role.
    const addressRead = await step(member, 'GET', '/api/admin/web-address', undefined, [503]);
    if (addressRead.json?.code !== 'RUST_WEB_ADDRESS_READ_OWNED') throw new Error('Expected the Rust web-address read ownership refusal.');
    const memberId = seeded.member.id;

    // The reasoning default's PUT and the routing configuration are the Rust front's since #1071
    // (their exchanges stay in the noevia-rs corpus recorded at its core.ref); the GET is Node's.
    await step(admin, 'GET', '/api/reasoning-settings', undefined, [200]);

    // Read probes for the rest of the client's paths.
    const fill = { projectId, providerId: 'default', chatId: chatId || 'missing-chat' };
    for (const p of PROBES) await step(admin, 'GET', p.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(fill[k] || k)));

    for (const [method, p, body] of WRITE_PROBES) await step(admin, method, p, body);

    // Clean-up is part of the contract too. A chat's delete (#1071 slice 6) and the project delete
    // (#2191) are the Rust front's: Node refuses the delete below, and its exchange stays in the noevia-rs corpus.
    await step(admin, 'DELETE', `/api/projects/${encodeURIComponent(projectId)}`, undefined, [503]);
    await step(admin, 'GET', '/api/workspace', undefined, [200]);
    if (memberId) await step(admin, 'DELETE', `/api/admin/users/${encodeURIComponent(memberId)}`, { username: MEMBER.username });

    // The project image routes, the project chat lists and the free-chat list (M4) are the Rust
    // front's since sbstndalton/noevia#1071: Node refuses them, and their exchanges stay in the
    // noevia-rs corpus recorded at its contracts/http/core.ref.
    // The recorder writes an exchange on the response's 'finish', which can come after the client
    // has the whole answer: wait for the last files before stopping the server.
    // Done when every file parses and none has appeared for 150 ms (bounded at 5 s).
    let last = -1, quiet = 0;
    for (let i = 0; i < 100 && quiet < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const names = fs.readdirSync(exchanges);
      const complete = names.filter((f) => f.endsWith('.json')).every((f) => { try { JSON.parse(fs.readFileSync(path.join(exchanges, f), 'utf8')); return true; } catch { return false; } });
      quiet = complete && names.length === last ? quiet + 1 : 0;
      last = names.length;
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    mocks.close();
    await store.close();
    // The throwaway data dir goes whether or not the run got through.
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // Inputs the replayer must supply: values a client typed (passwords) or read out of band (the
  // setup code file). Found by where the placeholder sits in the recorded requests.
  const files = fs.readdirSync(exchanges).filter((f) => f.endsWith('.json')).sort();
  const dropped = fs.readdirSync(exchanges).filter((f) => f.endsWith('.dropped'));
  const inputs = {};
  const manifest = {
    v: 1,
    generator: 'noevia-core tools/contract-corpus/generate.cjs',
    seed: 'synthetic-accounts',
    note: 'Recorded with two synthetic accounts and their sessions seeded straight into UI_DATA_DIR/cowork.db (tests/server/seed-account.cjs): sign-in is the Rust front\'s (sbstndalton/noevia#1071), so a replay needs the same seeding and binds the session cookies itself. Node saved projects.json and free-chats.json through a loopback stand-in for the front\'s project store (tests/server/project-store-server.cjs).',
    inputs,
    exchanges: files.length,
    dropped: dropped.length,
    // Normalised, so two runs write the same manifest.
    covered: [...new Set(files.map((f) => { const ex = JSON.parse(fs.readFileSync(path.join(exchanges, f), 'utf8')); return `${ex.request.method} ${ex.request.path}`; }))],
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Belt and braces over the recorder's own check: the run's real secret values must not appear.
  const setupCode = log.join('').match(/FIRST-RUN SETUP CODE: (\S+)/)?.[1];
  const raw = [...secrets, setupCode].filter(Boolean);
  for (const f of fs.readdirSync(exchanges)) {
    const text = fs.readFileSync(path.join(exchanges, f), 'utf8');
    for (const v of raw) if (text.includes(v)) throw new Error(`${f} holds a raw secret`);
    if (/cowork_(session|csrf)=(?!<secret:)[^;"\s]/.test(text)) throw new Error(`${f} holds a raw cookie`);
  }
  console.log(`contract corpus: ${files.length} exchanges (${dropped.length} dropped) from ${steps.length} steps in ${out}`);
  if (dropped.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
