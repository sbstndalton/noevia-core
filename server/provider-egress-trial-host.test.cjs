'use strict';
// A custom OpenAI-compatible provider pointed at build.nvidia.com's free API is external by URL:
// NVIDIA's API Trial Terms forbid personal or confidential data and log traffic, so the #447
// rules (no Diary text, no private toolboxes) apply without any flag on the row. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const egress = require('./provider-egress.cjs');

const nvidia = (baseUrl) => ({ id: 'prov-1', label: 'NVIDIA Build (free trial)', baseUrl });

test('the NVIDIA hosted endpoint is external without an external flag', () => {
  assert.equal(egress.isExternalProvider(nvidia('https://integrate.api.nvidia.com/v1')), true);
  assert.equal(egress.isExternalProvider(nvidia('https://ai.api.nvidia.com/v1')), true);
  assert.equal(egress.isExternalProvider(nvidia('HTTPS://Integrate.API.NVIDIA.com./v1')), true);
  assert.equal(egress.isExternalProvider(nvidia('https://integrate.api.nvidia.com../v1')), true);
});

test('lookalike hosts, local NIM containers and other providers stay ordinary', () => {
  for (const url of ['https://evilnvidia.com/v1', 'https://nvidia.com.example.invalid/v1', 'http://localhost:8000/v1', 'http://host.docker.internal:8000/v1', 'https://openrouter.ai/api/v1', 'not a url', '']) {
    assert.equal(egress.isExternalProvider(nvidia(url)), false, url);
  }
  assert.equal(egress.isExternalProvider(null), false);
});

test('Diary spaces and the diary toolbox are refused on the NVIDIA endpoint', () => {
  const provider = nvidia('https://integrate.api.nvidia.com/v1');
  assert.match(egress.egressRefusal({ provider, spaceId: 'diary' }), /Diary text is never sent to an external provider/);
  assert.match(egress.egressRefusal({ provider, projectId: 'p-diary', diaryProjectId: 'p-diary' }), /never sent/);
  const selected = ['core', 'diary'];
  assert.deepEqual(egress.stripPrivateToolboxes(selected, provider), ['diary']);
  assert.deepEqual(selected, ['core']);
});
