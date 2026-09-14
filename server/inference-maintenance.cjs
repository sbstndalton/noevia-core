'use strict';
// This is a maintenance exclusion gate, not a model scheduler/router.
function createMaintenanceGate() {
  let active=0,maintenance=false;
  const busy=()=>Object.assign(Error('Inference is busy. Wait for requests to finish before changing native presets.'),{status:409});
  return {
    enter() {if(maintenance)throw Object.assign(Error('Model configuration is being applied. Try again shortly.'),{status:503});active++;let released=false;return ()=>{if(!released){released=true;active--;}};},
    async exclusive(fn) {if(maintenance||active)throw busy();maintenance=true;try{return await fn();}finally{maintenance=false;}},
  };
}
module.exports={createMaintenanceGate};
