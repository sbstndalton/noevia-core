'use strict';
// #1979: a registered remote machine that the deployment also names as the embeddings address
// (EMBEDDING_SERVICE_URL) is that machine, not "This machine". Synthetic addresses only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInferenceMachines } = require('./inference-machines.cjs');

function memoryStore() {
  const map = new Map();
  return { get: (k) => map.get(k), set: (k, v) => map.set(k, v), delete: (k) => map.delete(k) };
}
const lookup = async () => [{ address: '192.168.1.50', family: 4 }];
function registry({ embedding, localEmbeddingUrl }) {
  return createInferenceMachines({ store: memoryStore(), lookup, embeddingActive: () => embedding, localEmbeddingUrl: () => localEmbeddingUrl, log: () => {} });
}

test('a registered machine whose address equals the deployment embeddings URL is labelled by its machine', async () => {
  const url = 'http://192.168.1.50:8081/v1';
  const embedding = { baseUrl: url, model: 'embed-a', profile: 'nomic-v1' };
  const machines = registry({ embedding, localEmbeddingUrl: url });
  const { machine } = await machines.add({ name: 'Pi 5', address: '192.168.1.50' }, 'admin');
  assert.deepEqual(machines.assignmentOf('embedding'), { machine: machine.id, port: 8081 });
  const v = machines.view();
  assert.equal(v.machines.find((m) => m.id === 'local').services.includes('embedding'), false);
  assert.ok(v.machines.find((m) => m.id === machine.id).services.includes('embedding'));
  assert.equal(v.services.find((s) => s.id === 'embedding').machine, machine.id);
});

test('"move back to this machine" is refused when the deployment address is a registered machine', async () => {
  const url = 'http://192.168.1.50:8081/v1';
  const machines = registry({ embedding: { baseUrl: url, model: 'embed-a', profile: 'nomic-v1' }, localEmbeddingUrl: url });
  await machines.add({ name: 'Pi 5', address: '192.168.1.50' }, 'admin');
  assert.throws(() => machines.assign({ service: 'embedding', machine: 'local' }, 'admin'), (err) => err.status === 409 && err.code === 'noLocalEmbedding');
});

test('an unregistered host equal to the deployment address is still this machine (last fallback)', () => {
  const url = 'http://192.168.1.50:8081/v1';
  const machines = registry({ embedding: { baseUrl: url, model: 'embed-a', profile: 'nomic-v1' }, localEmbeddingUrl: url });
  assert.equal(machines.assignmentOf('embedding').machine, 'local');
  // A different port on that host is not the deployment's embeddings server.
  const other = registry({ embedding: { baseUrl: 'http://192.168.1.50:9090/v1', model: 'embed-a', profile: 'nomic-v1' }, localEmbeddingUrl: url });
  assert.equal(other.assignmentOf('embedding').machine, 'other');
});

test('a Docker service name stays this machine, and moving back still names the deployment address', async () => {
  const url = 'http://embed:8080/v1';
  const embedding = { baseUrl: url, model: 'embed-a', profile: 'nomic-v1' };
  const machines = registry({ embedding, localEmbeddingUrl: url });
  const { machine } = await machines.add({ name: 'Pi 5', address: '192.168.1.50' }, 'admin');
  assert.equal(machines.assignmentOf('embedding').machine, 'local');
  embedding.baseUrl = 'http://192.168.1.50:8081/v1';
  assert.equal(machines.assignmentOf('embedding').machine, machine.id);
  assert.throws(() => machines.assign({ service: 'embedding', machine: 'local' }, 'admin'), (err) => err.code === 'reindexRequired' && err.target.baseUrl === url);
});
