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
  // M4 (rust-projects.cjs): projects.json shared with the front, the image writes refused here.
  if (process.env.NOEVIA_RUST_PROJECTS === '1') Object.assign(env, { NOEVIA_RUST_PROJECTS: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_PROJECTS_CONFIRMED: process.env.NOEVIA_RUST_PROJECTS_CONFIRMED === '1' ? '1' : '' });
  // M6 reporting refusal proves a clean replay was native, never a silent proxy fallback.
  if (process.env.NOEVIA_RUST_USAGE === '1') Object.assign(env, { NOEVIA_RUST_USAGE: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_USAGE_CONFIRMED: process.env.NOEVIA_RUST_USAGE_CONFIRMED === '1' ? '1' : '' });
  // M6 sampling owns one setting; carry the same confirmed refusal through the child boundary.
  if (process.env.NOEVIA_RUST_SAMPLING_SETTINGS === '1') Object.assign(env, { NOEVIA_RUST_SAMPLING_SETTINGS: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_SAMPLING_SETTINGS_CONFIRMED: process.env.NOEVIA_RUST_SAMPLING_SETTINGS_CONFIRMED === '1' ? '1' : '' });
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

main().catch((err) => { console.error(err.message); process.exit(1); });
