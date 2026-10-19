'use strict';
// Required historical runtime: execute the exact pre-retirement source/assertions with only
// its completeness import and jobs guard bound to the checksum-frozen independent policy.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const oracle=require('../tests/reference/completeness-report-oracle.cjs');
const hash=(bytes)=>crypto.createHash('sha256').update(bytes).digest('hex');
const bytes=fs.readFileSync(path.join(__dirname,'../tests/reference/completeness-switch-a545.source.cjs'));
if(hash(bytes)!=='135d2331a3a9ca29621ae23d5b42542411106675dd778b6eb43d11faebb0fb9d')throw Error('Frozen completeness historical assertions checksum mismatch');
let jobs;
function historicalJobs(){if(jobs)return jobs;const filename=path.join(__dirname,'jobs.cjs');const source=fs.readFileSync(filename);if(hash(source)!=='7f9132fa1159a2f7351781cb44ccaab513188843f7b36ef35b973e88fde71775')throw Error('Historical jobs host source binding changed');const moduleClone=new Module(filename,module);moduleClone.filename=filename;moduleClone.paths=Module._nodeModulePaths(__dirname);moduleClone.require=(name)=>name==='./completeness-report.cjs'?oracle:Module.prototype.require.call(moduleClone,name);moduleClone._compile(source.toString('utf8'),filename);jobs=moduleClone.exports;return jobs;}
const filename=path.join(__dirname,'completeness-historical-assertions.cjs');const historical=new Module(filename,module);historical.filename=filename;historical.paths=Module._nodeModulePaths(__dirname);historical.require=(name)=>name==='./completeness-report.cjs'?oracle:name==='./jobs.cjs'?historicalJobs():Module.prototype.require.call(historical,name);historical._compile(bytes.toString('utf8'),filename);
