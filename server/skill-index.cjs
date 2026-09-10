'use strict';
// Metadata only. Exact filenames are necessary because read_project_file takes
// a filename, not a skill's display name. Bodies still use the existing tool.
function formatSkillIndex(skills) {
  const lines=[];let size=0,omitted=0;
  for(const skill of skills){
    if(typeof skill.file!=='string'||!skill.file||skill.file.length>500){omitted++;continue;}
    const line=JSON.stringify({file:skill.file,name:String(skill.name||skill.file).slice(0,160),description:String(skill.description||'').slice(0,500),version:String(skill.version||'').slice(0,80)});
    if(lines.length>=32||size+line.length+1>6144){omitted++;continue;}
    lines.push(line);size+=line.length+1;
  }
  if(omitted)lines.push(`(${omitted} additional skill metadata entries omitted to fit the context limit.)`);
  return lines.join('\n');
}
module.exports={formatSkillIndex};
