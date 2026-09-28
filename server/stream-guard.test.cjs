'use strict';
// stream-guard.cjs (#516) — incremental JSON schema validator + bounded
// correction helper. Everything here uses scripted fake streams; no network,
// no real model, no live flags. Chunk boundaries are chosen deliberately to
// split tokens, escapes and unicode escapes to prove the validator buffers
// correctly rather than only working when a chunk happens to align with a
// JSON token.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createValidator,
  runGuardedStream,
  GuardAbortError,
  CorrectionFailedError,
  buildCorrectionRequest,
} = require('./stream-guard.cjs');

function feedChunks(schema, chunks, options) {
  const v = createValidator(schema, options);
  for (const c of chunks) {
    const violation = v.feed(c);
    if (violation) return { violation, stoppedAtChunk: chunks.indexOf(c) };
  }
  const endViolation = v.end();
  return { violation: endViolation || null, done: v.isDone() };
}

function chunkEvery(str, n) {
  const out = [];
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
  return out;
}

const toolArgsSchema = {
  type: 'object',
  required: ['action', 'target'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['read', 'write', 'delete'] },
    target: { type: 'string', maxLength: 10 },
    count: { type: 'integer' },
    tags: { type: 'array', maxItems: 2, items: { type: 'string' } },
  },
};

test('valid document passes whole and split at every 1-3 characters', () => {
  const doc = JSON.stringify({ action: 'read', target: 'file.txt', count: 3, tags: ['a', 'b'] });
  assert.equal(feedChunks(toolArgsSchema, [doc]).violation, null);
  for (const size of [1, 2, 3, 7]) {
    const result = feedChunks(toolArgsSchema, chunkEvery(doc, size));
    assert.equal(result.violation, null, `size ${size} unexpectedly failed`);
    assert.equal(result.done, true);
  }
});

test('unknown key is reported as soon as its closing quote arrives, not at end of document', () => {
  const v = createValidator(toolArgsSchema);
  v.feed('{"action":"read","targetx');
  assert.equal(v.getViolation(), null, 'must not decide before the key string has closed');
  v.feed('"'); // closes the unknown key — decidable right here, before ':' or a value ever arrives
  assert.ok(v.getViolation());
  assert.match(v.getViolation().message, /Unknown property 'targetx'/);
});

test('wrong type is reported at the first character of the value', () => {
  const v = createValidator(toolArgsSchema);
  v.feed('{"action":"read","target":');
  assert.equal(v.getViolation(), null);
  v.feed('1'); // target expects string, got a number
  assert.ok(v.getViolation());
  assert.match(v.getViolation().message, /Type mismatch/);
  // Confirm it did not need the rest of the (invalid) value to decide:
  assert.match(v.getViolation().message, /expected string, got number/);
});

test('enum violation is decided once the string prefix cannot match any candidate', () => {
  const v = createValidator(toolArgsSchema);
  v.feed('{"action":"');
  assert.equal(v.getViolation(), null);
  v.feed('r'); // still a valid prefix of "read"
  assert.equal(v.getViolation(), null);
  v.feed('z'); // "rz" matches none of read/write/delete
  assert.ok(v.getViolation());
  assert.match(v.getViolation().message, /prefix 'rz' is impossible/);
});

test('maxLength is enforced mid-string, before the closing quote', () => {
  const v = createValidator(toolArgsSchema);
  v.feed('{"action":"read","target":"01234567890');
  assert.ok(v.getViolation());
  assert.match(v.getViolation().message, /exceeds maxLength 10/);
});

test('maxItems is enforced before the offending array element is parsed', () => {
  const result = feedChunks(toolArgsSchema, ['{"action":"read","target":"f","tags":["a","b","c"]}']);
  assert.ok(result.violation);
  assert.match(result.violation.message, /exceeds maxItems 2/);
});

test('missing required property is reported at the closing brace', () => {
  const result = feedChunks(toolArgsSchema, ['{"action":"read"}']);
  assert.ok(result.violation);
  assert.match(result.violation.message, /Missing required property target/);
});

test('additionalProperties:false allows every declared property', () => {
  const result = feedChunks(toolArgsSchema, [JSON.stringify({ action: 'write', target: 'a' })]);
  assert.equal(result.violation, null);
});

// ---- chunk-boundary edge cases --------------------------------------------

