#!/usr/bin/env node
'use strict';
// Execute the byte-frozen independent generator against the byte-frozen JS oracle.
// Neither expectations nor seeded journal construction come from the native candidate.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const file = path.join(__dirname, '../tests/reference/task-lifecycle-generator-1896.source.cjs');
const bytes = fs.readFileSync(file);
if (crypto.createHash('sha256').update(bytes).digest('hex') !== '7ba4d2df1ae3180d9f5a6bda097b443bdb07e85e31a7d4f26da261c06698764f') throw Error('Frozen lifecycle generator checksum mismatch');
const generator = new Module(__filename, module);
generator.filename = __filename;
generator.paths = Module._nodeModulePaths(__dirname);
generator.require = (name) => name === path.join(__dirname, '../server/task-lifecycle.cjs')
  ? require('../tests/reference/task-lifecycle-oracle.cjs')
  : Module.prototype.require.call(generator, name);
generator._compile(bytes.toString('utf8'), __filename);
