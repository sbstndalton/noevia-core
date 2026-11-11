'use strict';
const test=require('node:test');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path');
test('native clients refuse unavailable and malformed authority responses without local routing fallback',async()=>{
 await promisify(execFile)(process.execPath,['--require',path.join(__dirname,'../tests/reference/native-machines-fetch.fixture.cjs'),path.join(__dirname,'../tests/reference/native-machines-client.probe.cjs')],{timeout:30000});
});
