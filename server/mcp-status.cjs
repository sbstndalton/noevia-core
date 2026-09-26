'use strict';
function describeMcpServers(servers, states, tools, manifest) {
  return servers.map(server => {
    const state=states.get(server.id);
    const expected=new Set(manifest.filter(box=>box.server===server.id).flatMap(box=>box.tools));
    const missing=[...expected].filter(name=>tools.get(name)?.serverId!==server.id);
    // `directory` marks a server an administrator added through the MCP directory (Plugins →
    // Added, #366); everything else here — the internal server and any MCP_SERVERS/MCP_SERVER_URL
    // entry — is configured for this deployment and was never going to appear in that list.
    return {id:server.id,auth:server.auth,error:state?.error||null,discovered:state?.toolCount||0,
      checkedAt:state?.discoveredAt||null,missingCurated:missing.length,directory:!!server.directory};
  });
}
module.exports={describeMcpServers};
