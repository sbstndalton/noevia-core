'use strict';
// Test-only immutable JS policy. Compile at its original directory so the unchanged source's
// host imports resolve normally. Production never imports this loader or the frozen source.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const bytes = fs.readFileSync(path.join(__dirname, 'task-lifecycle-1896.source.cjs'));
if (crypto.createHash('sha256').update(bytes).digest('hex') !== '7a767393ec65a77c56d10fd956e6a7208e535b81e35ab55193ad0ef4bdd7bf50') throw Error('Frozen lifecycle oracle checksum mismatch');
const filename = path.join(root, 'server/task-lifecycle-immutable-oracle.cjs');
const oracle = new Module(filename, module);
oracle.filename = filename;
oracle.paths = Module._nodeModulePaths(path.dirname(filename));
oracle._compile(bytes.toString('utf8'), filename);
module.exports = oracle.exports;
