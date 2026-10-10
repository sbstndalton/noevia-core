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
// drives the web client's paths (sign-up, sessions, projects, a streamed chat, a second account
// for the tenant boundary, admin reads, probes of the rest), stops the server, then writes
// <dir>/manifest.json (how to replay: the seed, which placeholders are inputs) and refuses to
// finish if any synthetic secret value reached the corpus.
//
// No model is loaded, no real Diary is called: the mocks answer every model and Diary request.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { MARKER } = require('../../server/contract-record.cjs');
const { MODEL, SERVER, GUARD, startMocks, serverEnv } = require('./mocks.cjs');
// Synthetic credentials for a throwaway data dir. The replayer is given this password through the
// manifest; the recorder itself writes only placeholders.
const ADMIN = { username: 'synthetic-admin', displayName: 'Synthetic Admin', password: 'contract-corpus-Synthetic-pw-1' };
const MEMBER = { username: 'synthetic-member', displayName: 'Synthetic Member', password: 'contract-corpus-Synthetic-pw-2' };

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

// GETs for client paths no scenario step reaches; {x} params are filled from the run.
const PROBES = [
  '/api/account/instructions', '/api/account/memory', '/api/account/preferences', '/api/account/retention',
  '/api/admin/decision-settings', '/api/admin/features', '/api/admin/mcp-directory', '/api/admin/offsite-backup', '/api/admin/web-address',
  '/api/auth/devices', '/api/auto-roles', '/api/chat-framing/preferences', '/api/chat-vault-mirror/preferences', '/api/code/active',
  '/api/connectors', '/api/connectors/gdrive/policy', '/api/connectors/nextcloud/policy', '/api/diary', '/api/diary-connector', '/api/diary/source', '/api/diary/storage-status',
  '/api/integrations/storage', '/api/mcp-keys/servers', '/api/mcp-oauth/servers', '/api/model-manager',
  '/api/models/autotune', '/api/models/autotune/settings', '/api/models/autotune/untuned', '/api/models/calibration', '/api/models/capabilities', '/api/models/evidence',
  '/api/models/hardware', '/api/models/inference-budget', '/api/models/installed', '/api/plugins/directory',
  '/api/profile/app-passwords', '/api/profile/appearance', '/api/profile/diary-connectors', '/api/profile/sharing',
  '/api/providers', '/api/providers/chatgpt', '/api/providers/{providerId}/models', '/api/reasoning-settings', '/api/routing-default', '/api/routing-mode', '/api/routing-mode/allowed',
  '/api/sampling-settings', '/api/stats', '/api/toolboxes', '/api/toolboxes/permitted', '/api/usage', '/api/usage/aggregate',
  '/api/projects/{projectId}/browser', '/api/projects/{projectId}/code', '/api/projects/{projectId}/instruction-skills', '/api/projects/{projectId}/instruction-skills/manifests', '/api/projects/{projectId}/research',
];

