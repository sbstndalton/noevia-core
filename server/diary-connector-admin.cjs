// Administrator CLI for installing/revoking a personal Diary connector.
// Pipe create output directly to a private connection.json; never into Git/logs.
const path=require('node:path');
const {createAuth}=require('./auth.cjs');
const dir=process.env.UI_DATA_DIR || path.join(__dirname,'ui-data');
const auth=createAuth({dataDir:dir,publicOrigin:process.env.PUBLIC_ORIGIN||''});
const credentials=require('./diary-connectors.cjs').createCredentials(auth);
const [action,username,value]=process.argv.slice(2);
if(action==='list-users'){
 console.log(JSON.stringify(auth.db.prepare("SELECT u.username FROM users u JOIN user_features f ON f.user_id=u.id WHERE u.disabled_at IS NULL AND f.diary_enabled=1 AND u.role='admin'").all().map(u=>u.username)));
}else{
 const user=auth.db.prepare('SELECT id FROM users WHERE username_norm=? AND disabled_at IS NULL').get(String(username||'').toLowerCase());
 if(!user)throw Error('Choose an exact active username');
 if(action==='create'){
  if(process.stdout.isTTY)throw Error('Redirect credential output to a private file');
  const made=credentials.create(user.id,value||'Claude Diary');
  console.log(JSON.stringify({url:auth.origin.replace(/\/$/,'')+'/api/diary-connector',...made}));
 }else if(action==='revoke')console.log(JSON.stringify({revoked:credentials.revoke(user.id,value)}));
 else if(action==='list')console.log(JSON.stringify(credentials.list(user.id)));
 else throw Error('Use list-users, create USER NAME, list USER or revoke USER ID');
}
auth.db.close();
