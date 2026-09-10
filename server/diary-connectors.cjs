'use strict';
const crypto=require('node:crypto');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
function createCredentials(auth){
 const db=auth.db;
 db.exec(`CREATE TABLE IF NOT EXISTS diary_connectors(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,token_hash TEXT NOT NULL,created_at INTEGER NOT NULL)`);
 const list=userId=>db.prepare('SELECT id,name,created_at AS createdAt FROM diary_connectors WHERE user_id=?').all(userId);
 return {list,
  create(userId,name){
   if(typeof name!=='string'||!name.trim()||name.length>80)throw Error('Connector name required (maximum 80 characters)');
   if(!auth.diaryEnabled(userId)||!db.prepare('SELECT id FROM users WHERE id=? AND disabled_at IS NULL').get(userId))throw Error('Diary account unavailable');
   if(list(userId).length>=10)throw Error('Revoke an existing connector first');
   const id=crypto.randomBytes(16).toString('hex'),token='nv_diary_'+id+'.'+crypto.randomBytes(32).toString('base64url');
   db.prepare('INSERT INTO diary_connectors VALUES(?,?,?,?,?)').run(id,userId,name.trim(),digest(token),Date.now());
   auth.audit('diary-connector.create',userId,userId,{id,name:name.trim()});return {id,token};
  },
  revoke(userId,id){const ok=db.prepare('DELETE FROM diary_connectors WHERE user_id=? AND id=?').run(userId,id).changes>0;if(ok)auth.audit('diary-connector.revoke',userId,userId,{id});return ok;},
  verify(token){
   if(typeof token!=='string'||!/^nv_diary_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(token))return null;
   const row=db.prepare('SELECT c.id,c.user_id FROM diary_connectors c JOIN users u ON c.user_id=u.id WHERE c.token_hash=? AND u.disabled_at IS NULL').get(digest(token));
   return row&&auth.diaryEnabled(row.user_id)?{userId:row.user_id,id:row.id}:null;
  }
 };
}
function safePath(value,dir=false){
 if(typeof value!=='string'||value.length>500||/[\\\x00-\x1f\x7f]/.test(value)||(!dir&&!value.toLowerCase().endsWith('.md'))||(value!==''&&value.split('/').some(p=>!p||p.startsWith('.')))||(!dir&&!value))throw Object.assign(Error('Choose a Markdown path inside the Diary'),{status:400});
 return value;
}
async function operate(identity,body,files,allowed){
 if(!allowed())throw Object.assign(Error('Connector was revoked or Diary disabled'),{status:403});
 const path=safePath(body.path??'',body.action==='list');
 if(body.action==='list')return {files:await files.list(identity.userId,path)};
 if(body.action==='read')return files.read(identity.userId,path);
 if(body.action!=='write')throw Object.assign(Error('Unknown Diary action'),{status:400});
 if(typeof body.content!=='string'||Buffer.byteLength(body.content)>512*1024||!(body.version===null||/^[a-f0-9]{64}$/.test(body.version||'')))throw Object.assign(Error('Content (maximum 512 KiB) and the exact read version are required'),{status:400});
 // No blind overwrite or automatic retry. The companion checks version and ETag atomically.
 if(!allowed())throw Object.assign(Error('Connector revoked'),{status:403});
 return files.write(identity.userId,{path,content:body.content,version:body.version});
}
module.exports={createCredentials,operate,safePath};
