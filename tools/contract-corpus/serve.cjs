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
  // Sign-in and the account are the Rust front's (sbstndalton/noevia#1071): Node always runs
  // read-only for those tables and refuses their routes, so there is no switch to pass through.
  // M4 (rust-projects.cjs): projects.json shared with the front, the image writes refused here,
  // and the chat-list save too when the front's chat slice is confirmed separately (#1409), and the
  // free-chat save when its slice is.
  if (process.env.NOEVIA_RUST_PROJECTS === '1') Object.assign(env, { NOEVIA_RUST_PROJECTS: '1', NOEVIA_FRONT: 'rust', NOEVIA_RUST_PROJECTS_CONFIRMED: process.env.NOEVIA_RUST_PROJECTS_CONFIRMED === '1' ? '1' : '', NOEVIA_RUST_PROJECT_CHATS_CONFIRMED: process.env.NOEVIA_RUST_PROJECT_CHATS_CONFIRMED === '1' ? '1' : '', NOEVIA_RUST_FREE_CHATS_CONFIRMED: process.env.NOEVIA_RUST_FREE_CHATS_CONFIRMED === '1' ? '1' : '', NOEVIA_RUST_PROJECT_WRITES: process.env.NOEVIA_RUST_PROJECT_WRITES === '1' ? '1' : '', NOEVIA_RUST_PROJECT_WRITES_CONFIRMED: process.env.NOEVIA_RUST_PROJECT_WRITES_CONFIRMED === '1' ? '1' : '' });
  // #1264: Node's projects.json / free-chats.json saves through the front's internal store.
  if (process.env.NOEVIA_RUST_PROJECT_STORE === '1') Object.assign(env, { NOEVIA_RUST_PROJECT_STORE: '1', NOEVIA_RUST_PROJECT_STORE_CONFIRMED: process.env.NOEVIA_RUST_PROJECT_STORE_CONFIRMED === '1' ? '1' : '', NOEVIA_PROJECT_STORE_PORT: process.env.NOEVIA_PROJECT_STORE_PORT || '', NOEVIA_PROJECT_STORE_TOKEN: process.env.NOEVIA_PROJECT_STORE_TOKEN || '' });
  // sbstndalton/noevia#1071: usage, sampling/reasoning/routing settings, routing default, stats,
  // export, ChatGPT status and storage reads have no switch any more; Node refuses them always.
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
