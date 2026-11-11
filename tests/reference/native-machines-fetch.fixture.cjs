'use strict';
// A transport double loaded by the client probe and its I/O worker. No sockets are opened.
globalThis.fetch = async (url, init) => {
  if (url !== 'http://127.0.0.1:7777/v1/inference-machines' || init.method !== 'POST' || init.headers['x-noevia-store-token'] !== 'synthetic-native-token-0123456789abcdef') throw Error('Unexpected native fixture request');
  const body = JSON.parse(init.body);
  if (body.op === 'session') return new Response('{"epoch":1}', {status:200});
  if (['assignmentOf','machine','tuneStatus'].includes(body.op)) return new Response('{}', {status:200});
  if (body.op === 'runtimeSource') return new Response('"invalid-source"', {status:200});
  return new Response('{"error":"Inference machines are unavailable.","code":"machinesUnavailable"}', {status:503});
};