test('a backslash escape split across a chunk boundary is still decoded correctly', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } } };
  const doc = '{"name":"line1\\nline2"}';
  const idx = doc.indexOf('\\n');
  const chunks = [doc.slice(0, idx + 1), doc.slice(idx + 1)]; // splits between '\' and 'n'
  const result = feedChunks(schema, chunks);
  assert.equal(result.violation, null);
  assert.equal(result.done, true);
});

test('a \\u unicode escape split mid-hex-digits across chunks decodes correctly', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } } };
  const doc = '{"name":"caf\\u00e9"}'; // café
  const idx = doc.indexOf('\\u');
  const chunks = [doc.slice(0, idx + 4), doc.slice(idx + 4)]; // splits mid hex digits
  const result = feedChunks(schema, chunks);
  assert.equal(result.violation, null);
});

test('a surrogate-pair unicode escape split between the two \\u sequences decodes correctly', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } } };
  const doc = '{"name":"a\\ud83d\\ude00b"}'; // a😀b (grinning face emoji)
  const idx = doc.indexOf('\\ud83d') + 3;
  const chunks = [doc.slice(0, idx), doc.slice(idx)];
  const result = feedChunks(schema, chunks);
  assert.equal(result.violation, null);
});

test('a literal (true/false/null) split into one character per chunk still parses', () => {
  const schema = { type: 'object', properties: { active: { type: 'boolean' }, note: { type: ['string', 'null'] } } };
  for (const doc of [JSON.stringify({ active: true }), JSON.stringify({ active: false }), JSON.stringify({ note: null })]) {
    const result = feedChunks(schema, doc.split(''));
    assert.equal(result.violation, null, `failed on ${doc}`);
  }
});

test('a number (with exponent) split into one character per chunk still parses and validates', () => {
  const schema = { type: 'object', properties: { x: { type: 'number' } } };
  const doc = JSON.stringify({ x: 1.5e10 });
  const result = feedChunks(schema, doc.split(''));
  assert.equal(result.violation, null);
});

test('integer type rejects a fractional number', () => {
  const schema = { type: 'object', properties: { count: { type: 'integer' } } };
  const result = feedChunks(schema, ['{"count":1.5}']);
  assert.ok(result.violation);
  assert.match(result.violation.message, /Expected an integer/);
});

// ---- runGuardedStream: abort + bounded correction --------------------------

function asyncGen(chunks) {
  return (async function* gen() {
    for (const c of chunks) yield c;
  })();
}

