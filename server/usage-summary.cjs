'use strict';
const count=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.min(value,Number.MAX_SAFE_INTEGER):0;
const zero=()=>({input:0,output:0,replies:0});
const add=(a,b)=>{for(const key of ['input','output','replies'])a[key]=Math.min(Number.MAX_SAFE_INTEGER,a[key]+count(b?.[key]));return a;};
function validateRates(value) {
  if(!value||typeof value!=='object'||!Array.isArray(value.rates)||value.rates.length>200||!/^[A-Z]{3}$/.test(value.currency||''))throw Error('Use a three-letter currency code and at most 200 model rates.');
  const seen=new Set();
  const rates=value.rates.map(rate=>{
    const model=String(rate?.model||'').trim();
    if(!model||model.length>200||seen.has(model))throw Error('Model names must be unique and at most 200 characters.');
    seen.add(model);
    for(const key of ['inputPerMillion','outputPerMillion'])if(typeof rate[key]!=='number'||!Number.isFinite(rate[key])||rate[key]<0||rate[key]>100000)throw Error('Rates must be numbers from 0 to 100000 per million tokens.');
    return {model,inputPerMillion:rate.inputPerMillion,outputPerMillion:rate.outputPerMillion};
  });
  return {currency:value.currency,rates};
}
function mergeUsage(stores,into) {
  const days=into?.days||Object.create(null);
  for(const store of stores)for(const [day,bucket] of Object.entries(store?.days||{})){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!bucket||typeof bucket!=='object')continue;
    const target=days[day]||(days[day]={...zero(),models:Object.create(null)});add(target,bucket);
    for(const [model,totals] of Object.entries(bucket.models||{}))add(target.models[model]||(target.models[model]=zero()),totals);
  }
  return {days};
}
function summarizeUsage(store,{dayKey,retentionDays=365,now=new Date(),pricing={currency:'USD',rates:[]}}) {
  const today=dayKey(now),days=[],cursor=new Date(now);cursor.setHours(12,0,0,0);
  const models=Object.create(null),rates=new Map(pricing.rates.map(rate=>[rate.model,rate]));
  const costs=[];
  for(let i=retentionDays-1;i>=0;i--){
    const date=new Date(cursor);date.setDate(date.getDate()-i);const day=dayKey(date),bucket=store.days?.[day];
    const totals=add(zero(),bucket);days.push({day,...totals});
    let subtotal=0,pricedTokens=0,reportedModelTokens=0;const unpriced=new Set();
    for(const [name,raw] of Object.entries(bucket?.models||{})){
      const value=add(zero(),raw);add(models[name]||(models[name]=zero()),value);
      const tokens=value.input+value.output;reportedModelTokens+=tokens;
      const rate=rates.get(name);
      if(!rate&&tokens)unpriced.add(name);
      if(rate){pricedTokens+=tokens;subtotal+=(value.input*rate.inputPerMillion+value.output*rate.outputPerMillion)/1e6;}
    }
    const unattributedTokens=Math.abs(totals.input+totals.output-reportedModelTokens);
    costs.push({subtotal,pricedTokens,unpriced:[...unpriced],unattributedTokens});
  }
  const totals=n=>days.slice(-n).reduce((result,day)=>add(result,day),zero());
  const cost=n=>{
    const rows=costs.slice(-n),unpricedModels=[...new Set(rows.flatMap(row=>row.unpriced))];
    const unattributedTokens=rows.reduce((sum,row)=>sum+row.unattributedTokens,0),subtotal=rows.reduce((sum,row)=>sum+row.subtotal,0);
    return {amount:unpricedModels.length||unattributedTokens?null:subtotal,pricedSubtotal:subtotal,unpricedModels,unattributedTokens,pricedTokens:rows.reduce((sum,row)=>sum+row.pricedTokens,0)};
  };
  let streak=0,longest=0,run=0;
  for(let i=days.length-1;i>=0;i--){if(days[i].replies>0)streak++;else if(days[i].day!==today)break;}
  for(const day of days){run=day.replies>0?run+1:0;longest=Math.max(longest,run);}
  return {days,allTime:totals(days.length),last7:totals(7),last30:totals(30),activeDays:days.filter(day=>day.replies>0).length,currentStreak:streak,longestStreak:longest,
    models:Object.entries(models).map(([name,value])=>({name,...value})).sort((a,b)=>b.input+b.output-a.input-a.output),retentionDays,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'server local time',
    costs:{currency:pricing.currency,configured:pricing.rates.length>0,allTime:cost(days.length),last7:cost(7),last30:cost(30)}};
}
module.exports={validateRates,mergeUsage,summarizeUsage};

let aggregateCache=null;
async function aggregateUsage(users,userDir,now=Date.now()) {
  if(users.length>1000)throw Error('Aggregate usage supports at most 1000 current accounts.');
  const paths=users.map(user=>require('path').join(userDir(user.id),'usage.json'));
  const signature=JSON.stringify(paths);
  if(aggregateCache?.signature===signature&&now-aggregateCache.at<30000)return aggregateCache.value;
  const fs=require('fs').promises;let next=0,unreadableAccounts=0,merged={days:{}};
  await Promise.all(Array.from({length:Math.min(8,paths.length)},async()=>{
    while(next<paths.length){const file=paths[next++];try{
      const stat=await fs.stat(file);if(stat.size>2*1024*1024)throw Error('oversize');
      const value=JSON.parse(await fs.readFile(file,'utf8'));
      if(!value?.days||typeof value.days!=='object'||Array.isArray(value.days))throw Error('invalid');
      merged=mergeUsage([value],merged);
    }catch(error){if(error.code!=='ENOENT')unreadableAccounts++;}}
  }));
  const value={store:merged,accounts:users.length,unreadableAccounts,checkedAt:now};
  aggregateCache={signature,at:now,value};return value;
}
module.exports.aggregateUsage=aggregateUsage;
