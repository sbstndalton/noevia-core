#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for low- and high-context profiles (#1079). The same file is
// committed byte-for-byte in sbstndalton/noevia-rs (crates/long-profile/tests/fixtures/
// long-profile.v1.json); noevia-core CI compares them.
//   node tools/gen-long-profile-fixtures.cjs > tests/fixtures/long-profile.v1.json
//
// `expect` comes from refRun below: an independent reference written from the crate's
// specification (crates/long-profile/src/lib.rs docs). It is a test oracle only; noevia-core runs
// the Rust decisions (dav-parse.wasm long_profile) and never this. Model ids and paths are made up.
//
// Sections:
//   cases:  { name, input, expect }   long_profile(JSON.stringify(input)) must reply `expect`
//   errors: { name, text, pad, expect: { error } }   text + `pad` spaces must be refused

const LIMITS = { maxInputBytes: 3 * 1024 * 1024, maxFileBytes: 1024 * 1024, maxIdBytes: 200, maxRowIdBytes: 512, maxPathBytes: 4096, maxRows: 512 };
const SUFFIX = '-long';
const bytes = s => Buffer.byteLength(s, 'utf8');
const validId = id => typeof id === 'string' && id.length > 0 && bytes(id) <= LIMITS.maxIdBytes && /^[A-Za-z0-9_./:-]+$/.test(id);
const baseOf = id => {
  if (!validId(id) || !id.endsWith(SUFFIX)) return null;
  const base = id.slice(0, -SUFFIX.length);
  return base && !base.endsWith(SUFFIX) ? base : null;
};

function refPairs(rows) {
  const fileOf = id => { const r = rows.find(x => x.id === id); return r && typeof r.model === 'string' && r.model ? r.model : null; };
  const out = [];
  for (const row of rows) {
    const base = baseOf(row.id);
    if (!base) continue;
    const mine = fileOf(row.id), theirs = fileOf(base);
    if (mine && theirs && mine === theirs) out.push({ base, long: row.id });
  }
  // Bases are ASCII (preset names), so code unit order is byte order.
  return out.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
}