test('a fully valid stream passes on the first attempt and calls the producer exactly once', async () => {
  let calls = 0;
  const res = await runGuardedStream({
    schema: toolArgsSchema,
    createStream: async () => { calls += 1; return asyncGen([JSON.stringify({ action: 'read', target: 'f' })]); },
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(res.corrected, false);
  assert.equal(calls, 1);
});

test('correction request contains only the violation, no orchestrator meta-prompt', () => {
  const v = createValidator(toolArgsSchema);
  v.feed('{"action":"nope"}');
  const violation = v.getViolation();
  assert.ok(violation);
  const req = buildCorrectionRequest(violation);
  assert.deepEqual(Object.keys(req).sort(), ['type', 'violation']);
  assert.deepEqual(Object.keys(req.violation).sort(), ['message', 'path']);
  assert.equal(req.violation.message, violation.message);
});

test('an invalid first attempt is retried once with a correction and succeeds', async () => {
  let calls = 0;
  const seenCorrections = [];
  const res = await runGuardedStream({
    schema: toolArgsSchema,
    createStream: async ({ correction }) => {
      calls += 1;
      seenCorrections.push(correction);
      if (!correction) return asyncGen([JSON.stringify({ action: 'destroy', target: 'f' })]); // unknown enum value
      return asyncGen([JSON.stringify({ action: 'read', target: 'f' })]);
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(res.corrected, true);
  assert.equal(calls, 2);
  assert.equal(seenCorrections[0], null);
  assert.ok(seenCorrections[1]);
  assert.equal(seenCorrections[1].type, 'schema_violation_correction');
});

test('a correction that fails again throws explicitly and never retries a third time (cost bound)', async () => {
  let calls = 0;
  await assert.rejects(
    runGuardedStream({
      schema: toolArgsSchema,
      createStream: async () => { calls += 1; return asyncGen([JSON.stringify({ action: 'destroy', target: 'f' })]); },
    }),
    (err) => {
      assert.ok(err instanceof CorrectionFailedError);
      assert.ok(err.violation);
      return true;
    },
  );
  assert.equal(calls, 2, 'the producer must be called at most twice: one attempt, one bounded correction');
});

test('abort mid-first-attempt stops the stream and never starts a correction attempt', async () => {
  const ac = new AbortController();
  let calls = 0;
  await assert.rejects(
    runGuardedStream({
      schema: toolArgsSchema,
      signal: ac.signal,
      createStream: async () => {
        calls += 1;
        return (async function* gen() {
          yield '{"action":"';
          ac.abort();
          yield 'read","target":"f"}';
        })();
      },
    }),
    (err) => err instanceof GuardAbortError,
  );
  assert.equal(calls, 1);
});

test('an already-aborted signal rejects before the producer is ever called', async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  await assert.rejects(
    runGuardedStream({
      schema: toolArgsSchema,
      signal: ac.signal,
      createStream: async () => { calls += 1; return asyncGen(['{}']); },
    }),
    (err) => err instanceof GuardAbortError,
  );
  assert.equal(calls, 0);
});

test('an incomplete stream (ended early) is a violation, not a silent pass', () => {
  const result = feedChunks(toolArgsSchema, ['{"action":"read","target":"f"']); // no closing brace
  assert.ok(result.violation);
  assert.match(result.violation.message, /Unexpected end of stream/);
});

// ---- number grammar (JSON: no leading zeros) -------------------------------

test('a leading zero followed by more digits is rejected ("01")', () => {
  const schema = { type: 'object', properties: { x: { type: 'number' } } };
  const result = feedChunks(schema, ['{"x":01}']);
  assert.ok(result.violation);
  assert.match(result.violation.message, /Invalid number literal '01'/);
});

test('"-0" is a valid number', () => {
  const schema = { type: 'object', properties: { x: { type: 'number' } } };
  const result = feedChunks(schema, ['{"x":-0}']);
  assert.equal(result.violation, null);
});

test('"0.5" is a valid number', () => {
  const schema = { type: 'object', properties: { x: { type: 'number' } } };
  const result = feedChunks(schema, ['{"x":0.5}']);
  assert.equal(result.violation, null);
});

test('a bare "0" is still valid', () => {
  const schema = { type: 'object', properties: { x: { type: 'number' } } };
  const result = feedChunks(schema, ['{"x":0}']);
  assert.equal(result.violation, null);
});

// ---- depth and size caps ----------------------------------------------------

test('nesting beyond maxDepth is reported as a violation', () => {
  const schema = {}; // no constraint on shape, just depth
  const nested = '{"a":'.repeat(5) + '1' + '}'.repeat(5); // 5 levels of object nesting
  const result = feedChunks(schema, [nested], { maxDepth: 3 });
  assert.ok(result.violation);
  assert.match(result.violation.message, /Nesting exceeds maxDepth 3/);
});

test('nesting within maxDepth is unaffected', () => {
  const schema = {};
  const nested = '{"a":'.repeat(3) + '1' + '}'.repeat(3);
  const result = feedChunks(schema, [nested], { maxDepth: 3 });
  assert.equal(result.violation, null);
});

test('input exceeding maxBytes is reported as a violation', () => {
  const schema = { type: 'string' };
  const doc = JSON.stringify('x'.repeat(100));
  const result = feedChunks(schema, [doc], { maxBytes: 20 });
  assert.ok(result.violation);
  assert.match(result.violation.message, /exceeds maxBytes 20/);
});

test('input within maxBytes is unaffected, split across many small chunks', () => {
  const schema = { type: 'string' };
  const doc = JSON.stringify('short');
  const result = feedChunks(schema, chunkEvery(doc, 2), { maxBytes: 1000 });
  assert.equal(result.violation, null);
});

test('runGuardedStream forwards maxDepth/maxBytes to the validator', async () => {
  const schema = {};
  await assert.rejects(
    runGuardedStream({
      schema,
      maxDepth: 1,
      createStream: async () => asyncGen(['{"a":{"b":1}}']),
    }),
    (err) => {
      assert.ok(err instanceof CorrectionFailedError);
      assert.match(err.violation.message, /Nesting exceeds maxDepth 1/);
      return true;
    },
  );
});
