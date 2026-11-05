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
// (it restarted, or the hold expired while this process could not reach it) takes the hold again
// (a bounded wait); if that fails the job goes on without the gate's hold (its requests no longer
// carry a dead token) and this is logged. The local hold stays either way: this process's own chat
// stays paused until the work ends. A gate found without the hold API is asked again after
// `reprobeMs`, so a gate upgraded later is used without a restart. releaseRemote() gives the gate's
// hold back at shutdown (bounded), so a restarted process can take it at once.
//
// hold() returns the release function, or (with a remote) a promise of it: callers await it.
function createMaintenanceGate({ remote = null, log = (line) => console.log(line), setTimer = setInterval, clearTimer = clearInterval, now = () => Date.now(), reprobeMs = 5 * 60 * 1000, retakeWaitMs = 10000, observeMs = 0, coverageMarginMs = 15000 } = {}) {
  let active=0,maintenance=false,reason='',holdToken=null,holdHeader=true,shuttingDown=false;
  // Row J review P1 (restart): with the Rust front's lease authority, this process starts closed to chat
  // until its start is registered there and no lease the front holds (backed by the previous start's
  // latch) remains: that front job may still be finishing a step (remote.ready(), model-maintenance-lease.cjs).
  let bootFenced=false,bootReason='';
  if(remote&&typeof remote.ready==='function'){
    bootFenced=true;bootReason='Model maintenance is finishing. Try again shortly.';
    Promise.resolve(remote.ready()).then(()=>{bootFenced=false;wake();},()=>{});
  }
  // Review P2 (sweep recovery): chat barriers that close admission without being a hold (hold() ignores them).
  let barriers=0,barrierReason='';
  // The coverage of a lease of the front's authority while one is held (nativeHolding).
  let coverage=null;
  // sbstndalton/noevia#2210: a hold another client took at the gate (the Rust front's reload, calibration or
  // tune) is not in this process's memory. With `observeMs`, the gate is asked its state on that interval
  // and held() reports it, so the folder sync, the optional chat work and the code machine wait for it.
  // The last answer stands while the gate does not answer. The hold this process holds itself is not foreign.
  let foreignHeld=false,generation=0;
  if(remote&&typeof remote.maintenanceHeld==='function'&&observeMs>0){
    const poll=async()=>{const started=generation;try{const held=await remote.maintenanceHeld();if(typeof held==='boolean'&&started===generation)foreignHeld=held;}catch{/* the last answer stands */}};
    const timer=setTimer(poll,observeMs);timer?.unref?.();
    void poll();
  }
  // When the remote last answered that it has no hold API (null: never asked, or asked again since).
  let absentAt=null;
  const absent=()=>!remote||(absentAt!==null&&now()-absentAt<reprobeMs);
  const waiting=new Set();
  const wake=()=>{for(const notify of waiting)notify();};
  const closed=()=>maintenance||bootFenced||barriers>0;
  const coverageError=why=>Object.assign(Error(`The maintenance lease ${why}, so this work stopped before changing anything else.`),{status:503,code:'maintenanceCoverageLost',coverageLost:true});
  const busy=()=>Object.assign(Error('Inference is busy. Wait for requests to finish before changing native presets.'),{status:409});
  // A refusal of the gate's hold: work is running, or another client holds it. Anything else (the
  // gate not answering, a wrong admin token) is passed on as it is.
  const remoteBusy=e=>e?.status===409||e?.code==='engine_busy'||e?.code==='maintenance_held';
  // Row J review P1: a lease of the Rust front's authority (granted.native) has its own fail-closed
  // lifecycle. It is renewed on the authority's cadence; it is lost when the authority answers that it
  // ended, when no renewal has been confirmed within its TTL (less coverageMarginMs), or at its hard cap
  // (less the margin). A lost lease is never taken again for the same work: its work stops before its next
  // step (assertCovered, the release's signal), while this process keeps its local exclusion until the work
  // releases, so nothing of this process runs beside a step still in flight.
  function nativeHolding(message, granted) {
    maintenance=true;reason=message||'';holdToken=granted.token;holdHeader=false;
    foreignHeld=false;generation++;
    const state={lost:false,why:'',confirmedAt:granted.askedAt,hardAt:granted.askedAt+granted.hardMs,ttl:granted.ttlMs,controller:new AbortController()};
    coverage=state;
    let released=false,renewing=false;
    const lose=why=>{
      if(state.lost||released)return;
      state.lost=true;state.why=why;clearTimer(timer);
      const token=holdToken;holdToken=null;
      if(token)void remote.releaseMaintenance(token);
      state.controller.abort(coverageError(why));
      log(`[models] this process's maintenance lease ${why}; its work stops before its next step, and chat stays paused until it ends`);
    };
    const tick=async()=>{
      if(renewing||released||state.lost||shuttingDown)return;
      if(now()+coverageMarginMs>=state.hardAt)return lose('passed its limit');
      renewing=true;
      const asked=now();
      let renewed=null;
      try{renewed=await remote.renewMaintenance(holdToken,reason);}catch{renewed=null;}
      finally{renewing=false;}
      if(released||state.lost)return;
      if(renewed===true){state.confirmedAt=asked;return;}
      if(renewed===false)return lose('was ended by the lease authority');
      if(now()+coverageMarginMs>=state.confirmedAt+state.ttl)lose('could not be renewed');
    };
    const timer=setTimer(tick,Math.max(1,granted.renewMs||10000));
    timer?.unref?.();
    const release=()=>{
      if(released)return;
      released=true;clearTimer(timer);
      const token=holdToken;
      maintenance=false;reason='';holdToken=null;foreignHeld=false;generation++;
      if(coverage===state)coverage=null;
      wake();
      if(token)void remote.releaseMaintenance(token);
    };
    release.setReason=m=>{
      if(released)return;
      reason=m||'';
      if(holdToken)void remote.renewMaintenance(holdToken,reason).catch(()=>null);
    };
    release.signal=state.controller.signal;
    return release;
  }
  const grantedHold=(message,granted)=>(granted?.native?nativeHolding(message,granted):holding(message,granted));
  // The release of a hold that is now this process's (the gate's token, when there is one).
  function holding(message, granted) {
    maintenance=true;reason=message||'';holdToken=granted?.token||null;holdHeader=granted?.header!==false;
    // The hold at the gate (if any) is ours now, and an answer asked before this is about someone else's.
    foreignHeld=false;generation++;
    let released=false,timer=null,renewing=false;
    if(holdToken){
      const every=Math.max(1000,Math.floor((granted.idleTtlMs||60000)/3));
      timer=setTimer(async()=>{
        if(renewing||!holdToken||shuttingDown)return;
        renewing=true;
        try{
          const renewed=await remote.renewMaintenance(holdToken,reason).catch(()=>null);
          if(renewed!==false||released||shuttingDown)return;
          // The gate has forgotten the hold: take it again, briefly waiting for the engine.
          let again=null;
          try{again=await remote.holdMaintenance(reason,{waitMs:retakeWaitMs});}catch{again=null;}
          // Released, or given back at shutdown, while the hold was asked for again: the new token goes back too.
          if(released||shuttingDown){if(again)void remote.releaseMaintenance(again.token);return;}
          if(again){holdToken=again.token;log('[inference-gate] the gate had lost this process\'s maintenance hold; it was taken again');return;}
          holdToken=null;
          if(timer)clearTimer(timer);
          log('[inference-gate] the gate lost this process\'s maintenance hold and it could not be taken again; this work goes on without it, so other clients may use the engine until it ends');
        }finally{renewing=false;}
      },every);
      timer?.unref?.();
    }
    const release=()=>{
      if(released)return;
      released=true;
      if(timer)clearTimer(timer);
      const token=holdToken;
      maintenance=false;reason='';holdToken=null;foreignHeld=false;generation++;wake();
      if(token)void remote.releaseMaintenance(token);
    };
    release.setReason=message=>{
      if(released)return;
      reason=message||'';
      if(holdToken)void remote.renewMaintenance(holdToken,reason).catch(()=>null);
    };
    return release;
  }
  // The gate's hold, or null when it has none (then this process holds on its own until reprobeMs).
  async function remoteHold(message, options) {
    if(absent())return null;
    const granted=await remote.holdMaintenance(message,options);
    absentAt=granted===null?now():null;
    return granted;
  }
  // Holds the gate until release() for work that outlives one request (calibration jobs).
  // Throws (rejects, with a gate) a 409 while requests are in flight or the gate is held.
  function hold(message) {
    if(maintenance)throw busy();
    // chatActive: only this process's own requests are running (they end on their own).
    if(active)throw Object.assign(busy(),{chatActive:true});
    if(absent())return holding(message,null);
    // Reserved here at once, so nothing of this process starts while the gate is asked.
    maintenance=true;reason=message||'';
    return remoteHold(message,{}).then(granted=>grantedHold(message,granted),e=>{
      maintenance=false;reason='';wake();
      // fromGate: refused by the inference gate (another client's hold, or its engine busy), not by this process.
      throw remoteBusy(e)?Object.assign(busy(),{fromGate:true}):e;
    });
  }
  // Row J: a hold of this process's own admission only (the latch a lease of the Rust front's authority
  // takes: that lease is already the authority's, so it is not asked again). Same 409s as hold().
  function holdLocal(message) {
    if(maintenance)throw busy();
    if(active)throw Object.assign(busy(),{chatActive:true});
    return holding(message,null);
  }
  async function holdWhenIdle(message,{timeoutMs=300000,signal}={}) {
    if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw Error('Invalid idle wait timeout.');
    const deadline=Date.now()+timeoutMs;
    for(;;) {
      if(signal?.aborted)throw Object.assign(Error('Cancelled'),{cancelled:true});
      if(!maintenance&&!active){
        if(absent())return holding(message,null);
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
          if(!maintenance&&!active)return grantedHold(message,granted);
          if(granted)void remote.releaseMaintenance(granted.token);
        }
      }
      const remaining=deadline-Date.now();
      if(remaining<=0)throw Object.assign(Error('Timed out waiting for chat to become idle.'),{idleTimeout:true});
      if(!maintenance&&!active&&!absent())continue;
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
            if(!closed())done();
          });
        }
      }
    },
    enter() {if(closed())throw Object.assign(Error((maintenance&&reason)||(bootFenced&&bootReason)||(barriers>0&&barrierReason)||'Model configuration is being applied. Try again shortly.'),{status:503});active++;let released=false;return ()=>{if(!released){released=true;active--;wake();}};},
    async exclusive(fn) {const release=await hold();try{return await fn();}finally{release();}},
    hold,
    holdLocal,
    holdWhenIdle,
    // Read-only: whether a calibration, auto-tune model or preset write holds the gate (#872).
    held: () => closed()||(foreignHeld&&!holdToken),
    // Row J review P1: throws (503 maintenanceCoverageLost) when this process's lease of the front's
    // authority is lost or cannot cover a step of `stepMs`; nothing to check for any other hold.
    assertCovered(stepMs=0) {
      const c=coverage;
      if(!c)return;
      if(c.lost)throw coverageError(c.why);
      if(now()+Math.max(0,Number(stepMs)||0)+coverageMarginMs>=Math.min(c.confirmedAt+c.ttl,c.hardAt))throw coverageError('cannot cover the next step');
    },
    // The current lease's lost-coverage signal (null when no lease of the front's authority is held).
    coverageSignal: () => coverage?.controller.signal || null,
    // Review P2: closes chat admission without holding (a sweep recovering its hold). Release once.
    barrier(message) {
      barriers++;barrierReason=message||barrierReason;let done=false;
      return ()=>{if(done)return;done=true;barriers--;if(!barriers)barrierReason='';wake();};
    },
    // Read-only: inference requests in flight (#1785: the chat title skips a busy engine).
    active: () => active,
    // #2187: the header this process's requests to the engine carry while it holds the gate's hold.
    holdHeaders: () => (holdToken && holdHeader ? { 'X-Noevia-Maintenance': holdToken } : {}),
    // #2187: whether holds go to the inference gate (false: none configured, or it has no hold API).
    delegated: () => !absent(),
    // #2187: at shutdown, gives the gate's hold back (bounded) so the next process can take it at once.
    // Never throws; true when there was a gate hold to give back.
    async releaseRemote({ timeoutMs = 2000 } = {}) {
      shuttingDown=true;
      const token=holdToken;
      if(!token)return false;
      holdToken=null;
      let timer;
      await Promise.race([remote.releaseMaintenance(token).catch(()=>{}),new Promise(r=>{timer=setTimeout(r,timeoutMs);})]);
      clearTimeout(timer);
      return true;
    },
  };
  return gate;
}
module.exports={createMaintenanceGate};