// preset-reload's grammar (crates/preset-reload), written out again: lines split on \r\n, \n or a
// lone \r; space/tab trimmed; a header must start the line, be [name] with nothing after but a
// ;/# comment, and its name may not be padded, hold whitespace, a control character or ':', nor be
// "default"; a duplicate name is ambiguous; any other line must start with a letter, _, ; or #.
const splitLines = text => text.split('\n').flatMap(l => (l.endsWith('\r') ? l.slice(0, -1) : l).split('\r'));
const trimWs = s => s.replace(/^[ \t]+|[ \t]+$/g, '');
function headerName(line) {
  const m = /^\[([^\]]*)\]([\s\S]*)$/.exec(line);
  if (!m) return null;
  const rest = m[2].replace(/^[ \t]+/, '');
  if (!(rest === '' || rest.startsWith(';') || rest.startsWith('#'))) return null;
  const name = m[1];
  if (!name || name !== trimWs(name) || /[\p{White_Space}\p{Cc}]/u.test(name) || name.includes(':') || name === 'default') return null;
  return name;
}
function refSections(text) {
  const out = [];
  for (const raw of splitLines(text)) {
    const line = trimWs(raw);
    if (!line) continue;
    if (line.startsWith('[')) {
      if (!raw.startsWith('[')) return null;
      const name = headerName(line);
      if (name === null || out.some(s => s.name === name)) return null;
      out.push({ name, body: [] });
      continue;
    }
    if (!/^[A-Za-z_;#]/.test(line)) return null;
    if (out.length) out.at(-1).body.push(line);
  }
  return out;
}
const DROP_ALWAYS = ['load-on-startup', 'alias', 'a', 'LLAMA_ARG_ALIAS'];
const MODEL_KEYS = ['model', 'm', 'LLAMA_ARG_MODEL'];
const MMPROJ_KEYS = ['mmproj', 'mm', 'LLAMA_ARG_MMPROJ'];
const MODEL_SOURCE_KEYS = ['hf-repo', 'hf', 'hfr', 'hf-file', 'hff', 'LLAMA_ARG_HF_REPO', 'LLAMA_ARG_HF_FILE', 'model-url', 'mu', 'LLAMA_ARG_MODEL_URL', 'docker-repo', 'dr', 'LLAMA_ARG_DOCKER_REPO'];
const MMPROJ_SOURCE_KEYS = ['mmproj-url', 'mmu', 'LLAMA_ARG_MMPROJ_URL'];
const keyOf = line => (line.startsWith(';') || line.startsWith('#') ? null : trimWs(line.split('=')[0]).replace(/^-+/, ''));
const goodPath = p => p.length > 0 && bytes(p) <= LIMITS.maxPathBytes && p === p.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') && !/\p{Cc}/u.test(p);

function refSection({ text, base, model, mmproj }) {
  const id = base + SUFFIX;
  const no = reason => ({ ok: false, reason });
  if (!validId(base) || !validId(id)) return no('invalid_id');
  if (base.endsWith(SUFFIX)) return no('is_long');
  const all = refSections(text);
  if (!all) return no('ambiguous');
  const section = all.find(s => s.name === base);
  if (!section) return no('no_base');
  if (all.some(s => s.name === id)) return no('exists');
  const has = keys => section.body.some(l => keys.includes(keyOf(l)));
  model = model || null; mmproj = mmproj || null;
  let addModel = null;
  if (!has(MODEL_KEYS)) { if (!model) return no('no_model'); addModel = model; }
  const addMmproj = has(MMPROJ_KEYS) ? null : mmproj;
  if ((addModel && !goodPath(addModel)) || (addMmproj && !goodPath(addMmproj))) return no('bad_path');
  const copied = section.body.filter(l => {
    const k = keyOf(l);
    return k === null || !(DROP_ALWAYS.includes(k) || (addModel && MODEL_SOURCE_KEYS.includes(k)) || (addMmproj && MMPROJ_SOURCE_KEYS.includes(k)));
  });
  if (addModel) copied.push('model = ' + addModel);
  if (addMmproj) copied.push('mmproj = ' + addMmproj);
  let out = text;
  if (!(text === '' || text.endsWith('\n') || text.endsWith('\r'))) out += '\n';
  if (text !== '') out += '\n';
  out += '[' + id + ']\n' + copied.map(l => l + '\n').join('');
  if (bytes(out) > LIMITS.maxFileBytes) return no('too_large');
  return { ok: true, id, text: out };
}

function refPick({ model, profile, pairs }) {
  const asLong = pairs.find(p => p.long === model), asBase = pairs.find(p => p.base === model);
  if (profile === 'low') return { model: asLong ? asLong.base : model, long: false, reason: 'low' };
  if (asBase) return { model: asBase.long, long: true, reason: 'high' };
  if (asLong) return { model, long: true, reason: 'is_long' };
  return { model, long: false, reason: 'no_long' };
}

function refRun(input) {
  if (input.op === 'pairs') return { pairs: refPairs(input.rows) };
  if (input.op === 'section') return refSection(input);
  return refPick(input);
}

const row = (id, model = null) => ({ id, model });
const INI = 'version = 1\n\n[*]\ncache-ram = 1024\nctx-size = 8192\n\n'
  + '[Synthetic-12B-it]\nmodel = /models/synthetic-12b-it-Q4_K_M.gguf\nmmproj = /models/mmproj-synthetic-12b-f16.gguf\nctx-size = 16384\ncache-type-k = bf16\ncache-type-v = bf16\nload-on-startup = true\n; tuned by auto-tune\nubatch-size = 1024\n\n'
  + '[synthetic-e4b]\nctx-size = 8192\nhf-repo = synthetic/e4b-GGUF\nalias = e4b\n\n'
  + '[Synthetic-9B]\nm = /models/synthetic-9b.gguf\nLLAMA_ARG_MMPROJ = /models/synthetic-9b-mmproj.gguf\nmmproj-url = https://example.invalid/p.gguf\nctx-size = 32768\n';

function cases() {
  const out = [];
  const add = (name, input) => out.push({ name, input, expect: refRun(input) });
  // ── pairs ──
  const F = '/models/synthetic-12b-it-Q4_K_M.gguf', G = '/models/synthetic-9b.gguf';
  add('pairs-empty', { op: 'pairs', rows: [] });
  add('pairs-one', { op: 'pairs', rows: [row('Synthetic-12B-it', F), row('Synthetic-12B-it-long', F)] });
  add('pairs-long-first', { op: 'pairs', rows: [row('Synthetic-12B-it-long', F), row('Synthetic-12B-it', F)] });
  add('pairs-other-file', { op: 'pairs', rows: [row('Synthetic-12B-it', F), row('Synthetic-12B-it-long', G)] });
  add('pairs-no-base', { op: 'pairs', rows: [row('Synthetic-12B-it-long', F)] });
  add('pairs-base-no-file', { op: 'pairs', rows: [row('Synthetic-12B-it', null), row('Synthetic-12B-it-long', F)] });
  add('pairs-long-no-file', { op: 'pairs', rows: [row('Synthetic-12B-it', F), row('Synthetic-12B-it-long', null)] });
  add('pairs-both-no-file', { op: 'pairs', rows: [row('a', null), row('a-long', null)] });
  add('pairs-both-empty-file', { op: 'pairs', rows: [row('a', ''), row('a-long', '')] });
  add('pairs-chain', { op: 'pairs', rows: [row('a', F), row('a-long', F), row('a-long-long', F)] });
  add('pairs-suffix-only', { op: 'pairs', rows: [row('-long', F), row('x', F)] });
  add('pairs-case', { op: 'pairs', rows: [row('a', F), row('a-LONG', F), row('A-long', F)] });
  add('pairs-invalid-long-id', { op: 'pairs', rows: [row('a b', F), row('a b-long', F)] });
  add('pairs-unicode-id', { op: 'pairs', rows: [row('mödel', F), row('mödel-long', F)] });
  add('pairs-colon', { op: 'pairs', rows: [row('user.synthetic:Q4', F), row('user.synthetic:Q4-long', F)] });
  add('pairs-long-id-too-long', { op: 'pairs', rows: [row('m'.repeat(196), F), row('m'.repeat(196) + '-long', F)] });
  add('pairs-long-id-at-limit', { op: 'pairs', rows: [row('m'.repeat(195), F), row('m'.repeat(195) + '-long', F)] });
  add('pairs-path-differs-by-slash', { op: 'pairs', rows: [row('a', '/models/a.gguf'), row('a-long', '/models//a.gguf')] });
  add('pairs-sorted', { op: 'pairs', rows: [row('zeta', G), row('zeta-long', G), row('Alpha', F), row('Alpha-long', F), row('alpha', F), row('alpha-long', F), row('_x', F), row('_x-long', F), row('9b', G), row('9b-long', G)] });
  add('pairs-many', { op: 'pairs', rows: Array.from({ length: 512 }, (_, i) => row('m' + String(Math.floor(i / 2)).padStart(3, '0') + (i % 2 ? '-long' : ''), i % 7 === 3 ? null : '/models/f' + Math.floor(i / 2) + '.gguf')) });
  add('pairs-unrelated-long-name', { op: 'pairs', rows: [row('Synthetic-long', '/models/synthetic-long-ctx.gguf'), row('Synthetic', '/models/synthetic.gguf')] });
  // ── section ──
  const S = (text, base, model = null, mmproj = null) => ({ op: 'section', text, base, model, mmproj });
  add('section-copy', S(INI, 'Synthetic-12B-it', F, '/models/mmproj-synthetic-12b-f16.gguf'));
  add('section-copy-no-router-files', S(INI, 'Synthetic-12B-it'));
  add('section-adds-router-file', S(INI, 'synthetic-e4b', '/cache/synthetic/e4b-Q4.gguf'));
  add('section-adds-router-file-and-projector', S(INI, 'synthetic-e4b', '/cache/synthetic/e4b-Q4.gguf', '/cache/synthetic/e4b-mmproj.gguf'));
  add('section-short-and-env-keys', S(INI, 'Synthetic-9B', G, '/models/other-mmproj.gguf'));
  add('section-no-model', S(INI, 'synthetic-e4b'));
  add('section-no-model-empty', S(INI, 'synthetic-e4b', ''));
  add('section-bad-path-padded', S(INI, 'synthetic-e4b', ' /models/x.gguf'));
  add('section-bad-path-trailing', S(INI, 'synthetic-e4b', '/models/x.gguf '));
  add('section-bad-path-newline', S(INI, 'synthetic-e4b', '/models/x\n.gguf'));
  add('section-bad-path-control', S(INI, 'synthetic-e4b', '/models/x\u0007.gguf'));
  add('section-bad-path-nbsp', S(INI, 'synthetic-e4b', '/models/x.gguf '));
  add('section-bad-projector', S(INI, 'synthetic-e4b', '/models/x.gguf', '\t/p.gguf'));
  add('section-projector-ignored-when-own', S(INI, 'Synthetic-12B-it', null, ' bad but unused'));
  add('section-model-ignored-when-own', S(INI, 'Synthetic-12B-it', ' bad but unused'));
  add('section-path-at-limit', S(INI, 'synthetic-e4b', '/' + 'p'.repeat(4095)));
  add('section-unicode-path', S(INI, 'synthetic-e4b', '/models/mödel 12b.gguf'));
  add('section-no-base', S(INI, 'Missing-model', F));
  add('section-exists', S(INI + '\n[Synthetic-9B-long]\nctx-size = 65536\n', 'Synthetic-9B', G));
  add('section-is-long', S(INI, 'Synthetic-12B-it-long', F));
  add('section-invalid-space', S(INI, 'bad name', F));
  add('section-invalid-unicode', S(INI, 'mödel', F));
  add('section-invalid-star', S(INI, '*', F));
  add('section-id-at-limit', S('[' + 'm'.repeat(195) + ']\nmodel = /f\n', 'm'.repeat(195)));
  add('section-id-over-limit', S('[' + 'm'.repeat(196) + ']\nmodel = /f\n', 'm'.repeat(196)));
  add('section-colon-base', S('[user.synthetic:Q4]\nmodel = /f\n', 'user.synthetic:Q4'));
  add('section-colon-base-missing', S('[a]\nmodel = /f\n', 'user.synthetic:Q4', '/f'));
  add('section-duplicate', S('[a]\nmodel = /f\n\n[a]\nctx-size = 1\n', 'a'));
  add('section-indented-header', S('[a]\nmodel = /f\n  [b]\n', 'a'));
  add('section-default-header', S('[default]\nx = 1\n[a]\nmodel = /f\n', 'a'));
  add('section-padded-header', S('[ a ]\nmodel = /f\n', 'a'));
  add('section-header-trailing-text', S('[a] x\nmodel = /f\n', 'a'));
  add('section-header-comment', S('[a] ; the model\nmodel = /f\n', 'a'));
  add('section-header-unclosed', S('[a\nmodel = /f\n', 'a'));
  add('section-bom-line', S('﻿version = 1\n[a]\nmodel = /f\n', 'a'));
  add('section-number-line', S('[a]\nmodel = /f\n1 = 2\n', 'a'));
  add('section-crlf', S('version = 1\r\n[a]\r\nmodel = /f\r\nctx-size = 4096\r\n', 'a'));
  add('section-lone-cr', S('[a]\rmodel = /f\rctx-size = 4096', 'a'));
  add('section-no-final-newline', S('[a]\nmodel = /f\nctx-size = 4096', 'a'));
  add('section-many-final-newlines', S('[a]\nmodel = /f\n\n\n\n', 'a'));
  add('section-empty-text', S('', 'a', '/f'));
  add('section-preamble-only', S('version = 1\n', 'a', '/f'));
  add('section-empty-base-section', S('[a]\n', 'a', '/f'));
  add('section-empty-base-section-no-model', S('[a]\n[b]\nmodel = /g\n', 'a'));
  add('section-middle-section', S('[a]\nmodel = /f\n[b]\nmodel = /g\nctx-size = 1\n[c]\nmodel = /h\n', 'b'));
  add('section-indented-keys', S('[a]\n   model = /f\n\tctx-size = 4096   \n', 'a'));
  add('section-comments-kept', S('[a]\n# about this model\nmodel = /f\n; and more\n', 'a'));
  add('section-drop-keys', S('[a]\nmodel = /f\nload-on-startup = true\nalias = x\na = y\nalias=z\nLLAMA_ARG_ALIAS = w\nalias\nload-on-startup\naliases = keep\nload-on-startup-x = keep\n', 'a'));
  // llama.cpp's preset grammar has no leading dashes: preset-reload, and so this, read the file as ambiguous.
  add('section-dash-key', S('[a]\nmodel = /f\n--ctx-size = 4096\n', 'a'));
  add('section-hf-kept-with-own-model', S('[a]\nmodel = /f\nhf-repo = synthetic/a\n', 'a', '/g'));
  add('section-hf-dropped', S('[a]\nhf-repo = synthetic/a\nhf-file = a.gguf\nhf = x\nhfr = y\nhff = z\nmodel-url = https://example.invalid/a\nmu = u\ndocker-repo = d\ndr = r\nLLAMA_ARG_HF_REPO = s\nLLAMA_ARG_HF_FILE = t\nLLAMA_ARG_MODEL_URL = v\nLLAMA_ARG_DOCKER_REPO = w\nhf-token = keep\n', 'a', '/cache/a.gguf'));
  add('section-mmproj-url-kept-without-router-projector', S('[a]\nmodel = /f\nmmproj-url = https://example.invalid/p\n', 'a'));
  add('section-mmproj-url-dropped', S('[a]\nmodel = /f\nmmproj-url = https://example.invalid/p\nmmu = q\nLLAMA_ARG_MMPROJ_URL = r\n', 'a', null, '/cache/p.gguf'));
  add('section-model-key-short', S('[a]\nm = /f\n', 'a', '/g'));
  add('section-model-key-env', S('[a]\nLLAMA_ARG_MODEL = /f\n', 'a', '/g'));
  add('section-model-key-not-prefix', S('[a]\nmodel-draft = /d\n', 'a', '/g'));
  add('section-mm-key', S('[a]\nmodel = /f\nmm = /p\n', 'a', null, '/q'));
  add('section-key-without-value', S('[a]\nmodel = /f\njinja\nflash-attn = on\n', 'a'));
  add('section-equals-in-value', S('[a]\nmodel = /f\nchat-template-kwargs = {"a":"b=c"}\n', 'a'));
  add('section-global-untouched', S('[*]\nctx-size = 4096\n[a]\nmodel = /f\n', 'a'));
  // Size limits (the reply at exactly 1 MiB, one byte over, a text over 1 MiB) are computed in the
  // tests on both sides (long-profile-differential.test.cjs, the crate's unit tests), not stored here.
  // ── pick ──
  const P = [{ base: 'Synthetic-12B-it', long: 'Synthetic-12B-it-long' }, { base: 'synthetic-e4b', long: 'synthetic-e4b-long' }];
  const K = (model, profile, pairs = P) => ({ op: 'pick', model, profile, pairs });
  add('pick-high-base', K('Synthetic-12B-it', 'high'));
  add('pick-high-second', K('synthetic-e4b', 'high'));
  add('pick-high-long', K('Synthetic-12B-it-long', 'high'));
  add('pick-high-none', K('Synthetic-9B', 'high'));
  add('pick-high-no-pairs', K('Synthetic-12B-it', 'high', []));
  add('pick-low-base', K('Synthetic-12B-it', 'low'));
  add('pick-low-long', K('Synthetic-12B-it-long', 'low'));
  add('pick-low-none', K('Synthetic-9B', 'low'));
  add('pick-high-cloud-id', K('gpt-synthetic/turbo mini', 'high'));
  add('pick-high-case', K('synthetic-12b-it', 'high'));
  add('pick-low-unpaired-long-name', K('Other-long', 'low'));
  add('pick-high-max-pairs', K('m255', 'high', Array.from({ length: 512 }, (_, i) => ({ base: 'm' + i, long: 'm' + i + '-long' }))));
  return out;
}

const okPairs = '"op":"pairs","rows":[]';
const okSection = '"op":"section","text":"[a]\\nmodel = /f\\n","base":"a","model":null,"mmproj":null';
const okPick = '"op":"pick","model":"a","profile":"high","pairs":[]';
const errors = [
  { name: 'not-json', text: '{' },
  { name: 'array', text: '[]' },
  { name: 'no-op', text: '{"rows":[]}' },
  { name: 'unknown-op', text: '{"op":"other"}' },
  { name: 'op-number', text: '{"op":1}' },
  { name: 'pairs-extra-key', text: `{${okPairs},"x":1}` },
  { name: 'pairs-missing-rows', text: '{"op":"pairs"}' },
  { name: 'pairs-rows-object', text: '{"op":"pairs","rows":{}}' },
  { name: 'pairs-row-extra', text: '{"op":"pairs","rows":[{"id":"a","model":null,"x":1}]}' },
  { name: 'pairs-row-no-model', text: '{"op":"pairs","rows":[{"id":"a"}]}' },
  { name: 'pairs-row-id-empty', text: '{"op":"pairs","rows":[{"id":"","model":null}]}' },
  { name: 'pairs-row-id-number', text: '{"op":"pairs","rows":[{"id":5,"model":null}]}' },
  { name: 'pairs-row-id-too-long', text: `{"op":"pairs","rows":[{"id":"${'i'.repeat(513)}","model":null}]}` },
  { name: 'pairs-row-model-number', text: '{"op":"pairs","rows":[{"id":"a","model":3}]}' },
  { name: 'pairs-row-model-too-long', text: `{"op":"pairs","rows":[{"id":"a","model":"${'p'.repeat(4097)}"}]}` },
  { name: 'pairs-duplicate-id', text: '{"op":"pairs","rows":[{"id":"a","model":"/f"},{"id":"a","model":"/g"}]}' },
  { name: 'pairs-too-many', text: `{"op":"pairs","rows":[${Array.from({ length: 513 }, (_, i) => `{"id":"m${i}","model":null}`).join(',')}]}` },
  { name: 'section-extra-key', text: `{${okSection},"x":1}` },
  { name: 'section-missing-mmproj', text: '{"op":"section","text":"","base":"a","model":null}' },
  { name: 'section-text-null', text: `{${okSection.replace('"text":"[a]\\nmodel = /f\\n"', '"text":null')}}` },
  { name: 'section-base-empty', text: `{${okSection.replace('"base":"a"', '"base":""')}}` },
  { name: 'section-base-number', text: `{${okSection.replace('"base":"a"', '"base":1')}}` },
  { name: 'section-base-too-long', text: `{${okSection.replace('"base":"a"', `"base":"${'b'.repeat(513)}"`)}}` },
  { name: 'section-model-number', text: `{${okSection.replace('"model":null', '"model":1')}}` },
  { name: 'section-model-too-long', text: `{${okSection.replace('"model":null', `"model":"${'p'.repeat(4097)}"`)}}` },
  { name: 'section-mmproj-array', text: `{${okSection.replace('"mmproj":null', '"mmproj":[]')}}` },
  { name: 'pick-extra-key', text: `{${okPick},"x":1}` },
  { name: 'pick-profile-medium', text: `{${okPick.replace('"high"', '"medium"')}}` },
  { name: 'pick-profile-null', text: `{${okPick.replace('"high"', 'null')}}` },
  { name: 'pick-model-empty', text: `{${okPick.replace('"model":"a"', '"model":""')}}` },
  { name: 'pick-model-too-long', text: `{${okPick.replace('"model":"a"', `"model":"${'m'.repeat(513)}"`)}}` },
  { name: 'pick-pairs-object', text: `{${okPick.replace('"pairs":[]', '"pairs":{}')}}` },
  { name: 'pick-pair-extra', text: `{${okPick.replace('"pairs":[]', '"pairs":[{"base":"a","long":"a-long","x":1}]')}}` },
  { name: 'pick-pair-mismatch', text: `{${okPick.replace('"pairs":[]', '"pairs":[{"base":"a","long":"b-long"}]')}}` },
  { name: 'pick-pair-no-suffix', text: `{${okPick.replace('"pairs":[]', '"pairs":[{"base":"a","long":"a"}]')}}` },
  { name: 'pick-pair-chain', text: `{${okPick.replace('"pairs":[]', '"pairs":[{"base":"a-long","long":"a-long-long"}]')}}` },
  { name: 'pick-pair-invalid-id', text: `{${okPick.replace('"pairs":[]', '"pairs":[{"base":"a b","long":"a b-long"}]')}}` },
  { name: 'pick-pair-duplicate-base', text: `{${okPick.replace('"pairs":[]', '"pairs":[{"base":"a","long":"a-long"},{"base":"a","long":"a-long"}]')}}` },
  { name: 'pick-too-many-pairs', text: `{${okPick.replace('"pairs":[]', `"pairs":[${Array.from({ length: 513 }, (_, i) => `{"base":"m${i}","long":"m${i}-long"}`).join(',')}]`)}}` },
].map(e => ({ ...e, pad: 0, expect: { error: 'input' } }));
errors.push({ name: 'input-too-long', text: `{${okPick}}`, pad: LIMITS.maxInputBytes, expect: { error: 'too_large' } });

if (require.main === module) {
  process.stdout.write(JSON.stringify({ version: 1, limits: LIMITS, cases: cases(), errors }, null, 1) + '\n');
}
module.exports = { refRun, refPairs, refSection, refPick, LIMITS };
