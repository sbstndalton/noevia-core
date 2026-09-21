'use strict';
const count=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.min(value,Number.MAX_SAFE_INTEGER):0;
const zero=()=>({input:0,output:0,replies:0});
const add=(a,b)=>{for(const key of ['input','output','replies'])a[key]=Math.min(Number.MAX_SAFE_INTEGER,a[key]+count(b?.[key]));return a;};
// Counters added after the first release (tool calls, replies by hour) are
// absent from older files; every reader treats them as empty rather than
// requiring a migration.
const addCounts=(target,source)=>{for(const [key,value] of Object.entries(source||{}))target[key]=Math.min(Number.MAX_SAFE_INTEGER,(target[key]||0)+count(value));return target;};
function mergeUsage(stores,into) {
  const days=into?.days||Object.create(null);
  for(const store of stores)for(const [day,bucket] of Object.entries(store?.days||{})){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!bucket||typeof bucket!=='object')continue;
    const target=days[day]||(days[day]={...zero(),models:Object.create(null),tools:Object.create(null),hours:Object.create(null)});add(target,bucket);
    for(const [model,totals] of Object.entries(bucket.models||{}))add(target.models[model]||(target.models[model]=zero()),totals);
    addCounts(target.tools||(target.tools=Object.create(null)),bucket.tools);
    addCounts(target.hours||(target.hours=Object.create(null)),bucket.hours);
  }
  return {days};
}
function peakHourOf(hours) {
  let best=null,most=0;
  for(let hour=0;hour<24;hour++){const value=count(hours[hour]);if(value>most){most=value;best=hour;}}
  return most>0?{hour:best,replies:most}:null;
}
function summarizeUsage(store,{dayKey,retentionDays=365,now=new Date()}) {
  const today=dayKey(now),days=[],cursor=new Date(now);cursor.setHours(12,0,0,0);
  const models=Object.create(null),tools=Object.create(null),hours=Object.create(null);
  for(let i=retentionDays-1;i>=0;i--){
    const date=new Date(cursor);date.setDate(date.getDate()-i);const day=dayKey(date),bucket=store.days?.[day];
    const totals=add(zero(),bucket);days.push({day,...totals});
    for(const [name,raw] of Object.entries(bucket?.models||{}))add(models[name]||(models[name]=zero()),add(zero(),raw));
    addCounts(tools,bucket?.tools);
    addCounts(hours,bucket?.hours);
  }
  const totals=n=>days.slice(-n).reduce((result,day)=>add(result,day),zero());
  let streak=0,longest=0,run=0;
  for(let i=days.length-1;i>=0;i--){if(days[i].replies>0)streak++;else if(days[i].day!==today)break;}
  for(const day of days){run=day.replies>0?run+1:0;longest=Math.max(longest,run);}
  return {days,allTime:totals(days.length),last7:totals(7),last30:totals(30),activeDays:days.filter(day=>day.replies>0).length,currentStreak:streak,longestStreak:longest,
    models:Object.entries(models).map(([name,value])=>({name,...value})).sort((a,b)=>b.input+b.output-a.input-a.output),
    tools:Object.entries(tools).map(([name,calls])=>({name,calls})).filter(t=>t.calls>0).sort((a,b)=>b.calls-a.calls||a.name.localeCompare(b.name)),
    // 24 buckets in the same local clock the day keys use. peakHour is null
    // until something has actually been recorded, so the view can say so.
    hours:Array.from({length:24},(_,hour)=>count(hours[hour])),peakHour:peakHourOf(hours),
    retentionDays,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'server local time'};
}
module.exports={mergeUsage,summarizeUsage};

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
