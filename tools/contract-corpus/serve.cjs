#!/usr/bin/env node
'use strict';
// Boots server/index.cjs the way generate.cjs recorded the corpus (same mocks, same clean
// environment, same outbound guard), on UI_DATA_DIR / UI_PORT from the environment, so noevia-rs
// tools/replay can replay the corpus against Node:
//
//   replay run --corpus contracts/http/corpus --base http://127.0.0.1:18021 --seed <empty dir> \
//     --server-cmd 'node <noevia-core>/tools/contract-corpus/serve.cjs'
//
// Recording stays off. SIGTERM/SIGINT stop the server and the mocks.
const { spawn } = require('node:child_process');
const { SERVER, GUARD, startMocks, serverEnv } = require('./mocks.cjs');

async function main() {
  const dataDir = process.env.UI_DATA_DIR;
  const port = Number(process.env.UI_PORT);
  if (!dataDir || !port) throw new Error('serve.cjs needs UI_DATA_DIR and UI_PORT');
  const mocks = await startMocks();
  const env = serverEnv({ port, dataDir, origin: process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`, mocks });
  // noevia-rs replays the corpus through its front with the M3 switch on (sign-in and the account
  // in Rust): Node then runs read-only for those tables, as it would behind that front.
  // The guard also needs the supervisor's confirmation (rust-auth.cjs enabledFrom), passed through.
  if (process.env.NOEVIA_RUST_AUTH === '1') Object.assign(env, { NOEVIA_RUST_AUTH: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH_CONFIRMED: process.env.NOEVIA_RUST_AUTH_CONFIRMED === '1' ? '1' : '' });
  // M4 (rust-projects.cjs): projects.json shared with the front, the image writes refused here,
  // and the chat-list save too when the front's chat slice is confirmed separately (#1409), and the
  // free-chat save when its slice is.
  if (process.env.NOEVIA_RUST_PROJECTS === '1') Object.assign(env, { NOEVIA_RUST_PROJECTS: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_PROJECTS_CONFIRMED: process.env.NOEVIA_RUST_PROJECTS_CONFIRMED === '1' ? '1' : '', NOEVIA_RUST_PROJECT_CHATS_CONFIRMED: process.env.NOEVIA_RUST_PROJECT_CHATS_CONFIRMED === '1' ? '1' : '', NOEVIA_RUST_FREE_CHATS_CONFIRMED: process.env.NOEVIA_RUST_FREE_CHATS_CONFIRMED === '1' ? '1' : '' });
  // M6 reporting refusal proves a clean replay was native, never a silent proxy fallback.
  if (process.env.NOEVIA_RUST_USAGE === '1') Object.assign(env, { NOEVIA_RUST_USAGE: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_USAGE_CONFIRMED: process.env.NOEVIA_RUST_USAGE_CONFIRMED === '1' ? '1' : '' });
  // M6 sampling owns one setting; carry the same confirmed refusal through the child boundary.
  if (process.env.NOEVIA_RUST_SAMPLING_SETTINGS === '1') Object.assign(env, { NOEVIA_RUST_SAMPLING_SETTINGS: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_SAMPLING_SETTINGS_CONFIRMED: process.env.NOEVIA_RUST_SAMPLING_SETTINGS_CONFIRMED === '1' ? '1' : '' });
  // M6 default PUT is refused only after native auth and its capability are confirmed.
  if (process.env.NOEVIA_RUST_REASONING_SETTINGS === '1') Object.assign(env, { NOEVIA_RUST_REASONING_SETTINGS: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_REASONING_SETTINGS_CONFIRMED: process.env.NOEVIA_RUST_REASONING_SETTINGS_CONFIRMED === '1' ? '1' : '' });
  if (process.env.NOEVIA_RUST_ROUTING_MODE === '1') Object.assign(env, { NOEVIA_RUST_ROUTING_MODE: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_ROUTING_MODE_CONFIRMED: process.env.NOEVIA_RUST_ROUTING_MODE_CONFIRMED === '1' ? '1' : '' });
  const child = spawn(process.execPath, ['--require', GUARD, SERVER], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  // Server warnings go to stderr, minus the first-run setup code (the replayer reads it from the
  // data dir; a log is no place for it, synthetic or not).
  child.stderr.on('data', (d) => {
    const text = String(d).split('\n').filter((l) => !/SETUP CODE|Setup code file/.test(l)).join('\n');
    if (text.trim()) process.stderr.write(`${text}\n`);
  });
  const stop = () => { child.kill('SIGTERM'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  child.on('exit', (code) => { mocks.close(); process.exit(code ?? 0); });
}

// Fixed actual-factory collaborator seam. Rust owns every input case, source check, output
// assertion, hash and process lifetime. This branch never boots index.cjs or an engine.
async function routingModeOracle() {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { Readable } = require('node:stream');
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-routing-oracle-'));
  const now = Date.now, warn = console.warn;
  Date.now = () => 1800000000000; console.warn = () => {};
  let auth;
  try {
    auth = require('../../server/auth.cjs').createAuth({ dataDir: dir, publicOrigin: 'http://127.0.0.1:8021', rpId: '127.0.0.1' });
    const db = auth.db, http = require('../../server/http.cjs'), rm = require('../../server/routing-modes.cjs'), featureLib = require('../../server/features.cjs');
    const actor = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    db.prepare("INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'x','synthetic',1,1)").run(actor, 'synthetic', 'synthetic', 'Synthetic', 'admin');
      const store = featureLib.settingsStore(db), out = [];
    for (const c of input.cases) {
      const originalEnv = { ...process.env };
      if (c.runtimeDefaults) {
        for (const key of ['NOEVIA_FRONT','NOEVIA_RUST_AUTH','NOEVIA_RUST_AUTH_CONFIRMED','NOEVIA_RUST_ROUTING_MODE','NOEVIA_RUST_ROUTING_MODE_CONFIRMED']) delete process.env[key];
        Object.assign(process.env, c.routeEnv);
      }
      db.exec('DROP TRIGGER IF EXISTS routing_audit_abort; DELETE FROM settings; DELETE FROM audit_events;');
      const file = path.join(dir, rm.FILE); fs.rmSync(file, { force: true });
      if (c.file !== null) fs.writeFileSync(file, Buffer.from(c.file, 'hex'));
      if (c.allowed !== null) store.set(rm.ALLOWED_KEY, c.allowed);
      if (c.feature !== null) store.set('feature:routingModes', c.feature);
      let features, featureError = null;
      try { features = featureLib.createFeatures({ env: c.env, store, registry: { routingModes: featureLib.REGISTRY.routingModes }, audit: (action, id, detail) => auth.audit(action, id, id, detail) }); }
      catch (e) { featureError = e.message; }
      if (c.auditAbort) db.exec("CREATE TRIGGER routing_audit_abort BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit refusal'); END;");
      if (c.featureUpdate !== null && features) { try { features.set('routingModes', c.featureUpdate, actor); } catch {} }
      if (c.directFeature !== null) store.set('feature:routingModes', c.directFeature);
      const featureProbe = features && c.featureProbe === 'flags' ? features.flags().routingModes
        : features && c.featureProbe === 'describe' ? features.describe()[0].enabled : null;
      let response = null;
      let bodyConsumed = false;
      if (features) {
        const route = require('../../server/routes/routing-mode.cjs').createRoutingModeRoutes({ json: http.json, readBody: async (...args) => { bodyConsumed = true; return http.readBody(...args); }, enabled: () => features.enabled('routingModes'), currentWorkspace: () => ({ dir }), store, audit: (action, id, detail) => auth.audit(action, id, id, detail), ...(c.runtimeDefaults ? {} : { env: c.routeEnv }) });
        const req = c.readError ? Readable.from((async function* () { throw Error('synthetic read failure'); })()) : Readable.from([Buffer.from(c.body, 'hex')]); req.method = c.method;
        const res = { writeHead: status => { response = { status }; }, end: raw => { response.body = JSON.parse(raw); } };
        await route(req, res, { path: c.path, authn: { user: { id: actor, role: c.role } } });
      }
      let guardError = null;
      if (c.guardAction) {
        const indirect = {
          indirect: "INSERT OR REPLACE INTO settings VALUES('routing_modes_allowed','[]');",
          'indirect-update': "UPDATE settings SET value='[]' WHERE key='routing_modes_allowed';",
          'indirect-delete': "DELETE FROM settings WHERE key='routing_modes_allowed';",
          'rename-in': "UPDATE settings SET key='routing_modes_allowed' WHERE key='synthetic_unowned';",
          'rename-out': "UPDATE settings SET key='synthetic_unowned' WHERE key='routing_modes_allowed';",
        }[c.guardAction];
        if (c.guardAction === 'rename-in') db.prepare("DELETE FROM settings WHERE key='routing_modes_allowed'").run();
        if (c.guardAction === 'rename-in') store.set('synthetic_unowned', '["cloud","hybrid"]');
        if (indirect) db.exec(`CREATE TEMP TABLE synthetic_routing_sink(x); CREATE TEMP TRIGGER synthetic_routing_write AFTER INSERT ON synthetic_routing_sink BEGIN ${indirect} END;`);
        require('../../server/rust-auth.cjs').createRustAuthGuard({ routingModeEnabled: c.runtimeDefaults ? rm.rustOwned() : rm.rustOwned(c.routeEnv) }).install(db);
        try {
          if (c.guardAction === 'file') c.runtimeDefaults ? rm.write(dir, { mode: 'local' }) : rm.write(dir, { mode: 'local' }, c.routeEnv);
          else if (c.guardAction === 'allowed') c.runtimeDefaults ? rm.setAllowedModes(store, ['local']) : rm.setAllowedModes(store, ['local'], c.routeEnv);
          else if (c.guardAction === 'insert') db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(rm.ALLOWED_KEY, '["local"]');
          else if (c.guardAction === 'update') db.prepare("UPDATE settings SET value='[]' WHERE key='routing_modes_allowed'").run();
          else if (c.guardAction === 'delete') db.prepare("DELETE FROM settings WHERE key='routing_modes_allowed'").run();
          else if (indirect) db.prepare('INSERT INTO synthetic_routing_sink VALUES(1)').run();
          else if (c.guardAction === 'feature') store.set('feature:routingModes', 'true');
          else throw Error('unsupported fixed routing guard collaborator');
        } catch (e) { guardError = e.code || e.message; }
      }
      out.push({ response, featureError, featureEnabled: features ? features.enabled('routingModes') : null,
        guardError, bodyConsumed, featureProbe,
        featureDescription: features ? features.describe()[0] : null,
        file: fs.existsSync(file) ? fs.readFileSync(file).toString('hex') : null,
        allowed: store.get(rm.ALLOWED_KEY) ?? null, unowned: store.get('synthetic_unowned') ?? null, feature: store.get('feature:routingModes') ?? null,
        audit: db.prepare('SELECT actor_user_id,target_user_id,action,detail,created_at FROM audit_events ORDER BY id').all().map(a => ({ ...a, detail: JSON.parse(a.detail) })) });
      if (c.runtimeDefaults) { for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]; Object.assign(process.env, originalEnv); }
    }
    process.stdout.write(JSON.stringify(out));
  } finally { auth?.db.close(); Date.now = now; console.warn = warn; fs.rmSync(dir, { recursive: true, force: true }); }
}
(process.argv[2] === '--routing-mode-oracle' ? routingModeOracle() : main()).catch((err) => { console.error(err.message); process.exit(1); });
