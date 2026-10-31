'use strict';
// noevia#2252 (#2238): GET /api/models/assignments reports what is configured, not what answers. A set-up
// service whose address is closed reads 'active' (the Models page words it from the machines probe, and a
// member's page says "Configured"). The contract this pins: the builder is pure (it has no way to send a
// request) and adds no reachability claim of its own. Synthetic fakes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelAssignments } = require('../../server/model-assignments.cjs');

const CLOSED = { OCR_BASE_URL: 'http://127.0.0.1:9', DOCLING_BASE_URL: 'http://127.0.0.1:9', EMBEDDING_MODEL: 'embed-x' };

test('#2238: set-up services read active whether or not they answer, for members and administrators', () => {
  const installed = [{ name: 'embed-x', labels: ['embedding'] }];
  for (const admin of [false, true]) {
    const { services } = modelAssignments({ installed, env: CLOSED, admin });
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    assert.equal(by.ocr.state, 'active');
    assert.equal(by.documents.state, 'active');
    assert.equal(by.embedding.state, 'active');
    // No reachability claim of any kind, and no address reaches a member.
    for (const svc of services) assert.ok(!('reachable' in svc) && !('health' in svc), svc.id);
    assert.equal(JSON.stringify(services).includes('127.0.0.1'), false);
  }
});
