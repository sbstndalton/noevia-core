'use strict';
function clear(workspaces, name) {
  let own = [];
  for (const [index, ws] of workspaces.entries()) {
    if (!ws.autoRoles) continue;
    const next = {...ws.autoRoles}, cleared = [];
    for (const role of ['fast','smart','vision','code','creative']) {
      if (next[role] !== name) continue;
      cleared.push(role);
      if (role === 'fast' || role === 'smart') { const other = role === 'fast' ? 'smart' : 'fast'; next[role] = next[other] && next[other] !== name ? next[other] : ''; }
      else delete next[role];
    }
    if (!cleared.length) continue;
    ws.autoRoles = next.fast === '' && next.smart === '' ? null : next;
    ws.saveAutoRoles?.(); if (index === 0) own = cleared;
  }
  return own;
}
module.exports = {clear};
