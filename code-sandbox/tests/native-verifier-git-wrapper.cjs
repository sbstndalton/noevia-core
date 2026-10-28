#!/usr/local/bin/node
'use strict';
// Readonly owned fault input, mounted only in the copy-descendant case. Delegate
// to the image's real Git, then leave a git-UID escaped pipe holder to be drained.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1002);
assert.match(fs.readFileSync('/proc/1/status', 'utf8'), /^CapEff:\s+0*c0$/m);
const args = process.argv.slice(2);
const result = spawnSync('/usr/bin/git', args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (args.includes('clone')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 1, 2] });
  child.once('error', (error) => { throw error; }); child.unref();
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  fs.writeFileSync('/qualification-proof/copy-started', JSON.stringify({ uid: process.getuid(), pid: child.pid }), { mode: 0o644 });
}
