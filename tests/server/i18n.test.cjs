// Interface translations (#231): the catalogue core, loaded from source the same way the other
// src tests are (transpiled, run in a fresh context), with relative imports resolved to src/i18n.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const dir=path.join(__dirname,'../../src/i18n');
const cache={},warnings=[];
// name is relative to src/i18n ('core', 'settings/de-DE'); imports resolve from the importing file.
function load(name){
  name=path.posix.normalize(name);
  if(cache[name])return cache[name];
  const exports={};cache[name]=exports;
  const code=ts.transpileModule(fs.readFileSync(path.join(dir,name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const here=path.posix.dirname(name);
  vm.runInNewContext(code,{exports,Intl,console:{warn:(...a)=>warnings.push(a)},Promise,require:(m)=>{if(!/^\.\.?\//.test(m))throw Error('unexpected import '+m);const target=path.posix.join(here,m);if(target.startsWith('..'))throw Error('import outside src/i18n '+m);return load(target);}});
  return exports;
}
const core=load('core');
// Arrays built inside the vm context have another Array prototype; compare them as JSON.
const same=(a,b,m)=>assert.equal(JSON.stringify(a),JSON.stringify(b),m);
const EN=load('en-GB').EN_GB;
// The app loads non-English catalogues as chunks; node registers them directly for the checks below.
const FILES={'de-DE':'DE_DE','es-ES':'ES_ES','fr-FR':'FR_FR','it-IT':'IT_IT','nb-NO':'NB_NO','nl-NL':'NL_NL','pt-BR':'PT_BR','sv-SE':'SV_SE'};
// One entry per lazy-view segment: its constant suffix, the chunk that registers its English part
// (settings/index.ts etc., what the real view's chunk does), and the component(s) allowed to pull
// its strings into their own chunk.
const SEGMENT_DEFS={
  settings:{suffix:'SETTINGS',owners:/^components\/(SettingsShell|ProviderForm|ChatGptConnect|connectors\/)/},
  // Diary's and Projects' child components rely on their lazy entry (DiaryView, ProjectsView)
  // having already registered the segment, rather than each importing it themselves.
  projects:{suffix:'PROJECTS',owners:/^components\/ProjectsView$/},
  diary:{suffix:'DIARY',owners:/^components\/DiaryView$/},
  // Customise (PluginsView: skills, connectors, plugins) is the only owner; it also renders
  // ConnectorsSettings, which pulls in the settings segment on its own account.
  customise:{suffix:'CUSTOMISE',owners:/^components\/plugins\/PluginsView$/},
  // The model manager page (#293): only its lazy root registers the segment; every panel below
  // it (components/models/*, NativeCalibration, MtpControl, SamplingPresetsControl) relies on that.
  models:{suffix:'MODELS',owners:/^components\/models\/ModelManagerPage$/},
};
const SEGMENT_NAMES=Object.keys(SEGMENT_DEFS);
assert.equal(Object.keys(core.CATALOGUES).join(),'en-GB,en-US','only English is bundled eagerly');
for(const s of SEGMENT_NAMES)assert.equal(Object.keys(core.SEGMENTS[s]).length,0,`the ${s} segment is not loaded with the core`);
const ENSEG={};// segment => its EN_GB_<SUFFIX> object
for(const s of SEGMENT_NAMES){
  ENSEG[s]=load(`${s}/en-GB`)[`EN_GB_${SEGMENT_DEFS[s].suffix}`];
  load(`${s}/index`);// what the view's chunk does: registers the English part of that segment
}
for(const [l,name] of Object.entries(FILES)){
  core.registerCatalogue(l,load(l)[name]);
  for(const s of SEGMENT_NAMES){
    const suffix=SEGMENT_DEFS[s].suffix;
    const mod=load(`${s}/${l}`);
    assert.ok(mod[`${name}_${suffix}`],`${s}/${l}.ts does not export ${name}_${suffix}`);
    core.registerSegment(s,l,mod[`${name}_${suffix}`]);
  }
}
const NON_BASE=Object.keys(core.CATALOGUES).filter(l=>l!=='en-GB');

test('every supported account locale has a catalogue, and nothing else does',()=>{
  const server=require('../../server/account-preferences.cjs');
  const locales=(server.LOCALES||[]).filter(l=>l!=='system');
  assert.ok(locales.length>0,'server LOCALES not exported');
  same([...core.SUPPORTED].sort(),[...locales].sort());
});

test('a missing key falls back to English, and an unknown one to the key itself',()=>{
  const saved=core.CATALOGUES['de-DE']['common.cancel'];
  delete core.CATALOGUES['de-DE']['common.cancel'];
  try{assert.equal(core.translate('de-DE','common.cancel'),'Cancel');}
  finally{core.CATALOGUES['de-DE']['common.cancel']=saved;}
  assert.equal(core.translate('de-DE','common.cancel'),'Abbrechen');
  assert.equal(core.translate('en-US','common.cancel'),'Cancel','en-US only overrides spellings');
  assert.equal(core.translate('en-US','sidebar.customise'),'Customize');
  assert.equal(core.translate('xx-XX','common.save'),'Save','an unknown locale is English');
  assert.equal(core.translate('de-DE','no.such.key'),'no.such.key');
  // An empty string is a missing translation, not a blank label.
  core.CATALOGUES['sv-SE']['common.save']='';
  try{assert.equal(core.translate('sv-SE','common.save'),'Save');}finally{core.CATALOGUES['sv-SE']['common.save']='Spara';}
});

test('parameters are interpolated; unknown placeholders stay visible; values are not re-parsed',()=>{
  assert.equal(core.translate('en-GB','sidebar.openNamed',{name:'Garden plan'}),'Open Garden plan');
  assert.equal(core.translate('de-DE','sidebar.openNamed',{name:'Garden plan'}),'Garden plan öffnen');
  assert.equal(core.translate('en-GB','sidebar.openNamed'),'Open {name}');
  assert.equal(core.interpolate('{a} and {b}',{a:'{b}',b:'x'}),'{b} and x');
  assert.equal(core.interpolate('{n}',{n:0}),'0');
  assert.equal(core.translate('fr-FR','sidebar.confirmDeleteChatTitle',{name:'Notes'}),'Supprimer « Notes » ?');
});

test('plurals follow the locale’s rules',()=>{
  assert.equal(core.translatePlural('en-GB','sidebar.count.chats',1),'1 chat');
  assert.equal(core.translatePlural('en-GB','sidebar.count.chats',3),'3 chats');
  assert.equal(core.translatePlural('de-DE','sidebar.count.files',1),'1 Datei');
  assert.equal(core.translatePlural('de-DE','sidebar.count.files',0),'0 Dateien');
  // French treats 0 as singular.
  assert.equal(core.translatePlural('fr-FR','sidebar.count.files',0),'0 fichier');
});

test('system locale: browser languages in order, bare languages and regions, English otherwise',()=>{
  const r=core.resolveInterfaceLocale;
  assert.equal(r('system',['de']),'de-DE');
  assert.equal(r('system',['de-AT','en']),'de-DE');
  assert.equal(r('system',['en-US']),'en-US');
  assert.equal(r('system',['en']),'en-GB');
  assert.equal(r('system',['en-AU']),'en-GB');
  assert.equal(r('system',['en_us']),'en-US');
  assert.equal(r('system',['no']),'nb-NO');
  assert.equal(r('system',['nn-NO']),'nb-NO');
  assert.equal(r('system',['pt-PT']),'pt-BR');
  assert.equal(r('system',['sv-FI']),'sv-SE');
  assert.equal(r('system',['zh-CN','ja','fr-CA']),'fr-FR','first supported language wins');
  assert.equal(r('system',['zh-CN']),'en-GB');
  assert.equal(r('system',[]),'en-GB');
  assert.equal(r('system',['', 'x']),'en-GB');
  assert.equal(r('it-IT',['de']),'it-IT','a saved choice beats the browser');
  assert.equal(r('xx-XX',['de']),'de-DE','an unknown saved value is treated as system');
  assert.equal(r(undefined,undefined),'en-GB');
});

test('catalogues: no keys outside English, matching placeholders, and coverage reported',()=>{
  const lines=[];
  const segTotal=SEGMENT_NAMES.reduce((n,s)=>n+Object.keys(ENSEG[s]).length,0);
  for(const locale of NON_BASE){
    for(const part of ['base',...SEGMENT_NAMES])same(core.coverage(locale,part).extra,[],`${locale} ${part} segment has keys its English segment does not`);
    const c=core.coverage(locale);
    assert.equal(c.total,Object.keys(EN).length+segTotal,'coverage spans the base and every segment');
    same(c.extra,[],`${locale} has keys English does not: ${c.extra.join(', ')}`);
    same(c.placeholderMismatch,[],`${locale} placeholders differ: ${c.placeholderMismatch.join(', ')}`);
    lines.push(`${locale} ${c.translated}/${c.total} (${Math.round(100*c.translated/c.total)}%)`);
    // en-US is spelling only; every real translation is complete.
    if(locale!=='en-US')same(c.missing,[],`${locale} is missing: ${c.missing.join(', ')}`);
  }
  console.log('i18n coverage: '+lines.join(' · '));
  const us={...load('en-US').EN_US};
  for(const s of SEGMENT_NAMES){
    const mod=load(`${s}/en-US`),key=`EN_US_${SEGMENT_DEFS[s].suffix}`;
    assert.ok(mod[key],`${s}/en-US.ts does not export ${key}`);
    Object.assign(us,mod[key]);
  }
  const englishAll={...EN,...Object.assign({},...SEGMENT_NAMES.map(s=>ENSEG[s]))};
  for(const [k,v] of Object.entries(us))assert.notEqual(v,englishAll[k],`en-US repeats British text for ${k}`);
});

test('the completeness check really fails on an extra key and a broken placeholder',()=>{
  core.CATALOGUES['nl-NL']['sidebar.bogus']='x';
  const saved=core.CATALOGUES['nl-NL']['sidebar.openNamed'];
  core.CATALOGUES['nl-NL']['sidebar.openNamed']='{naam} openen';
  try{
    const c=core.coverage('nl-NL');
    same(c.extra,['sidebar.bogus']);
    same(c.placeholderMismatch,['sidebar.openNamed']);
  }finally{delete core.CATALOGUES['nl-NL']['sidebar.bogus'];core.CATALOGUES['nl-NL']['sidebar.openNamed']=saved;}
});

test('plural keys come in pairs, and catalogues are bundled, not fetched',()=>{
  const ALL={...EN,...Object.assign({},...SEGMENT_NAMES.map(s=>ENSEG[s]))};
  const plural=Object.keys(ALL).filter(k=>/\.(one|other)$/.test(k)).map(k=>k.replace(/\.(one|other)$/,''));
  for(const base of new Set(plural))assert.ok(ALL[base+'.one']&&ALL[base+'.other'],base);
  const files=fs.readdirSync(dir).flatMap(f=>fs.statSync(path.join(dir,f)).isDirectory()?fs.readdirSync(path.join(dir,f)).map(g=>f+'/'+g):[f]);
  for(const s of SEGMENT_NAMES)assert.ok(files.includes(`${s}/de-DE.ts`));
  const LOCALE_RE='(de-DE|es-ES|fr-FR|it-IT|nb-NO|nl-NL|pt-BR|sv-SE)';
  for(const f of files){
    const src=fs.readFileSync(path.join(dir,f),'utf8');
    assert.doesNotMatch(src,/\bfetch\(/,`${f} fetches at runtime`);
    // Dynamic imports only in loaders.ts, and only literal paths to a supported catalogue.
    const imports=[...src.matchAll(/import\(([^)]*)\)/g)].map(m=>m[1]);
    if(f!=='loaders.ts'){assert.equal(imports.length,0,`${f} imports at runtime`);continue;}
    for(const arg of imports)assert.match(arg,new RegExp(`^'\\./(?:(?:${SEGMENT_NAMES.join('|')})/)?${LOCALE_RE}'$`),`non-literal import ${arg}`);
  }
});

test('every appearance sync status useAppearance can report has a translation in Settings',()=>{
  const hook=fs.readFileSync(path.join(__dirname,'../../src/useAppearance.ts'),'utf8');
  const settings=fs.readFileSync(path.join(__dirname,'../../src/components/GeneralSettings.tsx'),'utf8');
  const statuses=[...new Set([...hook.matchAll(/setStatus\('([^']+)'\)/g)].map(m=>m[1]))];
  assert.ok(statuses.length>=4);
  for(const s of statuses)assert.ok(settings.includes(`'${s}': 'appearance.status.`),`untranslated appearance status: ${s}`);
});

test('the chunk loader map holds only supported non-English ids; anything else never imports',async()=>{
  const loaders=load('loaders');
  same(Object.keys(loaders.LOADERS).sort(),core.SUPPORTED.filter(l=>!l.startsWith('en-')).sort());
  same(Object.keys(loaders.SETTINGS_LOADERS).sort(),core.SUPPORTED.filter(l=>!l.startsWith('en-')).sort());
  same(Object.keys(loaders.PROJECTS_LOADERS).sort(),core.SUPPORTED.filter(l=>!l.startsWith('en-')).sort());
  same(Object.keys(loaders.DIARY_LOADERS).sort(),core.SUPPORTED.filter(l=>!l.startsWith('en-')).sort());
  same(Object.keys(loaders.CUSTOMISE_LOADERS).sort(),core.SUPPORTED.filter(l=>!l.startsWith('en-')).sort());
  same(Object.keys(loaders.MODELS_LOADERS).sort(),core.SUPPORTED.filter(l=>!l.startsWith('en-')).sort());
  for(const bad of ['xx-XX','../en-GB','__proto__','constructor','']){assert.equal(await loaders.loadSegment('settings',bad,{}),false,bad);}
  assert.equal(await loaders.loadSegment('__proto__','de-DE'),false,'an unknown segment loads nothing');
  let calls=0;const spy={'de-DE':()=>{calls++;return Promise.resolve({});}};
  for(const bad of ['xx-XX','../en-GB','__proto__','constructor','toString','',"de-DE'"])assert.equal(await loaders.loadCatalogue(bad,spy),false,bad);
  assert.equal(calls,0,'an unsupported id called a loader');
  assert.equal(await loaders.loadCatalogue('xx-XX'),false);
  assert.equal(await loaders.loadCatalogue('en-GB',spy),true,'English is already there');
  assert.equal(calls,0);
});

test('a chunk loads once and is cached; a failed one stays English, logs once and is not retried',async()=>{
  const loaders=load('loaders');
  const saved=core.CATALOGUES['it-IT'];delete core.CATALOGUES['it-IT'];
  let ok=0;const good={'it-IT':()=>{ok++;return Promise.resolve({'common.cancel':'Annulla'});}};
  try{
    const [a,b]=await Promise.all([loaders.loadCatalogue('it-IT',good),loaders.loadCatalogue('it-IT',good)]);
    assert.equal(a&&b,true);assert.equal(ok,1,'concurrent requests share one load');
    assert.equal(await loaders.loadCatalogue('it-IT',good),true);assert.equal(ok,1,'cached');
    assert.equal(core.translate('it-IT','common.cancel'),'Annulla');
  }finally{core.CATALOGUES['it-IT']=saved;}
  const savedSv=core.CATALOGUES['sv-SE'];delete core.CATALOGUES['sv-SE'];
  let tries=0;const bad={'sv-SE':()=>{tries++;return Promise.reject(Error('chunk 404'));}};
  try{
    warnings.length=0;
    assert.equal(await loaders.loadCatalogue('sv-SE',bad),false);
    assert.equal(await loaders.loadCatalogue('sv-SE',bad),false);
    assert.equal(tries,1,'no retry loop');assert.equal(warnings.length,1,'logged once');
    assert.equal(core.translate('sv-SE','common.save'),'Save','stays English');
  }finally{core.CATALOGUES['sv-SE']=savedSv;}
});

test('every Cowork fallback reason has a message key', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/chat-mode.ts'), 'utf8');
  const codes = src.match(/export type FallbackReason = ([^;]+);/)[1].match(/'(\w+)'/g).map((c) => c.slice(1, -1));
  assert.equal(codes.length, 4);
  for (const c of codes) assert.ok(EN[`mode.reason.${c}`], c);
});

test('key names follow the locale: Strg in German, Maj in French, Ctrl in English', () => {
  for (const [l, ctrl, shift] of [['en-GB', 'Ctrl', 'Shift'], ['de-DE', 'Strg', 'Umschalt'], ['fr-FR', 'Ctrl', 'Maj']]) {
    assert.equal(core.translate(l, 'keys.ctrl'), ctrl); assert.equal(core.translate(l, 'keys.shift'), shift);
  }
  // The German shortcut note and the key name agree.
  assert.match(core.translate('de-DE', 'keyboard.otherNote'), /Strg/);
});

test('the Diary Markdown workspace search summary keeps its counts, in every locale',()=>{
  // Regression: diary.workspace.matches/.linkingFiles/.filesChecked/.unreadableItems are plural
  // pairs whose VALUES must themselves contain {count} — translatePlural only supplies the count
  // as an interpolation variable, it does not prepend it. searchSummary composes two of these
  // plurals through {results} and {checked}, exactly as DiaryMarkdownWorkspace.tsx does.
  const summary=(locale,resultsKey,resultsCount,scanned)=>core.translate(locale,'diary.workspace.searchSummary',{
    results:core.translatePlural(locale,resultsKey,resultsCount),
    checked:core.translatePlural(locale,'diary.workspace.filesChecked',scanned),
  });
  for(const locale of ['en-GB',...NON_BASE]){
    for(const [key,count] of [['diary.workspace.matches',1],['diary.workspace.matches',12],['diary.workspace.linkingFiles',1],['diary.workspace.linkingFiles',3]]){
      const text=summary(locale,key,count,12);
      assert.match(text,new RegExp(String(count)),`${locale} ${key}(${count}) lost its result count: ${text}`);
      assert.match(text,/12/,`${locale} ${key}(${count}) lost its scanned-files count: ${text}`);
    }
    const skipped=core.translatePlural(locale,'diary.workspace.unreadableItems',3);
    assert.match(skipped,/3/,`${locale} unreadableItems lost its count: ${skipped}`);
  }
});

// Shell strings the first screen shows before any Settings/Projects/Diary code has loaded.
const SHELL_ALLOW=/^(settings\.title|capabilities\.unavailable|keyboard\.(searchShortcuts|noMatch|action\..+|group\..+))$/;
// Prefixes owned by each lazy segment, checked against the base catalogue below. account.* stays
// in the base on purpose: the account menu renders on the first screen.
const SEGMENT_PREFIX={
  settings:/^(settings|appearance|profile|capabilities|language|notifications|keyboard|style|models|connectors|data|memory|usage|security|users|providers|appPasswords|diarySettings|serviceStatus)\./,
  projects:/^projects\./,
  diary:/^diary\./,
  models:/^mm\./,
};
test('the base English catalogue holds no Settings-screen string beyond the shell allowlist',()=>{
  const settingsInBase=Object.keys(EN).filter(k=>k.startsWith('settings.'));
  same(settingsInBase,['settings.title'],'settings.* in the base catalogue');
  const stray=Object.keys(EN).filter(k=>SEGMENT_PREFIX.settings.test(k)&&!SHELL_ALLOW.test(k));
  same(stray,[],'Settings-only keys in the base catalogue');
});

// Every dotted, quoted, message-key-shaped literal in a file — this is what a t('x.y') or
// t.plural('x.y', …) call, including inside a ternary or a variable/array of keys, looks like in
// source; nothing else in these files is a quoted string of that shape.
const KEY_LITERAL=/(['"`])([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\1/g;
function keysUsedIn(relPath){
  const src=fs.readFileSync(path.join(__dirname,'../../src',relPath),'utf8');
  return new Set([...src.matchAll(KEY_LITERAL)].map(m=>m[2]));
}
// Modules in the first-load bundle (App.tsx's own graph — ProjectView/EditProjectModal/
// ProjectIdentity are imported eagerly by App.tsx, not through lazy-views.tsx; AccountMenu and
// ChatView/Sidebar/App render on the first screen; DiaryModal is where MarkdownPreview lives,
// which ChatView also renders for ordinary chat messages).
const EAGER_MODULES=['components/ProjectView.tsx','components/EditProjectModal.tsx','components/ProjectIdentity.tsx','components/AccountMenu.tsx','components/ChatView.tsx','components/Sidebar.tsx','App.tsx','components/DiaryModal.tsx'];
// The lazy Diary and Projects views and every child only they render.
const DIARY_MODULES=['components/DiaryView.tsx','components/DiaryCalendar.tsx','components/DiaryContextPanel.tsx','components/DiaryModal.tsx','components/DiaryMarkdownWorkspace.tsx','components/diary-graph/LocalGraph.tsx','components/DiaryStorageStatus.tsx','components/DiaryWorkspaceTrash.tsx','components/DiaryWorkspaceImport.tsx'];
const PROJECTS_MODULES=['components/ProjectsView.tsx'];

// A t.plural('x.y', n) call cites the bare base ('x.y'), never the '.one'/'.other' pair itself.
const inBase=(k)=>k in EN||(`${k}.one` in EN&&`${k}.other` in EN);
test('every projects.*/diary.*/account.* key used by an eager (first-load) module is in the base catalogue',()=>{
  for(const file of EAGER_MODULES){
    const used=[...keysUsedIn(file)].filter(k=>SEGMENT_PREFIX.projects.test(k)||SEGMENT_PREFIX.diary.test(k)||k.startsWith('account.'));
    const missing=used.filter(k=>!inBase(k));
    same(missing,[],`${file} uses a key not in the base catalogue: ${missing.join(', ')} — it is eager, so a lazy-segment-only key would render literally until that segment's chunk loads`);
  }
});

test('ProjectsView and DiaryView (and their lazy-only children) use only base keys or their own segment, never the other segment',()=>{
  const check=(files,ownSegment,otherSegment)=>{
    for(const file of files){
      const used=[...keysUsedIn(file)].filter(k=>SEGMENT_PREFIX[otherSegment].test(k));
      const foreign=used.filter(k=>!inBase(k));// a base key with that prefix (e.g. diary.markdown.*) is fine anywhere
      same(foreign,[],`${file} (in the ${ownSegment} segment) uses a ${otherSegment}.* key that is not in the base catalogue: ${foreign.join(', ')}`);
    }
  };
  check(PROJECTS_MODULES,'projects','diary');
  check(DIARY_MODULES,'diary','projects');
});

test('the base English catalogue holds no Projects- or Diary-only string (ProjectView/EditProjectModal/ProjectIdentity are not lazy, so their own keys stay in the base)',()=>{
  const strayProjects=Object.keys(EN).filter(k=>SEGMENT_PREFIX.projects.test(k)&&Object.prototype.hasOwnProperty.call(ENSEG.projects,k));
  same(strayProjects,[],'a projects.* key exists in both the base and the projects segment');
  const strayDiary=Object.keys(EN).filter(k=>SEGMENT_PREFIX.diary.test(k)&&Object.prototype.hasOwnProperty.call(ENSEG.diary,k));
  same(strayDiary,[],'a diary.* key exists in both the base and the diary segment');
  // diary.markdown.* (MarkdownPreview) and diary.modal.closeDialog (the DiaryModal wrapper it
  // shares a file with) stay in the base because DiaryModal.tsx is pulled into the eager chunk by
  // the equally eager ChatView; everything else diary.* that IS lazy-only lives in the segment.
  const DIARY_BASE_ALLOW=/^diary\.(markdown\.|modal\.closeDialog$)/;
  const diaryInBase=Object.keys(EN).filter(k=>SEGMENT_PREFIX.diary.test(k));
  assert.ok(diaryInBase.every(k=>DIARY_BASE_ALLOW.test(k)),`unexpected diary.* key in the base: ${diaryInBase.filter(k=>!DIARY_BASE_ALLOW.test(k)).join(', ')}`);
});

test('no key is defined in more than one segment, and the base catalogue module never imports a segment at runtime',()=>{
  for(const s of SEGMENT_NAMES)same(Object.keys(ENSEG[s]).filter(k=>k in EN),[],`${s} segment repeats a base key`);
  for(let i=0;i<SEGMENT_NAMES.length;i++)for(let j=i+1;j<SEGMENT_NAMES.length;j++){
    const [a,b]=[SEGMENT_NAMES[i],SEGMENT_NAMES[j]];
    same(Object.keys(ENSEG[a]).filter(k=>k in ENSEG[b]),[],`${a} and ${b} both define`);
  }
  const coreSrc=fs.readFileSync(path.join(dir,'core.ts'),'utf8');
  for(const s of SEGMENT_NAMES)assert.doesNotMatch(coreSrc,new RegExp(`^import \\{[^}]*\\} from '\\./${s}`,'m'),`core imports the ${s} segment's strings at runtime`);
  // Only each segment's own lazy view(s) register its English part.
  for(const s of SEGMENT_NAMES){
    const users=[];(function walk(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);if(fs.statSync(p).isDirectory()){if(f!=='i18n')walk(p);}else if(/\.tsx?$/.test(f)&&new RegExp(`i18n/${s}['"/]`).test(fs.readFileSync(p,'utf8')))users.push(path.relative(path.join(__dirname,'../../src'),p).replace(/\.tsx?$/,'').replace(/\\/g,'/'));}})(path.join(__dirname,'../../src'));
    for(const u of users)assert.match(u,SEGMENT_DEFS[s].owners,`${u} pulls the ${s} strings into its chunk`);
  }
});

// Generic version of the Settings-specific lifecycle test below, run once per lazy segment with a
// representative key from each (settings.back / projects.title / diary.title).
const REP_KEY={settings:'settings.back',projects:'projects.title',diary:'diary.title',customise:'customise.title',models:'mm.title'};
for(const s of SEGMENT_NAMES){
  test(`${s} keys: English until the segment arrives, key by key, and the key itself if unregistered`,async()=>{
    const key=REP_KEY[s];
    assert.equal(core.translate('de-DE',key),core.SEGMENTS[s]['de-DE'][key]);
    const savedDe=core.SEGMENTS[s]['de-DE'];delete core.SEGMENTS[s]['de-DE'];
    try{
      assert.equal(core.translate('de-DE',key),ENSEG[s][key],'absent segment falls back to English');
      assert.equal(core.translate('de-DE','common.cancel'),'Abbrechen','the base still translates');
    }finally{core.SEGMENTS[s]['de-DE']=savedDe;}
    const savedEn=core.SEGMENTS[s]['en-GB'];delete core.SEGMENTS[s]['en-GB'];
    try{
      assert.ok(!core.activeSegments().includes(s));
      assert.equal(core.translate('en-GB',key),key,'without the view code an unknown key renders as the key');
    }finally{core.SEGMENTS[s]['en-GB']=savedEn;}
    core.registerSegment(s,'xx-XX',{});assert.ok(!('xx-XX' in core.SEGMENTS[s]));
    // A failed segment chunk logs once, is not retried, and leaves the base catalogue alone.
    const loaders=load('loaders');
    const savedPt=core.SEGMENTS[s]['pt-BR'];delete core.SEGMENTS[s]['pt-BR'];
    let tries=0;const bad={'pt-BR':()=>{tries++;return Promise.reject(Error('chunk 404'));}};
    try{
      warnings.length=0;
      assert.equal(loaders.catalogueSettled('pt-BR'),false);
      assert.equal(await loaders.loadSegment(s,'pt-BR',bad),false);
      assert.equal(await loaders.loadSegment(s,'pt-BR',bad),false);
      assert.equal(tries,1);assert.equal(warnings.length,1);
      assert.equal(loaders.catalogueSettled('pt-BR'),true,'a failed segment does not keep useT waiting');
      assert.equal(core.translate('pt-BR',key),ENSEG[s][key]);
      assert.equal(core.translate('pt-BR','common.cancel'),core.CATALOGUES['pt-BR']['common.cancel']);
    }finally{core.SEGMENTS[s]['pt-BR']=savedPt;}
    let ok=0;const good={'nb-NO':()=>{ok++;return Promise.resolve({[key]:'Test-NB'});}};
    const savedNb=core.SEGMENTS[s]['nb-NO'];delete core.SEGMENTS[s]['nb-NO'];
    try{
      const [a,b]=await Promise.all([loaders.loadSegment(s,'nb-NO',good),loaders.loadSegment(s,'nb-NO',good)]);
      assert.equal(a&&b,true);assert.equal(ok,1);assert.equal(core.translate('nb-NO',key),'Test-NB');
    }finally{core.SEGMENTS[s]['nb-NO']=savedNb;}
  });
}

test('Settings keys: partial segment falls back per key, and shell keys never depend on the segment',()=>{
  const savedDe=core.SEGMENTS.settings['de-DE'];
  try{
    core.registerSegment('settings','de-DE',{'settings.search':'Einstellungen durchsuchen'});
    assert.equal(core.translate('de-DE','settings.back'),'Back','a partial segment falls back per key');
    assert.equal(core.translate('de-DE','settings.search'),'Einstellungen durchsuchen');
  }finally{core.SEGMENTS.settings['de-DE']=savedDe;}
  assert.equal(core.translate('fr-FR','settings.title'),core.CATALOGUES['fr-FR']['settings.title'],'shell keys never depend on the segment');
});

test('Settings search matches English keywords as well as the translated ones',()=>{
  const shell=fs.readFileSync(path.join(__dirname,'../../src/components/SettingsShell.tsx'),'utf8');
  assert.match(shell,/\['connectors', 'Connected apps', '[^']*\bplugins\b[^']*'\]/,'English connector keywords include plugins');
  // The haystack joins the English keywords, the translated ones and the English label.
  assert.match(shell,/\[keywords, ownKeywords\.startsWith\('settings\.'\) \? '' : ownKeywords, own === label \? '' : label\.toLowerCase\(\)\]/);
  assert.doesNotMatch(core.translate('de-DE','settings.keywords.connectors'),/^settings\./);
});

// ── Model manager segment (#293) ────────────────────────────────────────────────────────────────
// Every module in the ModelManagerPage lazy chunk that renders text. ModelManagerPage registers
// the segment; the rest are only reachable through it (checked below).
const MODELS_MODULES=['components/models/ModelManagerPage.tsx','components/models/ModelsSettings.tsx','components/models/RoutingModeSection.tsx','components/models/ModelCombobox.tsx','components/models/sections.ts','components/models/OverviewTab.tsx','components/models/LibraryTab.tsx','components/models/DownloadTab.tsx','components/models/ConfigureTab.tsx','components/models/GuidedOptimize.tsx','components/models/HardwareTab.tsx','components/models/BenchmarksTab.tsx','components/models/AutoTune.tsx','components/models/EvidenceList.tsx','components/models/TimeChart.tsx','components/models/mm-text.ts','components/models/backend-errors.ts','components/models/register.ts','components/NativeCalibration.tsx','components/MtpControl.tsx','components/SamplingPresetsControl.tsx']
  // A module added on the web side (ModelCombobox, #1009) is listed before that web change lands.
  .filter((f)=>fs.existsSync(path.join(__dirname,'../../src',f)));
const SRC=path.join(__dirname,'../../src');
function srcFiles(){const out=[];(function walk(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);if(fs.statSync(p).isDirectory()){if(f!=='i18n')walk(p);}else if(/\.tsx?$/.test(f))out.push(path.relative(SRC,p).replace(/\\/g,'/'));}})(SRC);return out;}
const inSegment=(s,k)=>Object.prototype.hasOwnProperty.call(ENSEG[s],k)||(Object.prototype.hasOwnProperty.call(ENSEG[s],`${k}.one`)&&Object.prototype.hasOwnProperty.call(ENSEG[s],`${k}.other`));

test('mm.* keys are used only inside the model manager chunk, and every one it uses exists',()=>{
  for(const file of srcFiles()){
    const used=[...keysUsedIn(file)].filter(k=>SEGMENT_PREFIX.models.test(k));
    if(!MODELS_MODULES.includes(file)){same(used,[],`${file} is outside the model manager chunk but uses ${used.join(', ')}`);continue;}
    const missing=used.filter(k=>!inSegment('models',k));
    same(missing,[],`${file} uses mm.* keys the models segment lacks: ${missing.join(', ')}`);
  }
  // Everything else a model manager module cites is a base key (settings.title, common.cancel…),
  // never another lazy segment's key, which would render as the key when opened on its own.
  for(const file of MODELS_MODULES){
    const foreign=[...keysUsedIn(file)].filter(k=>!SEGMENT_PREFIX.models.test(k)&&/^[a-z]+\.[a-zA-Z]/.test(k)&&(k in ENSEG.settings||k in ENSEG.projects||k in ENSEG.diary)&&!inBase(k));
    same(foreign,[],`${file} uses another segment's keys: ${foreign.join(', ')}`);
  }
});

test('the model manager modules are reached only through the lazy ModelManagerPage chunk, never the first-load bundle',()=>{
  // A static import of a model manager module from anywhere else would pull it (and its mm.*
  // keys) into that importer's chunk, where the segment may not be registered.
  const stems=new Set(MODELS_MODULES.map(f=>f.replace(/\.tsx?$/,'')));
  for(const file of srcFiles()){
    if(stems.has(file.replace(/\.tsx?$/,'')))continue;
    const src=fs.readFileSync(path.join(SRC,file),'utf8');
    for(const m of src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)){
      if(!m[1].startsWith('.'))continue;
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),m[1]));
      assert.ok(!stems.has(target),`${file} statically imports ${target}, a model manager module`);
    }
  }
  const lazy=fs.readFileSync(path.join(SRC,'lazy-views.tsx'),'utf8');
  assert.match(lazy,/lazyView\(\(\) => import\('\.\/components\/models\/ModelManagerPage'\)/,'ModelManagerPage stays a dynamic import');
  for(const file of EAGER_MODULES){
    const used=[...keysUsedIn(file)].filter(k=>SEGMENT_PREFIX.models.test(k));
    same(used,[],`${file} is in the first-load bundle but uses model manager keys`);
  }
  const base=Object.keys(EN).filter(k=>SEGMENT_PREFIX.models.test(k));
  same(base,[],'mm.* keys in the base catalogue');
});

test('Diary & storage and Service status use only Settings-segment or base keys, and all of them exist',()=>{
  for(const file of ['components/SettingsView.tsx','components/McpStatus.tsx','components/DiaryConnectors.tsx']){
    const used=[...keysUsedIn(file)].filter(k=>/^(diarySettings|serviceStatus|settings|models)\./.test(k));
    const missing=used.filter(k=>!inBase(k)&&!inSegment('settings',k));
    same(missing,[],`${file} uses keys the Settings segment lacks: ${missing.join(', ')}`);
  }
  // Nothing outside the Settings chunk may cite these (StoragePicker and DiarySharing also render
  // in the Diary view and the setup wizard, where the Settings segment is not registered).
  for(const file of srcFiles()){
    if(['components/SettingsView.tsx','components/McpStatus.tsx','components/DiaryConnectors.tsx'].includes(file))continue;
    const used=[...keysUsedIn(file)].filter(k=>/^(diarySettings|serviceStatus)\./.test(k));
    same(used,[],`${file} uses Diary & storage / Service status keys outside the Settings chunk`);
  }
});

test('every plural form of the model manager and the new Settings screens keeps {count}',()=>{
  const tables=[ENSEG.models,ENSEG.settings,...NON_BASE.flatMap(l=>[core.SEGMENTS.models[l],core.SEGMENTS.settings[l]])];
  for(const table of tables)for(const [k,v] of Object.entries(table||{})){
    if(!/^(mm|diarySettings|serviceStatus)\./.test(k)||!/\.(one|other)$/.test(k))continue;
    assert.match(v,/\{count\}/,`${k} lost {count}: ${v}`);
  }
  assert.equal(core.translatePlural('de-DE','mm.projects.title',1),'Routing pro Projekt (1 Projekt)');
  assert.equal(core.translatePlural('fr-FR','mm.calibration.minutes',0),'0 minute','French 0 is singular');
  assert.equal(core.translatePlural('en-GB','serviceStatus.mcp.discovered',160),'160 tools discovered');
});

test('the chat model picker, Auto summary, system label, Diary storage and file sharing use base keys only (they render outside any lazy segment)',()=>{
  for(const file of ['components/ModelPopup.tsx','routing-copy.ts','components/StoragePicker.tsx','components/DiarySharing.tsx']){
    const used=[...keysUsedIn(file)].filter(k=>/^[a-z][a-zA-Z]*\.[a-zA-Z]/.test(k)&&!/\.(tsx?|js|json|com|gguf)$/.test(k));
    const missing=used.filter(k=>!inBase(k));
    same(missing,[],`${file} uses keys outside the base catalogue: ${missing.join(', ')}`);
  }
  for(const file of MODELS_MODULES)assert.doesNotMatch(fs.readFileSync(path.join(SRC,file),'utf8'),/SYSTEM_MODEL_LABEL/,`${file} renders the English system label`);
  assert.equal(core.translate('de-DE','routing.fast',{model:'m'}),'Schnell: m');
});

// #587: the "not loaded" state word must not be the Unload button's word, and the capability tags
// on a model card ("dense", "embeddings", "reranking") are translated in every non-English locale.
test('model card state and capability tags are translated, and the state is not the Unload verb',()=>{
  const EN_MODELS=ENSEG.models;
  for(const l of Object.keys(FILES)){
    assert.notEqual(core.translate(l,'mm.card.unloaded'),core.translate(l,'mm.card.unload'),`${l}: the unloaded state reads like the Unload button`);
    for(const k of ['mm.tag.dense','mm.tag.embeddings','mm.tag.reranking']){
      if(l==='fr-FR'&&k==='mm.tag.dense')continue;// "dense" is the French word too
      assert.notEqual(core.translate(l,k).toLowerCase(),EN_MODELS[k].toLowerCase(),`${l} ${k} is still the English word`);
    }
  }
  assert.equal(core.translate('de-DE','mm.card.unloaded'),'Nicht geladen');
  assert.equal(core.translate('nl-NL','mm.card.unloaded'),'Niet geladen');
});

// #597/#598: the words the model manager service and server send as English (benchmark status,
// Advanced group titles, tune drafting labels, evidence limitations) are translated from stable ids
// in every non-English locale, keep their placeholders, and the ids match what the server sends.
test('service-supplied model manager words are translated per locale from stable ids',()=>{
  const EN_MODELS=ENSEG.models;
  const ids={
    'mm.bench.status.':['idle','starting','running','cancelling','done','cancelled','error'],
    'mm.tier.':['common','runtime','rope','moe','multimodal','speculative','lora','cpu','reasoning','misc'],
    'mm.spec.':['off','mtp','mtp-deep','mtp-shallow','ngram'],
    'mm.evidence.lim.':['autotune-quality','autotune-budget','autotune-baseline-skipped','vision-probe','single-reply','calibration-budget','benchmark-median','source-unverified'],
  };
  same(require('../../server/evidence-limitations.cjs').LIMITATION_IDS.slice().sort(),ids['mm.evidence.lim.'].slice().sort(),'server limitation ids match the catalogue');
  // Some words read the same in French or Spanish ("Multimodal / vision"); German is the strict check. Names (RoPE / YaRN, MTP, N-gram, Mixture-of-Experts, LoRA, "Error") may match.
  const MAY_MATCH=new Set(['mm.tier.rope','mm.spec.ngram','mm.spec.mtp','mm.tier.moe','mm.tier.lora','mm.bench.status.error']);
  for(const [prefix,list] of Object.entries(ids))for(const id of list){
    const k=prefix+id;
    assert.ok(k in EN_MODELS,`${k} missing from the English models segment`);
    for(const l of Object.keys(FILES)){
      const text=core.translate(l,k);
      assert.ok(text&&text!==k,`${l}: ${k} has no translation`);
      if(l==='de-DE'&&!MAY_MATCH.has(k))assert.notEqual(text,EN_MODELS[k],`${l}: ${k} is still English`);
      for(const p of EN_MODELS[k].match(/\{\w+\}/g)||[])assert.ok(text.includes(p),`${l}: ${k} lost ${p}`);
    }
  }
  assert.equal(core.translate('de-DE','mm.bench.status.done'),'Fertig');
  assert.equal(core.translate('fr-FR','mm.tier.speculative'),'Décodage spéculatif');
  assert.equal(core.translate('de-DE','mm.spec.off'),'Aus');
  assert.match(core.translate('de-DE','mm.evidence.lim.autotune-quality'),/^Drei deterministische/);
});

// #600: every Advanced field the model manager schema can send has its label and help in the
// catalogue, keyed by the stable field id, in every locale. The ids are read from the service's own
// schema. The ids come from tests/fixtures/model-manager-field-ids.json (inside apps/web, so the
// in-image run has it too); services/model-manager/tests/test_api.py keeps that fixture equal to
// ini.py, so a field added there without a translation fails one of the two suites.
test('every Advanced field id the service sends has a translated label and help in every locale (#600)',()=>{
  const ids=JSON.parse(fs.readFileSync(path.join(__dirname,'../fixtures/model-manager-field-ids.json'),'utf8'));
  assert.ok(ids.length>=90,`found ${ids.length} field ids in the fixture`);
  assert.equal(new Set(ids).size,ids.length,'field ids are unique');
  const EN_MODELS=ENSEG.models;
  const NAME_LABELS=new Set(['flash-attn','spec-draft-n-max','spec-draft-n-min','spec-draft-p-min','spec-draft-p-split','threads-batch']);
  for(const id of ids)for(const part of ['label','help']){
    const k=`mm.field.${id}.${part}`;
    assert.ok(EN_MODELS[k],`${k} missing from the English models segment`);
    for(const l of Object.keys(FILES)){
      const text=core.translate(l,k);
      assert.ok(text&&text!==k,`${l}: ${k} has no translation`);
      // Help is always prose. A label may be a parameter name ("Draft n_max") or product name that reads the same.
      if(part==='help'||!NAME_LABELS.has(id))assert.notEqual(text,EN_MODELS[k],`${l}: ${k} is still English`);
    }
  }
  // Nothing in the catalogue for a field the service does not send.
  const known=new Set(ids);
  for(const k of Object.keys(EN_MODELS)){const m=/^mm\.field\.(.+)\.(label|help)$/.exec(k);if(m)assert.ok(known.has(m[1]),`${k} has no field in ini.py`);}
  assert.equal(core.translate('de-DE','mm.field.ctx-size.label'),'Kontextgröße');
  assert.equal(core.translate('fr-FR','mm.field.ngl.label'),'Couches GPU');
});

test('chat meta words and the harness context line are catalogue keys in every locale (#600)',()=>{
  assert.equal(core.translate('en-GB','chat.meta.tokens',{tokens:'1,234'}),'1,234 tokens');
  assert.equal(core.translate('de-DE','chat.meta.tokens',{tokens:'1.234'}),'1.234 Tokens');
  assert.equal(core.translate('de-DE','code.meta.context',{percent:'33 %',size:'24.576'}),'Kontext 33 % von 24.576');
  assert.equal(core.translatePlural('fr-FR','code.meta.commandsFailed',2,{failed:1}),'2 commandes, 1 en échec');
  assert.equal(core.translatePlural('en-GB','code.meta.commands',1),'1 command');
  for(const l of Object.keys(FILES))for(const k of ['chat.meta.tokens','chat.meta.split','code.meta.context','code.meta.commands.one','code.meta.commandsFailed.other']){
    const text=core.translate(l,k);assert.ok(text&&text!==k,`${l}: ${k}`);
  }
});

// #624: every string of one locale, the base and each lazy segment, as [key, text].
function entriesOf(locale){
  const name=FILES[locale];
  const out=Object.entries(load(locale)[name]);
  for(const s of SEGMENT_NAMES)out.push(...Object.entries(load(`${s}/${locale}`)[`${name}_${SEGMENT_DEFS[s].suffix}`]));
  return out;
}

test('de-DE uses the informal "du" everywhere: no formal Sie, Ihr… or Ihnen (#581, #624)',()=>{
  // A capital Sie/Ihr… inside a sentence, after a lowercase word or a comma, is the formal address;
  // the third person is lowercase there ("sie", "ihr") and a sentence start or a colon cannot tell.
  const formal=/[a-zäöüß,] (?:Sie|Ihr(?:e|em|en|er|es)?)\b|\bIhnen\b/;
  const found=entriesOf('de-DE').filter(([,text])=>formal.test(text)).map(([k])=>k);
  same(found,[],`formal address in de-DE: ${found.join(', ')}`);
  assert.match(core.translate('de-DE','sidebar.confirmDeleteProjectBody',{chats:'2 Chats'}),/in deinem verbundenen Speicher/);
  assert.match(core.translate('de-DE','projects.confirmDeleteBody'),/in deinem verbundenen Speicher/);
  // The guard itself: it flags the formal sentence and lets the third person through.
  assert.ok(formal.test('Dateien in Ihrem verbundenen Speicher'));
  assert.ok(formal.test('Wenn Sie das möchten'));
  assert.ok(!formal.test('Sie bleiben in deinem Ordner. Ihr Inhalt bleibt.'));
});

test('fr-FR calls the Settings page "Réglages" everywhere, never "Paramètres" (#624)',()=>{
  // "Paramètres" as a heading or label for the Settings page is the mixed term; a column of model
  // parameters ("Paramètres (B)") is a different word and stays.
  const PARAMETER_COUNTS=new Set(['mm.card.params','mm.filters.params']);
  const found=entriesOf('fr-FR').filter(([k,text])=>/\bParamètres\b/.test(text)&&!PARAMETER_COUNTS.has(k)).map(([k])=>k);
  same(found,[],`fr-FR names Settings "Paramètres" in: ${found.join(', ')}`);
  for(const k of ['settings.title','account.settings','chat.offline.settings','viewLoading.settings','projects.view.projectSettings','projects.menu.settings','sidebar.projectSettings'])
    assert.match(core.translate('fr-FR',k),/^Réglages/,k);
  assert.equal(core.translate('fr-FR','customise.appSettings'),'Réglages de l’application');
});

test('no locale leaves the English page name or a button that does not exist in its own text (#624)',()=>{
  for(const l of Object.keys(FILES)){
    assert.doesNotMatch(core.translate(l,'customise.viewServiceStatus'),/Service status/,`${l} names the Service status page in English`);
    assert.ok(core.translate(l,'customise.viewServiceStatus').includes(core.translate(l,'settings.section.status')),`${l} names the page the way Settings does`);
    // The Sources hint must name the button the panel really shows.
    assert.ok(core.translate(l,'projects.skills.addBody').includes(core.translate(l,'projects.view.uploadFiles')),`${l} hint names its own upload button`);
  }
  assert.equal(core.translate('fr-FR','code.panel.harness'),'Harnais');
  assert.equal(core.translate('es-ES','code.panel.harness'),'Arnés');
});

test('the #624 strings exist in every locale, in that locale’s words and with the same placeholders',()=>{
  const keys=Object.keys({...EN,...Object.assign({},...SEGMENT_NAMES.map(s=>ENSEG[s]))}).filter(k=>/^(code\.(task\.(plan|output|result)|network|meta\.limitations|review|sidebar|active)|chat\.(approval|effort|statusId)|gdrive\.msg|features\.unavailable\.decision|features\.unavailable\.systemOne|decision\.msg)\./.test(k));
  assert.ok(keys.length>=80,`found ${keys.length} keys`);
  // Words that read the same in English and the locale, by nature.
  const SAME=new Set(['code.review.severity.blocker:de-DE']);
  const en={...EN,...Object.assign({},...SEGMENT_NAMES.map(s=>ENSEG[s]))};
  for(const l of Object.keys(FILES))for(const k of keys){
    const text=core.translate(l,k);
    assert.ok(text&&text!==k,`${l}: ${k} missing`);
    if(!SAME.has(`${k}:${l}`))assert.notEqual(text,en[k],`${l}: ${k} is still English`);
    const ph=s=>(s.match(/\{\w+\}/g)||[]).sort().join();
    assert.equal(ph(text),ph(en[k]),`${l}: ${k} placeholders`);
  }
});

test('every locale writes tokens per second one way across every catalogue and segment (#661)',()=>{
  // "24,4 tok/s" beside "24,4 tokens/s" in one Spanish view read as two different units.
  const UNIT=/(?:tok|tokens?|jetons?)\/s\b/gi;
  const EXPECTED={'en-GB':'tokens/s','en-US':'(inherits en-GB)','de-DE':'Token/s','es-ES':'tokens/s','fr-FR':'jetons/s','it-IT':'token/s','nb-NO':'tokens/s','nl-NL':'tokens/s','pt-BR':'tokens/s','sv-SE':'tokens/s'};
  assert.deepEqual(Object.keys(EXPECTED).sort(),Object.keys(core.CATALOGUES).sort(),'a new locale needs an entry here');
  for(const locale of Object.keys(EXPECTED)){
    const tables=[core.CATALOGUES[locale],...SEGMENT_NAMES.map(s=>core.SEGMENTS[s][locale])].filter(Boolean);
    const found=new Map();
    for(const table of tables)for(const [key,text] of Object.entries(table))for(const m of String(text).matchAll(UNIT))found.set(m[0],[...(found.get(m[0])||[]),key]);
    assert.deepEqual([...found.keys()],locale==='en-US'?[]:[EXPECTED[locale]],`${locale} mixes tokens-per-second units: ${JSON.stringify([...found].map(([unit,keys])=>[unit,keys.slice(0,3)]))}`);
  }
  // The stats bar unit and the sentence form agree for a locale that had drifted.
  assert.equal(core.translate('es-ES','stats.tokPerSecUnit'),core.translate('es-ES','stats.tokensPerSecond').replace('{value} ',''));
});

test('the de-DE routing description names the fast role Schnell, like the composer does (#661)',()=>{
  const text=core.translate('de-DE','features.item.systemOneRouting.description');
  assert.match(text,/Schnell, Smart oder Code/);
  assert.doesNotMatch(text,/\bFast\b/);
  assert.match(text,/neue automatisch geroutete Nachrichten/);
});
