'use strict';
// #794: $ref inlining has a size budget, so a hostile MCP server cannot hang or
// OOM the web process with a small schema that expands exponentially — and the
// budget changes nothing for a schema that is not hostile.

const assert = require('node:assert/strict');
const test = require('node:test');
process.env.UI_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'cowork-mcp-ref-budget-'));
const mcp = require('./mcp.cjs');
const { convertTool, MAX_SCHEMA_NODES, MAX_SCHEMA_CHARS } = mcp;

// The inliner exactly as it was before the budget (f01dff0f), kept here as the
// reference the budgeted one must match byte for byte on every real schema.
function referenceInline(node, defs, stack, depth) {
  if (depth > 64) throw new Error('schema nests deeper than we will walk');
  if (stack.length > 8) throw new Error('refs expand deeper than we will inline');
  if (Array.isArray(node)) return node.map((n) => referenceInline(n, defs, stack, depth + 1));
  if (!node || typeof node !== 'object') return node;
  const ref = node.$ref;
  if (typeof ref === 'string') {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    if (!m) throw new Error(`cannot resolve non-local ref ${ref}`);
    const key = m[2];
    if (stack.includes(key)) throw new Error(`circular ref ${ref}`);
    const target = defs[key];
    if (!target) throw new Error(`ref ${ref} points at a definition that is not present`);
    const { $ref: _drop, ...siblings } = node;
    return { ...referenceInline(target, defs, [...stack, key], depth + 1), ...siblings };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$defs' || k === 'definitions') continue;
    out[k] = referenceInline(v, defs, stack, depth + 1);
  }
  return out;
}
function referenceResolve(schema) {
  return referenceInline(schema, { ...(schema.$defs || {}), ...(schema.definitions || {}) }, [], 0);
}

// Synthetic, shaped like the calendar tools that carry $defs on the reference
// Nextcloud MCP server: anyOf with null, arrays of refs, refs with sibling
// descriptions, a ref to a ref, legacy `definitions`, enums and defaults.
const CALENDAR_LIKE = {
  name: 'nc_calendar_create_event',
  description: 'Create a calendar event.',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_name: { type: 'string', description: 'Calendar to add the event to.' },
      title: { type: 'string' },
      start: { type: 'string', format: 'date-time' },
      end: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], default: null },
      all_day: { type: 'boolean', default: false },
      reminders: {
        anyOf: [{ type: 'array', items: { $ref: '#/$defs/Reminder' } }, { type: 'null' }],
        default: null, description: 'Alarms before the event.',
      },
      attendees: { type: 'array', items: { $ref: '#/$defs/Attendee', description: 'One invitee.' } },
      recurrence: { $ref: '#/definitions/Recurrence' },
      categories: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    },
    required: ['calendar_name', 'title', 'start'],
    $defs: {
      Reminder: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['DISPLAY', 'EMAIL', 'AUDIO'] },
          minutes_before: { type: 'integer', minimum: 0 },
          trigger: { $ref: '#/$defs/Trigger' },
        },
        required: ['action'],
      },
      Trigger: { type: 'object', properties: { related: { type: 'string', enum: ['START', 'END'] } } },
      Attendee: {
        type: 'object',
        properties: { email: { type: 'string' }, role: { type: 'string', enum: ['REQ-PARTICIPANT', 'OPT-PARTICIPANT'] } },
        required: ['email'],
      },
    },
    definitions: {
      Recurrence: { type: 'object', properties: { freq: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY'] }, count: { type: 'integer' } } },
    },
  },
};

// What the pre-budget code produced for CALENDAR_LIKE, captured once from
// f01dff0f. Pinned as text so a change to key order or shape shows up here.
const CALENDAR_LIKE_PARAMETERS = '{"type":"object","properties":{"calendar_name":{"type":"string","description":"Calendar to add the event to."},"title":{"type":"string"},"start":{"type":"string","format":"date-time"},"end":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null},"all_day":{"type":"boolean","default":false},"reminders":{"anyOf":[{"type":"array","items":{"type":"object","properties":{"action":{"type":"string","enum":["DISPLAY","EMAIL","AUDIO"]},"minutes_before":{"type":"integer","minimum":0},"trigger":{"type":"object","properties":{"related":{"type":"string","enum":["START","END"]}}}},"required":["action"]}},{"type":"null"}],"default":null,"description":"Alarms before the event."},"attendees":{"type":"array","items":{"type":"object","properties":{"email":{"type":"string"},"role":{"type":"string","enum":["REQ-PARTICIPANT","OPT-PARTICIPANT"]}},"required":["email"],"description":"One invitee."}},"recurrence":{"type":"object","properties":{"freq":{"type":"string","enum":["DAILY","WEEKLY","MONTHLY"]},"count":{"type":"integer"}}},"categories":{"type":"array","items":{"type":"string"},"maxItems":20}},"required":["calendar_name","title","start"]}';

function referenceParameters(tool) {
  const resolved = referenceResolve(tool.inputSchema);
  return JSON.stringify({ type: 'object', properties: resolved.properties || {}, required: resolved.required || [] });
}

test('a representative $ref schema converts byte-identically to the pre-budget code', () => {
  const r = convertTool(CALENDAR_LIKE);
  assert.equal(r.ok, true, r.reason);
  const got = JSON.stringify(r.tool.function.parameters);
  assert.equal(got, CALENDAR_LIKE_PARAMETERS);
  assert.equal(got, referenceParameters(CALENDAR_LIKE));
});

