'use strict';
function describeMcpServers(servers, states, tools, manifest) {
  return servers.map(server => {
    const state=states.get(server.id);
    const expected=new Set(manifest.filter(box=>box.server===server.id).flatMap(box=>box.tools));
    const missing=[...expected].filter(name=>tools.get(name)?.serverId!==server.id);
    return {id:server.id,auth:server.auth,error:state?.error||null,discovered:state?.toolCount||0,
      checkedAt:state?.discoveredAt||null,missingCurated:missing.length};
  });
}
module.exports={describeMcpServers};
