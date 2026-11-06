'use strict';
// Primitive Playwright engine over inherited private pipes. Native code owns policy,
// approvals, task state, downloads destinations, journals and recovery. No TCP listener.
const readline = require('node:readline');
const MAX_FRAME = 64 * 1024 * 1024;
const TIMEOUT = 15000;
function describeInPage(target) {
  const text = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  let el = target || document.body;
  const activatable = 'button, a[href], input, select, textarea, summary, label, [role=button], [role=link], [role=menuitem], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=option]';
  el = (el.closest && el.closest(activatable)) || el;
  if (el.tagName === 'LABEL' && el.control) el = el.control;
  const labelled = el.getAttribute('aria-labelledby');
  const byId = labelled ? labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '';
  const label = el.labels && el.labels.length ? Array.from(el.labels).map((l) => l.textContent).join(' ') : '';
  const form = el.form || (el.closest && el.closest('form'));
  return {
    tag: el.tagName.toLowerCase(),
    // A button's DOM type is its real state (an invalid attribute is 'submit'); #1218.
    type: el.tagName === 'BUTTON' ? el.type : (el.getAttribute('type') || ''),
    role: el.getAttribute('role') || '',
    name: text(el.getAttribute('aria-label') || byId || label || el.getAttribute('title') || el.getAttribute('alt') || ''),
    text: text(el.innerText || el.textContent || ''),
    value: el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) ? text(el.value) : '',
    inForm: !!form,
    formMethod: form ? (form.getAttribute('method') || 'get').toLowerCase() : '',
    formAction: form ? form.action : '',
    frameOrigin: location.origin,
  };
}

