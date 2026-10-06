const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),zlib=require('node:zlib');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../../src/components/data/readExport.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports_={};vm.runInNewContext(code,{exports:exports_,TextDecoder,DataView,Uint8Array,Response,Blob,DecompressionStream,Error});
const {readConversationsFile:read}=exports_;
const {zipStore}=require('../../server/chat-export.cjs');
const blob=(buf)=>new Blob([buf]);
// A deflated single-entry zip built by hand (what macOS "Compress" produces for a re-zipped export).
function deflateZip(name,text){const data=Buffer.from(text),comp=zlib.deflateRawSync(data),n=Buffer.from(name),crc=zlib.crc32(data);
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(comp.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(comp.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(0,42);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+n.length,12);end.writeUInt32LE(30+n.length+comp.length,16);
 return Buffer.concat([local,n,comp,central,n,end]);}
test('reads conversations.json from a plain file, a stored export zip and a deflated re-zip',async()=>{
 assert.equal(await read(blob(Buffer.from('{"a":1}'))),'{"a":1}');
 const stored=zipStore([{name:'README.md',data:Buffer.from('x')},{name:'conversations.json',data:Buffer.from('{"format":"noevia-conversations-v1"}')}]);
 assert.equal(await read(blob(stored)),'{"format":"noevia-conversations-v1"}');
 assert.equal(await read(blob(deflateZip('noevia-conversations-2026-09-17/conversations.json','{"b":2}'))),'{"b":2}');
});
test('a zip without conversations.json explains what to choose',async()=>{
 await assert.rejects(read(blob(zipStore([{name:'README.md',data:Buffer.from('x')}]))),/no conversations\.json/);
});
