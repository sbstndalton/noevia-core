'use strict';
// This is a maintenance exclusion gate, not a model scheduler/router.
function createMaintenanceGate() {
  let active=0,maintenance=false,reason='';
  const waiting=new Set();
  const wake=()=>{for(const notify of waiting)notify();};
  const busy=()=>Object.assign(Error('Inference is busy. Wait for requests to finish before changing native presets.'),{status:409});
  // Holds the gate until release() for work that outlives one request (calibration jobs).
  function hold(message) {
    if(maintenance||active)throw busy();
    maintenance=true;reason=message||'';
    let released=false;
    const release=()=>{if(!released){released=true;maintenance=false;reason='';wake();}};
    release.setReason=message=>{if(!released)reason=message||'';};
    return release;
  }
  async function holdWhenIdle(message,{timeoutMs=300000,signal}={}) {
    if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw Error('Invalid idle wait timeout.');
    const deadline=Date.now()+timeoutMs;
    for(;;) {
      if(signal?.aborted)throw Object.assign(Error('Cancelled'),{cancelled:true});
      try{return hold(message);}catch(e){if(e.status!==409)throw e;}
      const remaining=deadline-Date.now();
      if(remaining<=0)throw Object.assign(Error('Timed out waiting for chat to become idle.'),{idleTimeout:true});
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
    async exclusive(fn) {const release=hold();try{return await fn();}finally{release();}},
    hold,
    holdWhenIdle,
    // Read-only: whether a calibration, auto-tune model or preset write holds the gate (#872).
    held: () => maintenance,
    // Read-only: inference requests in flight (#1785: the chat title skips a busy engine).
    active: () => active,
  };
  return gate;
}
module.exports={createMaintenanceGate};