test("noevia's own catalogue converts byte-identically to the pre-budget code", () => {
  const internal = require('./mcp-internal.cjs');
  const catalogue = internal.catalogueOf(require('./mcp-internal-tools.cjs').createInternalTools({ getProject: () => null }));
  assert.ok(catalogue.length > 0);
  for (const tool of catalogue) {
    const r = convertTool(tool);
    assert.equal(r.ok, true, `${tool.name}: ${r.reason}`);
    assert.equal(JSON.stringify(r.tool.function.parameters), referenceParameters(tool), tool.name);
  }
});

// D1…D7 each hold ten properties that all point at the next definition; D8 is a
// leaf. About 2 KB of JSON, within MAX_REF_DEPTH, and 10^8 leaves once inlined.
function exponentialTool(width = 10, levels = 8) {
  const $defs = {};
  for (let k = 1; k < levels; k++) {
    const properties = {};
    for (let i = 0; i < width; i++) properties[`p${i}`] = { $ref: `#/$defs/D${k + 1}` };
    $defs[`D${k}`] = { type: 'object', properties };
  }
  $defs[`D${levels}`] = { type: 'string' };
  const properties = {};
  for (let i = 0; i < width; i++) properties[`p${i}`] = { $ref: '#/$defs/D1' };
  return { name: 'bomb', description: 'x', inputSchema: { type: 'object', properties, $defs } };
}

test('an exponential $ref schema is dropped in well under 50 ms instead of hanging', () => {
  const tool = exponentialTool();
  assert.ok(JSON.stringify(tool).length < 4096, 'the attack is a small input');
  const started = process.hrtime.bigint();
  const r = convertTool(tool);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(r.ok, false);
  assert.match(r.reason, /unresolvable schema: schema expands past \d+ nodes/);
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
});

test('a ref fanned out into huge strings is dropped on the character budget', () => {
  // Few nodes, but one long description repeated through refs would emit
  // megabytes of tool schema to the model on every request.
  const long = 'x'.repeat(40 * 1024);
  const properties = {};
  for (let i = 0; i < 20; i++) properties[`p${i}`] = { $ref: '#/$defs/Big' };
  const r = convertTool({ name: 'wide', inputSchema: { type: 'object', properties, $defs: { Big: { type: 'string', description: long } } } });
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`past ${MAX_SCHEMA_CHARS} characters`));
});

test('sibling text beside a ref counts against the character budget', () => {
  const long = 'y'.repeat(40 * 1024);
  const properties = {};
  for (let i = 0; i < 20; i++) properties[`p${i}`] = { $ref: '#/$defs/T', description: long };
  const r = convertTool({ name: 'sibs', inputSchema: { type: 'object', properties, $defs: { T: { type: 'string' } } } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /characters/);
});

test('the budget is per tool: a dropped tool does not poison the next conversion', () => {
  assert.equal(convertTool(exponentialTool()).ok, false);
  const r = convertTool(CALENDAR_LIKE);
  assert.equal(r.ok, true, r.reason);
  assert.equal(JSON.stringify(r.tool.function.parameters), CALENDAR_LIKE_PARAMETERS);
});

test('a large but legitimate schema still fits the budget', () => {
  // A few hundred properties with enums and descriptions, each through a ref:
  // bigger than any tool on the reference server, still converted.
  const properties = {};
  for (let i = 0; i < 300; i++) properties[`field_${i}`] = { $ref: '#/$defs/Choice', description: `Field number ${i}.` };
  const tool = { name: 'wide_form', inputSchema: { type: 'object', properties, $defs: { Choice: { type: 'string', enum: ['a', 'b', 'c', 'd'] } } } };
  const r = convertTool(tool);
  assert.equal(r.ok, true, r.reason);
  assert.equal(JSON.stringify(r.tool.function.parameters), referenceParameters(tool));
  assert.ok(MAX_SCHEMA_NODES >= 20000);
});

test('discovery drops the exponential tool, logs it, and keeps the other tools', async () => {
  const { createMcpWiring } = require('./mcp-wiring.cjs');
  const warnings = [];
  const fake = {
    connect: async () => ({ session: { id: null } }),
    listTools: async () => [exponentialTool(), CALENDAR_LIKE],
    disconnect: async () => true,
    convertTool: mcp.convertTool,
    readOnlyHint: () => null,
  };
  const wiring = createMcpWiring({
    servers: [{ id: 'hostile', url: 'http://127.0.0.1:9/mcp', auth: 'none' }], mcp: fake,
    bindBoxes: () => [], directoryMcp: { asServers: () => [] }, mcpOAuth: {},
    directoryUrlAllowed: async () => true, credentialOriginAllowed: () => false,
    scope: { getStore: () => null }, storageFor: () => ({}), isWriteTool: () => false,
    internal: {}, internalKey: 'k', reduceToolResult: (t) => ({ text: t, reduced: false }),
    logger: { log() {}, warn: (line) => warnings.push(line) },
  });
  const started = Date.now();
  const tools = await wiring.discoverOneServer({ id: 'hostile', url: 'http://127.0.0.1:9/mcp', auth: 'none' });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual([...tools.keys()], ['nc_calendar_create_event']);
  assert.ok(warnings.some((w) => /\[mcp:hostile\] dropped 1 unconvertible tools: bomb: unresolvable schema: schema expands past/.test(w)), warnings.join('\n'));
});
