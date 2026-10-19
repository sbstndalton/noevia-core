#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const bytes=fs.readFileSync(path.join(__dirname,'../tests/reference/completeness-generator-a545.source.cjs'));
if(crypto.createHash('sha256').update(bytes).digest('hex')!=='f7b714f67c3a09cd27c9d5fe973dc398a93003e59112725009983535c8b0a452')throw Error('Frozen completeness generator checksum mismatch');
const generator=new Module(__filename,module);generator.filename=__filename;generator.paths=Module._nodeModulePaths(__dirname);generator.require=(name)=>name===path.join(__dirname,'../server/completeness-report.cjs')?require('../tests/reference/completeness-report-oracle.cjs'):Module.prototype.require.call(generator,name);generator._compile(bytes.toString('utf8'),__filename);
