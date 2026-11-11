'use strict';
// The picker's facts are the front's own now (its MCP discovery plus toolbox-chat-facts.cjs); the Node bridge
// `/internal/toolbox-picker/facts` is gone. What stays: the public path is refused here before authentication.
const test = require('node:test');
const assert = require('node:assert/strict');
const { refuseOwned, ROUTE_REFUSAL } = require('./rust-toolbox-picker.cjs');
test('public Node path refuses every method before authentication and leaves siblings alone', () => {
  const calls = []; const options = { parseRequestUrl: req => new URL(req.url, 'http://localhost'), json: (_r, status, body) => calls.push({ status, body }) };
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) assert.equal(refuseOwned({ method, url: '/api/toolboxes?userId=other' }, {}, options), true);
  assert.ok(calls.every(c => c.status === 503 && c.body === ROUTE_REFUSAL));
  assert.equal(refuseOwned({ method: 'GET', url: '/api/toolboxes/permitted' }, {}, options), false);
});
