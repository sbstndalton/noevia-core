'use strict';
// An execution-local fence survives every credential/connection await. All write-capable
// executors call send synchronously at their outbound boundary, including each retry.
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const CODE = 'APPROVAL_REVOKED';
function send(outbound) {
  const fence = scope.getStore();
  if (fence && !fence.open()) throw Object.assign(Error('The permission changed before the write was sent; tool was not run. Ask again.'), { code: CODE });
  return outbound();
}
module.exports = { CODE, send, run: (fence, execute) => scope.run(fence || null, execute) };
