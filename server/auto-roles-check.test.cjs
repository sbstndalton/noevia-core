const test = require('node:test');
const assert = require('node:assert/strict');
const { missingRoles, staleRolesError } = require('./auto-roles-check.cjs');

const installed = [{ name: 'Qwen3.5-4B-Q5_K_M' }, { name: 'Ornith-1.5-9B-Q5_K_M' }];

test('roles that name served models are not missing', () => {
  assert.deepEqual(missingRoles({ fast: 'Qwen3.5-4B-Q5_K_M', smart: 'Ornith-1.5-9B-Q5_K_M' }, installed), []);
});

test('roles naming models that are no longer served are reported per role', () => {
  // The live config kept two Gemma models after the presets were replaced, so Auto failed on every turn.
  const roles = { fast: 'gemma-4-E2B-it-GGUF-UD-Q4_K_XL', smart: 'Ornith-1.5-9B-Q5_K_M', vision: 'Gemma-4-E4B-it-GGUF' };
  assert.deepEqual(missingRoles(roles, installed), [
    { role: 'fast', model: 'gemma-4-E2B-it-GGUF-UD-Q4_K_XL' },
    { role: 'vision', model: 'Gemma-4-E4B-it-GGUF' },
  ]);
});

test('an unknown catalogue never declares roles missing', () => {
  assert.deepEqual(missingRoles({ fast: 'x', smart: 'y' }, null), []);
  assert.deepEqual(missingRoles(null, installed), []);
});

test('the chat error names the role, the model and where to fix it', () => {
  assert.equal(staleRolesError([]), null);
  const message = staleRolesError([{ role: 'fast', model: 'gone' }]);
  assert.match(message, /Fast/);
  assert.match(message, /gone/);
  assert.match(message, /Models & routing/);
});
