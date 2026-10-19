'use strict';
// Test-only independent immutable policy; production never imports this file.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const bytes=fs.readFileSync(path.join(__dirname,'completeness-report-a545.source.cjs'));
if(crypto.createHash('sha256').update(bytes).digest('hex')!=='7f276e4a146bbc1c9e1649dc852de483b1467d991d4ab6e31337e9e4bc1aa6fe')throw Error('Frozen completeness oracle checksum mismatch');
const filename=path.resolve(__dirname,'../../server/completeness-immutable-oracle.cjs');
const oracle=new Module(filename,module);oracle.filename=filename;oracle.paths=Module._nodeModulePaths(path.dirname(filename));oracle._compile(bytes.toString('utf8'),filename);module.exports=oracle.exports;
