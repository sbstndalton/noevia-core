'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { isSystemModel, modelPathFromArgs, SYSTEM_MODEL_REASON } = require('./model-system.cjs');

test('isSystemModel matches Laya by id, case-insensitively, but not lookalike chat models', () => {
  assert.equal(isSystemModel('laya_multilingual_f16'), true);
  assert.equal(isSystemModel('LAYA_multilingual_f16'), true);
  assert.equal(isSystemModel('laya-mini'), true);
  assert.equal(isSystemModel('laya'), true);
  assert.equal(isSystemModel('synthetic'), false);
  assert.equal(isSystemModel('layax-chat'), false, 'a model merely starting with the same letters is not Laya');
});

test('isSystemModel also matches by --model path, even if the id were renamed', () => {
  assert.equal(isSystemModel('custom-id', '/models/laya_multilingual_f16/laya_multilingual_f16.gguf'), true);
  assert.equal(isSystemModel('custom-id', '/models/synthetic/synthetic.gguf'), false);
});

test('modelPathFromArgs reads the value following --model or -m', () => {
  assert.equal(modelPathFromArgs(['--model', '/models/laya_multilingual_f16/laya_multilingual_f16.gguf', '--ctx-size', '4096']),
    '/models/laya_multilingual_f16/laya_multilingual_f16.gguf');
  assert.equal(modelPathFromArgs(['-m', '/models/x.gguf']), '/models/x.gguf');
  assert.equal(modelPathFromArgs(['--embedding']), '');
  assert.equal(modelPathFromArgs(undefined), '');
});

test('SYSTEM_MODEL_REASON is distinct wording from the ordinary "not configured" skip reason', () => {
  assert.notEqual(SYSTEM_MODEL_REASON, 'Not a configured chat model');
});
