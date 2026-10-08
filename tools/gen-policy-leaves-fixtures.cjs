#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for the two pure leaves behind POLICY_LEAVES_IMPL:
// auth-tokens.cjs resolveAuthTokens (#294) and tool-policy.cjs mode()/set() validation. The same
// file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/policy-leaves/tests/fixtures/policy-leaves.v1.json); noevia-core CI compares them.
//   node tools/gen-policy-leaves-fixtures.cjs > tests/fixtures/policy-leaves.v1.json
//
// Every expectation is what the JS itself returns. Tokens are synthetic. Strings are written as
// arrays of UTF-16 code units (so lone surrogates and every space character survive JSON).
//
// Sections:
//   auth:  { env: { DIARY_AUTH_TOKEN?, UI_AUTH_TOKEN?, LEGACY_AUTH_COMPAT? }, want }  resolveAuthTokens
//   mode:  { stored: units|null, isWrite, want }   createToolPolicy(...).mode() with the row's stored
//          mode (null: no row, or no user); stored strings outside the CHECK constraint included
//   set:   { value: units|null, writes: [bool], want: 'ok'|message }   set() up to its write

const path = require('node:path');
const server = path.join(__dirname, '..', 'server');
const { resolveAuthTokensJs: resolveAuthTokens } = require(path.join(server, 'auth-tokens.cjs'));
const { createToolPolicyJs: createToolPolicy } = require(path.join(server, 'tool-policy.cjs'));

const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const fromUnits = (u) => String.fromCharCode(...u);

// ECMAScript WhiteSpace + LineTerminator, and near misses that trim() keeps.
const SPACES = '\t\n\v\f\r                  　﻿';
const NOT_SPACES = ['\u0085', '᠎', '​', '\u0000', '\u001f', '\ud800', '\udfff'];

const tokens = [undefined, '', 'synthetic-token-1', '  synthetic-token-2  ', SPACES, `${SPACES}tok${SPACES}`, 'a b',
  ...NOT_SPACES.map((c) => `${c}tok${c}`), ...NOT_SPACES, 'tök-✓-😀', '\ud83dtok', 'x'.repeat(300)];
const compat = [undefined, 'true', 'TRUE', ' true', 'true ', '1', 'yes', '', 'false', 'tru', 'true\u0000'];

function auth() {
  const rows = [];
  const push = (env) => {
    const r = resolveAuthTokens(env);
    const enc = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) enc[k] = units(v);
    rows.push({ env: enc, want: { diaryToken: units(r.diaryToken), uiAuthToken: units(r.uiAuthToken), legacyCompat: r.legacyCompat, warnings: r.warnings } });
  };
  for (const d of tokens) for (const c of compat) push({ DIARY_AUTH_TOKEN: d, UI_AUTH_TOKEN: d === undefined ? 'ui-synthetic' : undefined, LEGACY_AUTH_COMPAT: c });
  for (const u of tokens) for (const c of compat) push({ DIARY_AUTH_TOKEN: 'diary-synthetic', UI_AUTH_TOKEN: u, LEGACY_AUTH_COMPAT: c });
  return rows;
}

// A db that hands back whatever the row says, bypassing the table's CHECK.
function fakeDb(stored) {
  return {
    exec() {},
    prepare(sql) {
      return {
        get: () => (stored === null ? undefined : { mode: fromUnits(stored) }),
        all: () => [],
        run: () => {},
        sql,
      };
    },
    transaction: (fn) => fn,
  };
}

const MODES = ['allow', 'ask', 'block', '', 'Allow', 'ASK', ' block', 'block ', 'deny', 'foo', 'allow\u0000', '﻿block', 'blocked'];

function mode() {
  const rows = [];
  for (const s of [null, ...MODES.map(units)]) {
    for (const isWrite of [false, true]) {
      const policy = createToolPolicy({ db: fakeDb(s) });
      rows.push({ stored: s, isWrite, want: policy.mode('user-1', 'tool', isWrite) });
    }
  }
  // No user: the row is never read.
  for (const isWrite of [false, true]) rows.push({ stored: null, isWrite, want: createToolPolicy({ db: fakeDb(units('block')) }).mode('', 'tool', isWrite) });
  return rows;
}

function set() {
  const rows = [];
  const lists = [[], [false], [true], [false, false], [false, true], [true, false], [true, true, true], Array(50).fill(false)];
  for (const v of [null, ...MODES.map(units)]) {
    for (const writes of lists) {
      const tools = writes.map((_, i) => `t${i}`);
      const policy = createToolPolicy({ db: fakeDb(null) });
      let want = 'ok';
      try { policy.set('user-1', tools, v === null ? undefined : fromUnits(v), (t) => writes[Number(t.slice(1))]); } catch (e) {
        if (e.status !== 400 || e.publicMessage !== e.message) throw e;
        want = e.message;
      }
      rows.push({ value: v, writes, want });
    }
  }
  return rows;
}

process.stdout.write(`${JSON.stringify({ version: 1, auth: auth(), mode: mode(), set: set() })}\n`);
