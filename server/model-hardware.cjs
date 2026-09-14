'use strict';
// Allowlist only hardware facts. Never forward system paths, environment or cloud configuration.
const number=value=>typeof value==='number' && Number.isFinite(value) && value>0 && value<=4096?value:null;
const label=value=>typeof value==='string'?value.slice(0,160):'';
function modelHardware(raw) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))throw Error('Invalid hardware response');
  const memory=/^(\d+(?:\.\d+)?)\s*GB$/i.exec(typeof raw['Physical Memory']==='string'?raw['Physical Memory']:'');
  const devices=raw.devices && typeof raw.devices==='object'?raw.devices:{};
  const gpus=[];
  for(const key of ['amd_gpu','nvidia_gpu','intel_gpu','apple_gpu']) {
    if(!Array.isArray(devices[key]))continue;
    for(const [index,gpu] of devices[key].slice(0,16).entries())if(gpu && gpu.available===true){
      gpus.push({id:`${key}:${index}`,name:label(gpu.name)||'Reported GPU',capacityGB:number(gpu.vram_gb),sharedGB:number(gpu.virtual_mem_gb)});
    }
  }
  return {source:'model-manager',cpu:label(devices.cpu?.name),systemGB:memory?number(Number(memory[1])):null,gpus};
}
module.exports={modelHardware};
