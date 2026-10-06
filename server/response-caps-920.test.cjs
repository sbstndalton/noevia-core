'use strict';
// #920: the response reads left over from #902/#903 now stop at a cap too. Each fake reply is a
// pull-based stream far larger than the cap; each test asserts the reader stopped after about the
// cap instead of draining it. Synthetic hosts only; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readCappedBuffer } = require('./http.cjs');

const CHUNK = 64 * 1024;
const MB = 1024 * 1024;

/** A body of `total` bytes (far past any cap) that counts what was actually pulled. */
function hugeBody(total = 64 * MB, prefix = '') {
  const meter = { pulled: 0, cancelled: false };
  let first = Buffer.from(prefix);
  const stream = new ReadableStream({
    pull(controller) {
      if (meter.pulled >= total) return controller.close();
      const chunk = first.length ? first : Buffer.alloc(CHUNK, 0x61);
      first = Buffer.alloc(0);
      meter.pulled += chunk.length;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() { meter.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, meter };
}
const within = (meter, cap) => assert.ok(meter.pulled <= cap + 2 * CHUNK, `pulled ${meter.pulled} bytes`);

test('readCappedBuffer stops after the cap, reports it, and reads a short body whole', async () => {
  const { stream, meter } = hugeBody();
  const out = await readCappedBuffer(new Response(stream), 100 * 1024);
  assert.equal(out.capped, true);
  assert.equal(out.bytes.length, 100 * 1024);
  within(meter, 100 * 1024);
  assert.equal(meter.cancelled, true);
  const whole = await readCappedBuffer(new Response(Buffer.from([1, 2, 3])), 1024);
  assert.deepEqual([whole.capped, [...whole.bytes]], [false, [1, 2, 3]]);
  const exact = await readCappedBuffer(new Response(Buffer.alloc(10, 7)), 10);
  assert.equal(exact.capped, false, 'a body of exactly the cap is not capped');
  const stub = await readCappedBuffer({ arrayBuffer: async () => new Uint8Array(20).buffer }, 10);
  assert.deepEqual([stub.capped, stub.bytes.length], [true, 10]);
});

test('ocr: an endless worker reply is cut at 16 MB and reported as an invalid response', async () => {
  const { extractPages } = require('./ocr.cjs');
  const { stream, meter } = hugeBody(64 * MB, '{"pages":["');
  await assert.rejects(() => extractPages(Buffer.from('x'), [1], { url: 'http://ocr.invalid', fetchImpl: async () => new Response(stream) }),
    /Invalid OCR response; refresh to retry\./);
  within(meter, 16 * MB);
  const ok = await extractPages(Buffer.from('x'), [1], { url: 'http://ocr.invalid', fetchImpl: async () => new Response('{"pages":[{"page":1,"text":"hi"}]}') });
  assert.deepEqual(ok, [{ page: 1, text: 'hi' }]);
});

test('docx: an endless reader reply is cut at 2 MB and reported as an invalid response', async () => {
  const { extract } = require('./docx.cjs');
  const { stream, meter } = hugeBody(64 * MB, '{"text":"');
  await assert.rejects(() => extract(Buffer.from('x'), { url: 'http://ocr.invalid', fetchImpl: async () => new Response(stream) }), /Invalid DOCX reader response\./);
  within(meter, 2 * MB);
  assert.deepEqual(await extract(Buffer.from('x'), { url: 'http://ocr.invalid', fetchImpl: async () => new Response('{"text":"hello","truncated":false}') }), { text: 'hello', truncated: false });
});

test('vision probe: an endless error body is cut at 64 KB; the verdict is unchanged', async () => {
  const { createVisionProbe } = require('./vision.cjs');
  const { stream, meter } = hugeBody(64 * MB, 'mmproj ');
  const probe = createVisionProbe({ fetchImpl: async () => new Response(stream, { status: 500 }) });
  const result = await probe('http://model.invalid', {}, 'm');
  assert.equal(result.supported, false);
  assert.match(result.reason, /projector/);
  within(meter, 64 * 1024);
});

test('plugin directory: an endless SKILL.md is cut at 32 KiB and refused with the same 422', async () => {
  const { fetchPublishedSkill } = require('./routes/plugin-directory.cjs');
  const { stream, meter } = hugeBody(64 * MB, '---\nname: x\n---\n');
  await assert.rejects(() => fetchPublishedSkill('synthetic-skill', { fetchImpl: async () => new Response(stream) }),
    (e) => e.status === 422 && /32 KiB limit/.test(e.message));
  within(meter, 32 * 1024);
});

test('plugin directory: an endless registry listing is cut at 4 MB and answered 502', async () => {
  const { createPluginDirectoryRoutes } = require('./routes/plugin-directory.cjs');
  const { stream, meter } = hugeBody(64 * MB, '{"servers":[');
  const sent = [];
  const routes = createPluginDirectoryRoutes({ json: (_res, status, body) => sent.push({ status, body }), fetchImpl: async () => new Response(stream) });
  await routes({ method: 'GET', url: '/api/plugins/directory?kind=mcp' }, {}, { path: '/api/plugins/directory', url: new URL('http://l/api/plugins/directory?kind=mcp') });
  assert.equal(sent.at(-1).status, 502);
  within(meter, 4 * MB);
});

test('offsite S3: an endless listing page is cut at 4 MB and refused with a 502', async () => {
  const { createS3Store } = require('./offsite-s3.cjs');
  const { stream, meter } = hugeBody(64 * MB, '<ListBucketResult><Key>noevia-backup/a</Key>');
  const store = createS3Store({ endpoint: 'https://s3.invalid', bucket: 'b', accessKeyId: 'synthetic', secretAccessKey: 'synthetic', fetchImpl: async () => new Response(stream) });
  await assert.rejects(() => store.list('x/'), (e) => e.status === 502 && /too large/.test(e.message));
  within(meter, 4 * MB);
});

test('kiwix: an endless article is cut at 2 MB and the tool still answers', async () => {
  const { createKiwixTools } = require('./kiwix.cjs');
  const { stream, meter } = hugeBody(64 * MB, '<html><body>');
  const tools = createKiwixTools({ baseUrl: 'http://kiwix.invalid', fetchImpl: async () => new Response(stream) });
  const out = await tools.execute('wikipedia_read', { path: '/content/wiki/Synthetic' });
  assert.equal(typeof out, 'string');
  within(meter, 2_000_000);
});
