'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { signS3Request } = require('./s3-sign.cjs');

// SigV4 probe signer tests. The expected signature is produced by the diary
// sidecar's Python signer (services/diary/agent/s3_storage.py), which is
// verified against the official AWS SigV4 test vector — so this pins the Node
// probe and the Python corpus client to byte-identical signing.

test('signS3Request matches the Python signer byte-for-byte on the probe request', () => {
  const url = new URL('https://s3.example.com/diary-bucket?list-type=2&max-keys=1');
  const headers = signS3Request(
    'GET', url, '',
    'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    { amzDate: '20130524T000000Z' },
  );
  assert.equal(headers.host, 's3.example.com');
  assert.match(headers.Authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.match(headers.Authorization, /Signature=4560899e7ffad2d2164e3dbc99454334a44ba5a4a86bf34dadad3be59e0364ad$/);
});

test('signS3Request signs a PUT payload hash into the canonical request', () => {
  const url = new URL('https://s3.example.com/diary-bucket/2026-09.md');
  const body = Buffer.from('month contents');
  const headers = signS3Request(
    'PUT', url, body,
    'AK', 'SK',
    { amzDate: '20130524T000000Z' },
  );
  // The payload hash must be both the x-amz-content-sha256 header and part of
  // the signed canonical request; a mismatch here is the classic SigV4 403.
  const payloadHash = require('node:crypto').createHash('sha256').update(body).digest('hex');
  assert.equal(headers['x-amz-content-sha256'], payloadHash);
  assert.match(headers.Authorization, /Signature=[0-9a-f]{64}/);
});

test('signS3Request canonicalizes query params in sorted order with AWS encoding', () => {
  const url = new URL('https://s3.example.com/diary-bucket?max-keys=1&list-type=2');
  const a = signS3Request('GET', url, '', 'AK', 'SK', { amzDate: '20130524T000000Z' });
  const urlReordered = new URL('https://s3.example.com/diary-bucket?list-type=2&max-keys=1');
  const b = signS3Request('GET', urlReordered, '', 'AK', 'SK', { amzDate: '20130524T000000Z' });
  assert.equal(a.Authorization, b.Authorization, 'signature must not depend on query param order');
});
