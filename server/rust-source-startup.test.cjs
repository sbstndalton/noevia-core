'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
test('source-text startup sweep belongs to the native server before it serves',()=>{
  const source=fs.readFileSync(require.resolve('./index.cjs'),'utf8');
  assert.doesNotMatch(source,/workspaceStore\.migrateSourceText\(/);
});
