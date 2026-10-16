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
// Synthetic accounts for a throwaway data dir; the recorder writes their cookies as placeholders only.
const ADMIN = { username: 'synthetic-admin', displayName: 'Synthetic Admin' };
const MEMBER = { username: 'synthetic-member', displayName: 'Synthetic Member', role: 'member' };
// A 1x1 PNG for the project image steps (M4). The recorder takes a value this random-looking for a
// secret, so the manifest hands it to the replayer as an input like the passwords.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

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
// sampling, routing mode and default, ChatGPT status, storage metadata/list/read, export) are not
// Node's to record any more;
// their exchanges stay in the noevia-rs corpus recorded at its contracts/http/core.ref.
const PROBES = [
  '/api/account/retention',
  '/api/admin/decision-settings', '/api/admin/features', '/api/admin/mcp-directory', '/api/admin/offsite-backup', '/api/admin/web-address',
  '/api/auto-roles', '/api/chat-framing/preferences', '/api/chat-vault-mirror/preferences', '/api/code/active',
  '/api/connectors', '/api/connectors/gdrive/policy', '/api/connectors/nextcloud/policy', '/api/diary', '/api/diary-connector', '/api/diary/source', '/api/diary/storage-status',
  '/api/mcp-keys/servers', '/api/mcp-oauth/servers', '/api/model-manager',
  '/api/models/autotune', '/api/models/autotune/settings', '/api/models/autotune/untuned', '/api/models/calibration', '/api/models/capabilities', '/api/models/evidence',
  '/api/models/hardware', '/api/models/inference-budget', '/api/models/installed', '/api/plugins/directory',
  '/api/profile/diary-connectors', '/api/profile/sharing',
  '/api/providers', '/api/providers/{providerId}/models', '/api/reasoning-settings',
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
  ['GET', '/api/diary/today'],
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
  // The seeded sessions' raw values, which must never reach the corpus.
  const secrets = [];
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
    await step(admin, 'GET', '/api/features', undefined, [200]);
    // A write without the CSRF header is refused.
    const noCsrf = new Client(base, base); noCsrf.jar = new Map([...admin.jar].filter(([k]) => k !== 'cowork_csrf'));
    await step(noCsrf, 'POST', '/api/projects', { name: 'no csrf' });

    // Projects.
    const created = await step(admin, 'POST', '/api/projects', { name: 'Synthetic project', goal: 'Contract corpus', instructions: 'Answer briefly.', model: MODEL, files: [{ name: 'notes.md', content: '# Synthetic notes\n\nAlpha beta gamma.' }] }, [200, 201]);
    const projectId = created.json?.id || created.json?.project?.id;
    if (!projectId) throw new Error(`project id missing from ${created.text.slice(0, 200)}`);
    await step(admin, 'GET', '/api/workspace', undefined, [200]);
    await step(admin, 'POST', `/api/projects/${encodeURIComponent(projectId)}/config`, { instructions: 'Answer very briefly.' });
    await step(admin, 'GET', `/api/projects/${encodeURIComponent(projectId)}/chats`);

    // M4 (NOEVIA_RUST_PROJECTS): a project's images, with the refusals and the tenant boundary.
    const assets = `/api/projects/${encodeURIComponent(projectId)}/assets`;
    const image = await step(admin, 'POST', assets, { name: 'pixel.png', mime: 'IMAGE/PNG', dataBase64: PNG }, [200]);
    const assetId = image.json?.asset?.id;
    if (!assetId) throw new Error(`asset id missing from ${image.text.slice(0, 200)}`);
    await step(admin, 'POST', assets, { name: 'notes.txt', mime: 'text/plain', dataBase64: PNG }, [400]);
    await step(admin, 'POST', assets, { name: 'empty.png', mime: 'image/png', dataBase64: '' }, [400]);
    await step(admin, 'POST', assets, { name: 'loose.gif', mime: 'image/gif', dataBase64: 'R0lG OD lh\nAQAB!AAAA=ignored' }, [200]);
    await step(admin, 'POST', assets, { name: ['a', null, 7], mime: 'image/webp', dataBase64: PNG }, [200]);
    // Node reads each UTF-16 unit of a two-byte string by its low byte: U+0144 is 'D', U+D83D '='.
    await step(admin, 'POST', assets, { name: 'two-byte.png', mime: 'image/png', dataBase64: 'QUJ\u0144QU\u{1F600}JD' }, [200]);
    await step(admin, 'POST', `/api/projects/no-such-project/assets`, { name: 'x.png', mime: 'image/png', dataBase64: PNG }, [404]);
    await step(admin, 'GET', `${assets}/${encodeURIComponent(assetId)}`, undefined, [200]);
    await step(admin, 'GET', `${assets}/no-such-image`, undefined, [404]);
    await step(noCsrf, 'POST', assets, { name: 'x.png', mime: 'image/png', dataBase64: PNG }, [403]);
    await step(anon, 'GET', `${assets}/${encodeURIComponent(assetId)}`, undefined, [401]);
    await step(admin, 'GET', '/api/workspace', undefined, [200]);

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

    // A second account (seeded above): the tenant boundary is part of the contract.
    await step(member, 'GET', '/api/workspace');
    await step(member, 'GET', `/api/projects/${encodeURIComponent(projectId)}/chats`);
    // Another account's project image is not this account's (M4).
    await step(member, 'GET', `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`, undefined, [404]);
    await step(member, 'DELETE', `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`, undefined, [404]);
    if (chatId) await step(member, 'GET', `/api/chats/${encodeURIComponent(chatId)}/history`);
    await step(member, 'GET', '/api/admin/web-address', undefined, [403]);
    const memberId = seeded.member.id;

    // The reasoning default's PUT and the routing configuration are the Rust front's since #1071
    // (their exchanges stay in the noevia-rs corpus recorded at its core.ref); the GET is Node's.
    await step(admin, 'GET', '/api/reasoning-settings', undefined, [200]);

    // Read probes for the rest of the client's paths.
    const fill = { projectId, providerId: 'default', chatId: chatId || 'missing-chat' };
    for (const p of PROBES) await step(admin, 'GET', p.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(fill[k] || k)));

    for (const [method, p, body] of WRITE_PROBES) await step(admin, method, p, body);

    // Clean-up is part of the contract too.
    await step(admin, 'DELETE', `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`, undefined, [200]);
    await step(admin, 'GET', `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`, undefined, [404]);
    if (chatId) await step(admin, 'DELETE', `/api/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}`);
    await step(admin, 'DELETE', `/api/projects/${encodeURIComponent(projectId)}`);
    await step(admin, 'GET', '/api/workspace', undefined, [200]);
    if (memberId) await step(admin, 'DELETE', `/api/admin/users/${encodeURIComponent(memberId)}`, { username: MEMBER.username });

    // M4 (NOEVIA_RUST_PROJECTS): a project's chat list, saved and read back, with the refusals. After
    // the clean-up, so every earlier exchange keeps its place; the list's project is left in place.
    const listed = await step(admin, 'POST', '/api/projects', { name: 'Synthetic chat list' }, [200]);
    const listId = listed.json?.id;
    if (!listId) throw new Error(`project id missing from ${listed.text.slice(0, 200)}`);
    const list = `/api/projects/${encodeURIComponent(listId)}/chats`;
    await step(admin, 'POST', '/api/freechats', { chats: [{ id: 'free-alpha', title: 'Free alpha', updatedAt: 5, preview: '' }] }, [200]);
    await step(admin, 'GET', list, undefined, [200]);
    await step(admin, 'POST', list, { chats: [
      { id: 'chat-alpha', title: 'Alpha', updatedAt: 300, preview: 'First', pinned: true, forceLocal: true, createdAt: 100, mode: 'cowork',
        frame: { kind: 'question', tags: ['#alpha  beta', 'alpha-beta', 7], links: ['chat-beta', 'chat-beta'], confirmed: true, source: 'user' } },
      { id: 'chat beta/../x', title: { a: 1 }, preview: ['p', null, 3], updatedAt: 200 },
      // Another list holds it: skipped, and said so.
      { id: 'free-alpha', title: 'Moved elsewhere', updatedAt: 400 },
      // Deleted above: tombstoned, never comes back.
      ...(chatId ? [{ id: chatId, title: 'Deleted chat', updatedAt: 500 }] : []),
      { id: 'chat-gamma', title: `${'g'.repeat(118)}\u{1F600}tail`, preview: '', updatedAt: 250, frame: { kind: 'bogus' } },
      'stray', null, { title: 'no id' },
    ] }, [200]);
    await step(admin, 'GET', list, undefined, [200]);
    // A later save keeps the stored flags and first createdAt; frame null clears the frame.
    await step(admin, 'POST', list, { chats: [{ id: 'chat-alpha', title: 'Alpha renamed', updatedAt: 350, frame: null }, { id: 'chat-gamma', updatedAt: 260, allowCloud: false, createdAt: 7 }] }, [200]);
    await step(admin, 'GET', list, undefined, [200]);
    await step(admin, 'POST', list, { chats: 'not a list' }, [400]);
    await step(admin, 'POST', list, null, [400]);
    await step(admin, 'POST', '/api/projects/no-such-project/chats', { chats: [] }, [404]);
    await step(admin, 'GET', '/api/projects/no-such-project/chats', undefined, [404]);
    await step(noCsrf, 'POST', list, { chats: [] }, [403]);
    await step(anon, 'GET', list, undefined, [401]);
    await step(anon, 'POST', list, { chats: [] }, [401]);

    // M4 (NOEVIA_RUST_PROJECTS, rust-free-chats): the free-chat list, saved and read back while
    // Node's own writers of free-chats.json (a chat's move, a free chat's delete) run between the
    // saves, with the refusals. Appended, so every earlier exchange keeps its place.
    const free = '/api/freechats';
    await step(admin, 'GET', free, undefined, [200]);
    await step(admin, 'POST', free, { chats: [
      { id: 'free-beta', title: 'Beta', updatedAt: 600, preview: 'Second', pinned: true, archived: false, forceLocal: false, createdAt: 50, mode: 'cowork',
        frame: { kind: 'idea', tags: ['#beta  one', 'beta-one', 3], links: ['free-alpha', 'free-alpha'], confirmed: true, source: 'user' } },
      { id: 'free gamma/../x', title: { a: 1 }, preview: ['p', null, 3], updatedAt: 550 },
      // A project's list holds it: skipped, and said so.
      { id: 'chat-alpha', title: 'Moved elsewhere', updatedAt: 700 },
      // Deleted above: tombstoned, never comes back.
      ...(chatId ? [{ id: chatId, title: 'Deleted chat', updatedAt: 800 }] : []),
      { id: 'free-delta', title: `${'d'.repeat(118)}\u{1F600}tail`, preview: '', updatedAt: 500, frame: { kind: 'bogus' }, mode: 'code' },
      'stray', null, { title: 'no id' },
    ] }, [200]);
    await step(admin, 'GET', free, undefined, [200]);
    // A later save keeps the stored flags and first createdAt; frame null clears the frame.
    await step(admin, 'POST', free, { chats: [{ id: 'free-beta', title: 'Beta renamed', updatedAt: 650, frame: null }, { id: 'free-alpha', updatedAt: 6, allowCloud: false, createdAt: 7 }] }, [200]);
    await step(admin, 'GET', free, undefined, [200]);
    // Node moves a free chat into a project and back (both lists, both files) between the saves.
    await step(admin, 'POST', `/api/chats/free-alpha/move`, { projectId: listId }, [200]);
    await step(admin, 'GET', free, undefined, [200]);
    await step(admin, 'POST', free, { chats: [{ id: 'free-alpha', title: 'Stale tab', updatedAt: 9 }] }, [200]);
    await step(admin, 'GET', list, undefined, [200]);
    await step(admin, 'POST', `/api/chats/free-alpha/move`, { projectId: null }, [200]);
    await step(admin, 'GET', free, undefined, [200]);
    // Node deletes one (tombstone, transcript); a stale save cannot bring it back.
    await step(admin, 'DELETE', `${free}/free-delta`, undefined, [200]);
    await step(admin, 'GET', free, undefined, [200]);
    await step(admin, 'POST', free, { chats: [{ id: 'free-delta', title: 'Stale tab', updatedAt: 900 }] }, [200]);
    await step(admin, 'GET', free, undefined, [200]);
    await step(admin, 'POST', free, { chats: 'not a list' }, [400]);
    await step(admin, 'POST', free, null, [400]);
    await step(admin, 'POST', free, { chats: [{ id: 'free-eps', updatedAt: 1, createdAt: 2 }], extra: 'ignored' }, [200]);
    await step(noCsrf, 'POST', free, { chats: [] }, [403]);
    await step(anon, 'GET', free, undefined, [401]);
    await step(anon, 'POST', free, { chats: [] }, [401]);
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
    if (typeof b.dataBase64 === 'string' && b.dataBase64.startsWith('<secret:')) inputs[b.dataBase64] = { value: PNG };
  }
  const manifest = {
    v: 1,
    generator: 'noevia-core tools/contract-corpus/generate.cjs',
    seed: 'synthetic-accounts',
    note: 'Recorded with two synthetic accounts and their sessions seeded straight into UI_DATA_DIR/cowork.db (tests/server/seed-account.cjs): sign-in is the Rust front\'s (sbstndalton/noevia#1071), so a replay needs the same seeding and binds the session cookies itself. The image data is synthetic.',
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