function createDriver({launch, request, notify = () => {}}) {
  let browser = null, context = null, page = null, closing = null, launching = null, creating = null;
  let next = 0;
  const pages = new Map(), elements = new Map(), downloads = new Map();
  const remember = (map, value) => { const id = String(++next); map.set(id,value); return id; };
  const pageId = p => { for (const [id,v] of pages) if (v === p) return id; return remember(pages,p); };
  const current = () => { if (!page || page.isClosed()) throw Error('closed'); return page; };
  const getPage = id => { const p=pages.get(id); if (!p || p.isClosed()) throw Error('closed'); return p; };
  const getElement = id => { const e=elements.get(id); if (!e) throw Error('element'); return e; };
  const origin = p => { try { const u=new URL(p.url()); return /^https?:$/.test(u.protocol)?u.origin:''; } catch { return ''; } };
  function observe(p) {
    page=p; const id=pageId(p);
    p.on('download', d => { const download=remember(downloads,d); notify('download',{download,filename:d.suggestedFilename(),url:d.url()}); });
    p.on('close',()=>{ if(page!==p)return; const open=context?.pages().filter(p=>!p.isClosed())||[];page=open.length?open[open.length-1]:null;notify('page',{page:page?pageId(page):null}); });
    notify('page',{page:id});
  }
  const commands = {
    async launch() { if(browser || launching || closing)throw Error('state'); launching=Promise.resolve().then(launch).then(value=>{browser=value;});await launching;return {}; },
    async context({proxy}) {
      if(!browser || context || creating || closing)throw Error('state');
      // Publish ownership before route setup awaits; a concurrent close reaches this context.
      creating=Promise.resolve().then(()=>browser.newContext({acceptDownloads:true,serviceWorkers:'block',...(proxy?{proxy}:{})})).then(value=>{context=value;});
      await creating;
      const owned=context;
      await owned.route('**/*',async route=>{
        const req=route.request();
        let main=false;try{main=req.isNavigationRequest()&&req.frame()===req.frame().page().mainFrame();}catch{}
        try {
          const answer=await request('route',{url:req.url(),main});
          if(answer?.allow===true)return await route.continue();
        } catch {}
        await route.abort('blockedbyclient').catch(()=>{});
      });
      await owned.routeWebSocket(/.*/,async ws=>{
        try{ const answer=await request('websocket',{url:ws.url()});if(answer?.allow===true){ws.connectToServer();return;} }catch{}
        ws.close({code:1008,reason:'Not on this task’s allowed list.'});
      });
      owned.on('page',observe);
      return {};
    },
    async page() { if(!context || closing)throw Error('state');const p=await context.newPage();page=p;return {page:pageId(p),origin:origin(p)}; },
    async current() { const p=current();return {page:pageId(p),origin:origin(p),url:p.url()}; },
    async inspect({selector,focus}) {
      const p=current();
      const handle=focus ? await p.evaluateHandle(()=>document.activeElement) : await p.locator(String(selector)).first().elementHandle({timeout:TIMEOUT});
      if(!handle)return {page:pageId(p),origin:origin(p),element:null};
      const element=remember(elements,handle);
      try { return {page:pageId(p),origin:origin(p),element,facts:await handle.evaluate(describeInPage)}; }
      catch { elements.delete(element);await handle.dispose().catch(()=>{});throw Error('inspect'); }
    },
    async recheck({page:id,element,focus}) {
      const p=getPage(id);if(p!==current())return {samePage:false};
      const e=element?getElement(element):null;
      return {samePage:true,origin:origin(p),connected:e?await e.evaluate(el=>el.isConnected):true,
        focused:e&&focus?await e.evaluate(el=>el===document.activeElement):true,
        facts:e?await e.evaluate(describeInPage):null};
    },
    async dispose({element}) { const e=elements.get(element);elements.delete(element);if(e)await e.dispose();return {}; },
    async screenshot({page:id}) { return {png:(await getPage(id).screenshot({type:'png'})).toString('base64')}; },
    async extract({page:id,selector}) { const p=getPage(id);return {text:selector?await p.locator(String(selector)).first().innerText({timeout:TIMEOUT}):await p.locator('body').innerText({timeout:TIMEOUT})}; },
    async dispatch({page:id,element,kind,url,text,key,values,files,dy,ms}) {
      const p=getPage(id), e=element?getElement(element):null;
      // Only fixed engine primitives; no caller-supplied script or evaluation expression.
      switch(kind) {
        case 'navigate':await p.goto(url,{timeout:TIMEOUT});break;
        case 'click':await e.click({timeout:TIMEOUT});break;
        case 'hover':await e.hover({timeout:TIMEOUT});break;
        case 'type':await e.fill(text,{timeout:TIMEOUT});break;
        case 'select':await e.selectOption(values,{timeout:TIMEOUT});break;
        case 'press':if(e)await e.press(key,{timeout:TIMEOUT});else await p.keyboard.press(key);break;
        case 'upload':await e.setInputFiles(files,{timeout:TIMEOUT});break;
        case 'submit':await e.evaluate(el=>{const form=el.form||el.closest('form')||el;if(form.requestSubmit)form.requestSubmit();else form.submit();});break;
        case 'scroll':await p.mouse.wheel(0,dy);break;
        case 'wait':await p.waitForTimeout(ms);break;
        default:throw Error('command');
      }
      await p.waitForLoadState('domcontentloaded',{timeout:TIMEOUT}).catch(()=>{});
      return {};
    },
    async back({page:id}) {await getPage(id).goBack({timeout:TIMEOUT}).catch(()=>{});return {};},
    async download({download,path}) {const d=downloads.get(download);if(!d)throw Error('download');await d.saveAs(path);downloads.delete(download);return {};},
    async closeContext() {if(context)await context.close();return {};},
    async close() {
      // The native settle task retains this receipt even if its HTTP waiter times out.
      if(!closing)closing=Promise.resolve().then(async()=>{if(launching)await launching.catch(()=>{});if(creating)await creating.catch(()=>{});if(browser)await browser.close();return {confirmed:true};});
      return closing;
    },
  };
  return async (method,params={})=>{
    if(!Object.hasOwn(commands,method))throw Error('command');
    return commands[method](params);
  };
}
function serve({input,output,launch}) {
  let next=0, stopped=false, failed=false;
  const pending=new Map(), active=new Set();
  const write=frame=>{if(stopped)return;const encoded=JSON.stringify(frame);if(Buffer.byteLength(encoded)+(output.writableLength||0)>MAX_FRAME)throw Error('frame');output.write(encoded+'\n');};
  const driver=createDriver({launch,
    notify:(method,params)=>write({event:method,params}),
    request:(method,params)=>new Promise((resolve,reject)=>{if(pending.size>=1024){reject(Error('channel'));return;}const id=++next;pending.set(id,{resolve,reject});try{write({request:id,method,params});}catch{pending.delete(id);reject(Error('channel'));}}),
  });
  const lines=readline.createInterface({input,crlfDelay:Infinity});
  let buffered=0;
  // Bound unterminated input too, without reflecting any command or credentials.
  input.on('data',chunk=>{if(failed)return;for(const b of chunk){buffered=b===10?0:buffered+1;if(buffered>MAX_FRAME){failed=true;input.destroy();lines.close();break;}}});
  lines.on('line',line=>{
    if(failed)return;if(Buffer.byteLength(line)>MAX_FRAME||active.size>=1024){failed=true;input.destroy();return;}
    let frame;try{frame=JSON.parse(line);}catch{failed=true;input.destroy();return;}
    if(frame && Number.isSafeInteger(frame.response)){
      const wait=pending.get(frame.response);if(wait){pending.delete(frame.response);wait.resolve(frame.result);}return;
    }
    if(!frame||!Number.isSafeInteger(frame.id)||typeof frame.method!=='string'){failed=true;input.destroy();return;}
    const work=Promise.resolve().then(()=>driver(frame.method,frame.params)).then(
      result=>write({id:frame.id,result}),
      ()=>write({id:frame.id,error:{code:'engine_failure'}})
    ).catch(()=>{failed=true;input.destroy();});
    active.add(work);work.finally(()=>active.delete(work));
  });
  const settled=new Promise(resolve=>lines.once('close',async()=>{
    // EOF revokes all unobserved route requests, then waits for real browser closure.
    stopped=true;for(const wait of pending.values())wait.reject(Error('channel'));pending.clear();
    try{await driver('close');}catch{}await Promise.allSettled([...active]);resolve();
  }));
  return settled;
}
if(require.main===module){
  serve({input:process.stdin,output:process.stdout,launch:()=>require('playwright').chromium.launch({headless:true})}).catch(()=>{process.exitCode=1;});
}
module.exports={createDriver,serve,describeInPage};
