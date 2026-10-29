'use strict';
// This is a maintenance exclusion gate, not a model scheduler/router.
//
// sbstndalton/noevia#2187: with an inference gate in front of the router (noevia-rs
// bins/noevia-inference-gate), the gate is the one maintenance authority. A hold here then takes
// the gate's maintenance hold (`remote`, inference-gate-client.cjs holdMaintenance), so every client
// of the router (Diary, the Rust front, other engines' users) waits for the same preset write,
// calibration, auto-tune or sweep, and this process's own requests during it carry the hold
// (holdHeaders). This process still counts its own inference requests (enter) and refuses them
// itself while it holds, with the same messages and statuses as before. Without a gate (the remote
// answers null: no admin token, or nothing at the engine address knows the hold) the hold is this
// process's alone, as it always was.
//
// The gate ends a hold its holder neither renews nor uses for its idle limit; this process renews
// its hold every third of that limit for as long as it holds it. A renewal the gate answers "ended"
// (it restarted, or the hold expired while this process could not reach it) is logged once and the
// local hold stays: this process's own chat stays paused until the work ends.
//
// hold() returns the release function, or (with a remote) a promise of it: callers await it.
function createMaintenanceGate({ remote = null, log = (line) => console.log(line), setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let active=0,maintenance=false,reason='',holdToken=null;
  let remoteAbsent=!remote;
  const waiting=new Set();
  const wake=()=>{for(const notify of waiting)notify();};
  const busy=()=>Object.assign(Error('Inference is busy. Wait for requests to finish before changing native presets.'),{status:409});
  // A refusal of the gate's hold: work is running, or another client holds it. Anything else (the
  // gate not answering, a wrong admin token) is passed on as it is.
  const remoteBusy=e=>e?.status===409||e?.code==='engine_busy'||e?.code==='maintenance_held';
  // The release of a hold that is now this process's (the gate's token, when there is one).
  function holding(message, granted) {
    maintenance=true;reason=message||'';holdToken=granted?.token||null;
    let released=false,timer=null,lostLogged=false;
    if(holdToken){
      const every=Math.max(1000,Math.floor((granted.idleTtlMs||60000)/3));
      const token=holdToken;
      timer=setTimer(async()=>{
        const renewed=await remote.renewMaintenance(token,reason).catch(()=>null);
        if(renewed===false&&!lostLogged){lostLogged=true;log('[inference-gate] the gate no longer has this process\'s maintenance hold; other clients may use the engine until this work ends');}
      },every);
      timer?.unref?.();
    }
    const release=()=>{
      if(released)return;
      released=true;
      if(timer)clearTimer(timer);
      const token=holdToken;
      maintenance=false;reason='';holdToken=null;wake();
      if(token)void remote.releaseMaintenance(token);
    };
    release.setReason=message=>{
      if(released)return;
      reason=message||'';
      if(holdToken)void remote.renewMaintenance(holdToken,reason).catch(()=>null);
    };
    return release;
  }
  // The gate's hold, or null when it has none (then this process holds on its own from now on).
  async function remoteHold(message, options) {
    if(remoteAbsent)return null;
    const granted=await remote.holdMaintenance(message,options);
    if(granted===null)remoteAbsent=true;
    return granted;
  }
  // Holds the gate until release() for work that outlives one request (calibration jobs).
  // Throws (rejects, with a gate) a 409 while requests are in flight or the gate is held.
  function hold(message) {
    if(maintenance||active)throw busy();
    if(remoteAbsent)return holding(message,null);
    // Reserved here at once, so nothing of this process starts while the gate is asked.
    maintenance=true;reason=message||'';
    return remoteHold(message,{}).then(granted=>holding(message,granted),e=>{
      maintenance=false;reason='';wake();
      throw remoteBusy(e)?busy():e;
    });
  }
  async function holdWhenIdle(message,{timeoutMs=300000,signal}={}) {
    if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw Error('Invalid idle wait timeout.');
    const deadline=Date.now()+timeoutMs;
    for(;;) {
      if(signal?.aborted)throw Object.assign(Error('Cancelled'),{cancelled:true});
      if(!maintenance&&!active){
        if(remoteAbsent)return holding(message,null);
        // The gate waits for other clients' work to end (bounded, in slices so a cancel is prompt);
        // this process's own chat may still start meanwhile, as without a gate.
        let granted;
        try{granted=await remoteHold(message,{waitMs:Math.max(0,Math.min(30000,deadline-Date.now())),signal});}
        catch(e){
          if(signal?.aborted)throw Object.assign(Error('Cancelled'),{cancelled:true});
          if(!remoteBusy(e))throw e;
          granted=undefined;
        }
        if(granted!==undefined){
          // A chat turn of this process (or another hold) started while the gate was asked: give
          // the gate's hold back and wait again.
          if(!maintenance&&!active)return holding(message,granted);
          if(granted)void remote.releaseMaintenance(granted.token);
        }
      }
      const remaining=deadline-Date.now();
      if(remaining<=0)throw Object.assign(Error('Timed out waiting for chat to become idle.'),{idleTimeout:true});
      if(!maintenance&&!active&&!remoteAbsent)continue;
      await new Promise((resolve,reject)=>{
        let timer;
        const done=()=>{clearTimeout(timer);waiting.delete(done);signal?.removeEventListener('abort',abort);resolve();};
        const abort=()=>{clearTimeout(timer);waiting.delete(done);signal?.removeEventListener('abort',abort);reject(Object.assign(Error('Cancelled'),{cancelled:true}));};
        waiting.add(done);signal?.addEventListener('abort',abort,{once:true});
        timer=setTimeout(done,remaining);
        if(signal?.aborted){abort();return;}
        // Recheck after registering, so a release between hold() and registration cannot strand us.
        if(!maintenance&&!active)done();
      });
    }
  }
  const gate = {
    // #1896: like enter(), but a gate held only for a moment (a preset apply, or a tune that took the gate the instant
    // the previous reply ended) is waited for, at most waitMs and never past `signal`, before the 503 is answered.
    // The refusal carries code 'inferenceMaintenance' and retryable: true.
    async enterWithin(waitMs=0,signal) {
      const deadline=Date.now()+Math.max(0,Number(waitMs)||0);
      for(;;) {
        try{return gate.enter();}catch(e){
          const remaining=deadline-Date.now();
          if(e.status!==503||remaining<=0||signal?.aborted)throw Object.assign(e,{code:e.code||'inferenceMaintenance',retryable:true});
          await new Promise(resolve=>{
            let timer;
            const done=()=>{clearTimeout(timer);waiting.delete(done);signal?.removeEventListener('abort',done);resolve();};
            waiting.add(done);signal?.addEventListener('abort',done,{once:true});
            timer=setTimeout(done,remaining);
            if(!maintenance)done();
          });
        }
      }
    },
    enter() {if(maintenance)throw Object.assign(Error(reason||'Model configuration is being applied. Try again shortly.'),{status:503});active++;let released=false;return ()=>{if(!released){released=true;active--;wake();}};},
    async exclusive(fn) {const release=await hold();try{return await fn();}finally{release();}},
    hold,
    holdWhenIdle,
    // Read-only: whether a calibration, auto-tune model or preset write holds the gate (#872).
    held: () => maintenance,
    // Read-only: inference requests in flight (#1785: the chat title skips a busy engine).
    active: () => active,
    // #2187: the header this process's requests to the engine carry while it holds the gate's hold.
    holdHeaders: () => (holdToken ? { 'X-Noevia-Maintenance': holdToken } : {}),
    // #2187: whether holds go to the inference gate (false: none configured, or it has no hold API).
    delegated: () => !remoteAbsent,
  };
  return gate;
}
module.exports={createMaintenanceGate};
