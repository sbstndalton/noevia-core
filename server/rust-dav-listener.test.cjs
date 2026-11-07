'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('DAV listener is owned by the paired native server',()=>{
 const source=fs.readFileSync(require.resolve('./index.cjs'),'utf8');
 assert.doesNotMatch(source,/davServer|createDavHandler|davConfig\.available/);
 assert.equal(require('./rust-dav-listener.cjs').RUST_DAV_LISTENER_OWNED,'rust-dav-listener-v1');
});
test('live application has no DAV handler or mutation translator',()=>{
 assert.equal(fs.existsSync(__dirname+'/dav.cjs'),false);
 assert.equal(fs.existsSync(__dirname+'/dav-ops.cjs'),false);
});
