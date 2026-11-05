'use strict';
// Differential cases for the native machines registry's JSON-text coercion (String(JSON.parse(text))
// and the reference registry's add({name})). `node server/machines-coerce-cases.cjs > fixture.json`
// regenerates noevia-rs bins/noevia-server/tests/fixtures/machines-coerce-node.json from the Node
// oracle (synthetic data only). Large inputs are templates, expanded identically by the Rust test:
//   {nest:[n, leafRaw]}  n nested arrays around leafRaw
//   {comma:n}            n levels of ["p", child, "q"] around "x"
//   {wide:n}             [0,0,...] with n elements
//   {inObject:n}         ["a",{"k": n nested arrays around 1}]
const { createInferenceMachines } = require('../tests/reference/inference-machines.node.cjs');

const nest = (n, leaf) => '['.repeat(n) + leaf + ']'.repeat(n);
function expand(t) {
  if (typeof t === 'string') return t;
  if (t.nest) return nest(t.nest[0], t.nest[1]);
  if (t.comma) { let s = '"x"'; for (let i = 0; i < t.comma; i++) s = `["p",${s},"q"]`; return s; }
  if (t.inObject) return `["a",{"k":${nest(t.inObject, '1')}}]`;
  if (t.wide) return `[${Array(t.wide).fill('0').join(',')}]`;
  throw new Error('unknown template');
}

// V8's String() recursion limit is stack dependent (a bare Node 22.23.3 process: 2622 nested arrays
// pass, 2623 throw RangeError; inside a request handler a few frames fewer). Cases stay well clear
// of that boundary: <= 2500 must pass, >= 5000 must throw.
function templates() {
  const raw = [
    '{"toString":1}', '[{"toString":null}]', '{"toStrin\\u0067":"x"}', '["a",["b",{"toString":1}]]',
    '{"valueOf":1}', '{"toString":1,"toString":2}', '{}', '{"a":{"toString":1}}', '[1,[2,[null,{"x":{"toString":1}}]]]',
    'null', '[null,[],[null]]', '"x"', '12', 'true', '1e400', '-1e400', '-0', '1e21', '0.000001', '1e-7',
    '[1e400,"a"]', '[true,false,1.5]', '["\\ud83d\\ude00"]', '[[{"toString":1}]]',
  ];
  const out = raw.map(r => r);
  for (const n of [1, 31, 32, 33, 34, 100, 1000, 2000, 2500, 5000, 100000, 400000]) {
    out.push({ nest: [n, '"x"'] }, { nest: [n, 'null'] }, { nest: [n, ''] });
  }
  for (const n of [1, 31, 33, 100, 5000, 100000]) {
    out.push({ nest: [n, '{"toString":1}'] }, { nest: [n, '{}'] }, { nest: [n, '{"toString":{"toString":1}}'] });
  }
  for (const n of [3, 40, 100, 2000]) out.push({ comma: n });
  out.push({ wide: 100000 });
  // An object between arrays stops String()'s recursion: deep arrays inside it are never walked.
  out.push({ nest: [5, '{"k":"y"}'] }, { inObject: 100000 }, { inObject: 3 });
  return out;
}

// JSON.parse grammar: accept/refuse per text (the native parser reads these documents itself).
const GRAMMAR = [
  '0', '-0', '1.5e+3', '1E5', '"a"', '[]', '{}', '[1,2]', '{"a":1}', ' [ 1 , 2 ] ', '\t\n\r[]', '"\\u00e9"', '"\\ud83d\\ude00"',
  '"\\ud800"', '"\\udc00\\ud800"', '"\\/"', '1e400', '-1e400', '{"a":1,"a":2}', '{"__proto__":1}', '[[[[]]]]', '"\u2028"', '"\ue000"',
  '', ' ', '01', '1.', '.5', '-', '+1', '1e', '1e+', '0x10', 'NaN', 'Infinity', '-Infinity', 'undefined', 'nul', 'nulll', 'tru',
  '[1,]', '[,1]', '{"a":1,}', '{,}', '{"a"}', '{"a":}', '{a:1}', "{'a':1}", '"a', 'a"', '"\\x"', '"\\u12"', '"\\u12g4"',
  '"\n"', '"\t"', '[1 2]', '{"a":1 "b":2}', '[]]', '[[]', '{}}', '// c\n1', '/* */1', '\ufeff1', '\u00a01', '\u000b1', '1 2',
  '"\\"', '[1]x', '-01', '1.5.5', '[1,2', '{"a":1', '{"a":1}}',
].map(text => { let accept = true; try { JSON.parse(text); } catch { accept = false; } return { text, accept }; });

async function addOutcome(parsed) {
  const rows = new Map();
  const store = { get: k => rows.get(k), set: (k, v) => rows.set(k, v) };
  const registry = createInferenceMachines({ store, audit() {}, log() {} });
  try {
    const { machine } = await registry.add({ name: parsed, address: '192.168.1.2' }, 'admin');
    if (rows.size !== 1) throw new Error('expected one write');
    return { ok: machine.name };
  } catch (err) {
    if (err && err.status) return { status: err.status, code: err.code, writes: rows.size };
    return { throws: err && err.constructor && err.constructor.name, writes: rows.size };
  }
}

async function build() {
  const cases = [];
  for (const t of templates()) {
    const text = expand(t);
    let coerce;
    let parsed;
    try {
      parsed = JSON.parse(text);
      const s = String(parsed);
      coerce = s.length > 300 ? { len: s.length, head: s.slice(0, 40), tail: s.slice(-40) } : { text: s };
    } catch (err) { coerce = { throws: err.constructor.name }; }
    const c = { input: typeof t === 'string' ? { raw: t } : t, coerce };
    if (parsed !== undefined || text === 'null') c.add = await addOutcome(parsed);
    cases.push(c);
  }
  return { generatedBy: process.version, grammar: GRAMMAR, cases };
}

module.exports = { build, expand, templates };
if (require.main === module) build().then(f => process.stdout.write(JSON.stringify(f, null, 1) + '\n'));