// Validation-path probes for writes no scenario step makes: an empty or minimal body on the
// throwaway data dir. Anything they would reach outside loopback is refused by net-guard.cjs.
// Left out on purpose: offsite-backup run/copy/google connect, gdrive connect/backup-copy and
// uploads (multipart), which start flows a probe cannot finish.
const WRITE_PROBES = [
  ['POST', '/api/admin/decision-settings/test', {}], ['POST', '/api/admin/mcp-directory/custom/preview', {}],
  ['POST', '/api/admin/offsite-backup/verify', {}], ['POST', '/api/auth/device/lookup', { code: 'ABCD-EFGH' }],
  ['POST', '/api/auth/login/passkey/options', { username: 'synthetic-admin' }], ['POST', '/api/auth/passkeys/register/options', {}],
  ['POST', '/api/auth/recovery/complete', { token: 'not-a-recovery-token', password: 'x' }],
  ['POST', '/api/chat-framing/suggest', {}], ['POST', '/api/connectors/gdrive/disconnect', {}],
  ['POST', '/api/integrations/storage/test', { kind: 'local' }], ['POST', '/api/models/estimate', {}],
  ['POST', '/api/models/presets/reload', {}], ['POST', '/api/models/autotune/cancel', {}], ['POST', '/api/models/calibration/cancel', {}],
  ['POST', '/api/providers/test', {}], ['PUT', '/api/profile/features', { diaryEnabled: false }],
  ['GET', '/api/diary/today'], ['GET', '/api/integrations/storage/files'], ['GET', '/api/export/conversations'],
  ['DELETE', '/api/auth/sessions/missing-session-id'], ['DELETE', '/api/auth/passkeys/missing-passkey-id'],
  ['DELETE', '/api/auth/devices/missing-device-id'], ['DELETE', '/api/profile/app-passwords/missing-app-password'],
  ['DELETE', '/api/freechats/missing-free-chat'],
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
  const env = serverEnv({ port, dataDir, origin: base, mocks, record: exchanges });
  const log = [];
  const child = spawn(process.execPath, ['--require', GUARD, SERVER], { env, cwd: path.dirname(SERVER), stdio: ['ignore', 'pipe', 'pipe'] });
  // The first-run setup code is printed to the log; keep the log in memory only.
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const steps = [];
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
    const setupCode = fs.readFileSync(path.join(dataDir, 'first-run-setup-code'), 'utf8').trim();

    // Signed out, before setup.
    await step(anon, 'GET', '/api/health');
    await step(anon, 'GET', '/api/setup/status', undefined, [200]);
    await step(anon, 'GET', '/api/auth/session', undefined, [401]);
    await step(anon, 'GET', '/api/workspace');
    await step(anon, 'POST', '/api/setup/complete', { setupCode: 'wrong-code-synthetic', publicOrigin: base, ...ADMIN, diaryEnabled: false }, [401]);
    // Setup signs the admin in.
    await step(admin, 'POST', '/api/setup/complete', { setupCode, publicOrigin: base, ...ADMIN, diaryEnabled: false }, [201]);
    await step(admin, 'GET', '/api/auth/session', undefined, [200]);
    await step(admin, 'GET', '/api/profile', undefined, [200]);
    await step(admin, 'PATCH', '/api/profile', { displayName: 'Synthetic Admin Renamed' }, [200]);
    await step(admin, 'POST', '/api/profile/onboarding', {}, [200]);
    await step(admin, 'GET', '/api/workspace', undefined, [200]);
    await step(admin, 'GET', '/api/features', undefined, [200]);
    // A write without the CSRF header is refused.
    const noCsrf = new Client(base, base); noCsrf.jar = new Map([...admin.jar].filter(([k]) => k !== 'cowork_csrf'));
    await step(noCsrf, 'PATCH', '/api/profile', { displayName: 'no csrf' });

    // Projects.
    const created = await step(admin, 'POST', '/api/projects', { name: 'Synthetic project', goal: 'Contract corpus', instructions: 'Answer briefly.', model: MODEL, files: [{ name: 'notes.md', content: '# Synthetic notes\n\nAlpha beta gamma.' }] }, [200, 201]);
    const projectId = created.json?.id || created.json?.project?.id;
    if (!projectId) throw new Error(`project id missing from ${created.text.slice(0, 200)}`);
    await step(admin, 'GET', '/api/workspace', undefined, [200]);
    await step(admin, 'POST', `/api/projects/${encodeURIComponent(projectId)}/config`, { instructions: 'Answer very briefly.' });
    await step(admin, 'GET', `/api/projects/${encodeURIComponent(projectId)}/chats`);

    // A streamed chat turn against the mock model.
    const chat = await step(admin, 'POST', '/api/chat', { spaceId: projectId, projectId, chatId: null, message: 'Say hello.', history: [] });
    const chatId = sseEvents(chat.text).map((e) => e.chatId).find(Boolean);
    if (chatId) {
      await step(admin, 'GET', `/api/chats/${encodeURIComponent(chatId)}/history`);
      await step(admin, 'GET', `/api/chats/${encodeURIComponent(chatId)}/context`);
      await step(admin, 'GET', `/api/chats/${encodeURIComponent(chatId)}/context-window`);
      await step(admin, 'GET', `/api/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`);
    }
    await step(admin, 'GET', '/api/freechats');

    // A second account: the tenant boundary is part of the contract.
    const invite = await step(admin, 'POST', '/api/admin/invitations', { role: 'member' }, [201]);
    await step(member, 'POST', '/api/auth/invitations/accept', { token: invite.json.token, ...MEMBER, diaryEnabled: false });
    await step(member, 'GET', '/api/workspace');
    await step(member, 'GET', `/api/projects/${encodeURIComponent(projectId)}/chats`);
    if (chatId) await step(member, 'GET', `/api/chats/${encodeURIComponent(chatId)}/history`);
    await step(member, 'GET', '/api/admin/users');
    const users = await step(admin, 'GET', '/api/admin/users', undefined, [200]);
    const memberId = (users.json?.users || users.json || []).find?.((u) => u.username === MEMBER.username)?.id;
    if (memberId) await step(admin, 'PUT', `/api/admin/users/${encodeURIComponent(memberId)}/disabled`, { disabled: true });
    await step(member, 'GET', '/api/profile');

    // Sign-in, wrong password, sign-out.
    const relog = new Client(base, base);
    await step(relog, 'POST', '/api/auth/login/password', { username: ADMIN.username, password: 'not-the-password-synthetic' });
    await step(relog, 'POST', '/api/auth/login/password', { username: ADMIN.username, password: ADMIN.password }, [200]);
    await step(relog, 'GET', '/api/auth/session', undefined, [200]);
    await step(relog, 'POST', '/api/auth/logout', {}, [200]);
    await step(relog, 'GET', '/api/auth/session', undefined, [401]);

    // Read probes for the rest of the client's paths.
    const fill = { projectId, providerId: 'default', chatId: chatId || 'missing-chat' };
    for (const p of PROBES) await step(admin, 'GET', p.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(fill[k] || k)));

    for (const [method, p, body] of WRITE_PROBES) await step(admin, method, p, body);

    // Clean-up is part of the contract too.
    if (chatId) await step(admin, 'DELETE', `/api/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`);
    await step(admin, 'DELETE', `/api/projects/${encodeURIComponent(projectId)}`);
    await step(admin, 'GET', '/api/workspace', undefined, [200]);
    if (memberId) await step(admin, 'DELETE', `/api/admin/users/${encodeURIComponent(memberId)}`, { username: MEMBER.username });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    mocks.close();
    // The throwaway data dir goes whether or not the run got through.
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // Inputs the replayer must supply: values a client typed (passwords) or read out of band (the
  // setup code file). Found by where the placeholder sits in the recorded requests.
  const files = fs.readdirSync(exchanges).filter((f) => f.endsWith('.json')).sort();
  const dropped = fs.readdirSync(exchanges).filter((f) => f.endsWith('.dropped'));
  const inputs = {};
  for (const f of files) {
    const ex = JSON.parse(fs.readFileSync(path.join(exchanges, f), 'utf8'));
    const b = ex.request.body?.json;
    if (!b) continue;
    if (ex.request.path === '/api/setup/complete' && ex.response.status === 201) inputs[b.setupCode] = { file: 'first-run-setup-code' };
    if (typeof b.password === 'string' && b.password.startsWith('<secret:')) {
      const known = [ADMIN, MEMBER].find((u) => u.username === b.username);
      if (known && ex.response.status < 300) inputs[b.password] = { value: known.password };
    }
  }
  const manifest = {
    v: 1,
    generator: 'noevia-core tools/contract-corpus/generate.cjs',
    seed: 'empty',
    note: 'Replay against a server started on an empty UI_DATA_DIR; the setup code is read from that dir once the server has written it. Passwords are synthetic.',
    inputs,
    exchanges: files.length,
    dropped: dropped.length,
    // Normalised, so two runs write the same manifest.
    covered: [...new Set(files.map((f) => { const ex = JSON.parse(fs.readFileSync(path.join(exchanges, f), 'utf8')); return `${ex.request.method} ${ex.request.path}`; }))],
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Belt and braces over the recorder's own check: the run's real secret values must not appear.
  const setupCode = log.join('').match(/FIRST-RUN SETUP CODE: (\S+)/)?.[1];
  const raw = [ADMIN.password, MEMBER.password, setupCode].filter(Boolean);
  for (const f of fs.readdirSync(exchanges)) {
    const text = fs.readFileSync(path.join(exchanges, f), 'utf8');
    for (const v of raw) if (text.includes(v)) throw new Error(`${f} holds a raw secret`);
    if (/cowork_(session|csrf)=(?!<secret:)[^;"\s]/.test(text)) throw new Error(`${f} holds a raw cookie`);
  }
  console.log(`contract corpus: ${files.length} exchanges (${dropped.length} dropped) from ${steps.length} steps in ${out}`);
  if (dropped.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
