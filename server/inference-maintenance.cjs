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
  return {
    enter() {if(maintenance)throw Object.assign(Error(reason||'Model configuration is being applied. Try again shortly.'),{status:503});active++;let released=false;return ()=>{if(!released){released=true;active--;wake();}};},
    async exclusive(fn) {const release=hold();try{return await fn();}finally{release();}},
    hold,
    holdWhenIdle,
  };
}
module.exports={createMaintenanceGate};
