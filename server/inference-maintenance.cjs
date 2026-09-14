'use strict';
// This is a maintenance exclusion gate, not a model scheduler/router.
function createMaintenanceGate() {
  let active=0,maintenance=false,reason='';
  const busy=()=>Object.assign(Error('Inference is busy. Wait for requests to finish before changing native presets.'),{status:409});
  // Holds the gate until release() for work that outlives one request (calibration jobs).
  function hold(message) {
    if(maintenance||active)throw busy();
    maintenance=true;reason=message||'';
    let released=false;
    return ()=>{if(!released){released=true;maintenance=false;reason='';}};
  }
  return {
    enter() {if(maintenance)throw Object.assign(Error(reason||'Model configuration is being applied. Try again shortly.'),{status:503});active++;let released=false;return ()=>{if(!released){released=true;active--;}};},
    async exclusive(fn) {const release=hold();try{return await fn();}finally{release();}},
    hold,
  };
}
module.exports={createMaintenanceGate};
