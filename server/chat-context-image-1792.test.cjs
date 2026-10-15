'use strict';
// #1792: an image turn in a short chat on a 12k-context model failed with "Context is still too full after
// compaction" at about 7.8k of 12.3k. Each image was estimated at 4096 tokens (the engine's own budget is
// --image-max-tokens 1024), and with only two earlier exchanges nothing could be compacted, since the two most
// recent exchanges are always kept. Synthetic messages only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ctx = require('./chat-context.cjs');

const image = (n = 1) => Array.from({ length: n }, () => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(1052)}` } }));

test('#1792: one image costs the engine image budget, not 4096 tokens', () => {
  const withImage = ctx.tokens({ role: 'user', content: [{ type: 'text', text: 'what colour is it?' }, ...image()] });
  const without = ctx.tokens({ role: 'user', content: [{ type: 'text', text: 'what colour is it?' }] });
  assert.equal(ctx.IMAGE_TOKENS, require('./llamacpp-autoconfig.cjs').IMAGE_MAX_TOKENS, 'the estimate follows the engine preset');
  assert.ok(withImage - without <= 1100, `one image counted as ${withImage - without} tokens`);
  assert.ok(ctx.tokens({ content: image(3) }) < 3 * 1100);
});

test('#1792: a short chat that no longer fits keeps the current turn and summarises the rest', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-1792-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const limit = 12288;
  const system = { role: 'system', content: 'Synthetic instructions. '.repeat(330) };
  const tools = [{ type: 'function', function: { name: 'synthetic_search', description: 'x'.repeat(5200), parameters: { type: 'object', properties: {} } } }];
  const history = [
    { role: 'user', content: 'QA what is 17*23?' },
    { role: 'assistant', content: '391.' },
    { role: 'user', content: 'QA what is the weather in a synthetic town?' },
    { role: 'assistant', content: 'Synthetic forecast sentence with a source link. '.repeat(120) },
  ];
  const current = { role: 'user', content: [{ type: 'text', text: 'QA what colour is the shape in the attached image?' }, ...image()] };
  const messages = [system, ...history, current];
  const summarised = [];
  const out = await ctx.prepare({ dir, id: 'c-1792', messages, tools, limit, limitSource: 'test', model: 'synthetic-12k',
    summarize: async (_prev, batch) => { summarised.push(...batch); return 'Earlier: 17*23 = 391; a synthetic weather answer with its source.'; } });
  assert.deepEqual(out.messages.at(-1), current, 'the current turn, image included, is kept as sent');
  assert.deepEqual(summarised, history, 'both earlier exchanges were summarised');
  assert.ok(out.meter.used <= out.meter.threshold);
});

test('#1792: two recent exchanges are still kept whenever they fit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-1792-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'Synthetic history. '.repeat(50) }));
  const out = await ctx.prepare({ dir, id: 'two', messages: original, tools: [], limit: 4800, model: 'q', summarize: async () => 'Summary.' });
  assert.deepEqual(out.messages.slice(-4), original.slice(-4));
});
