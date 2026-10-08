#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for CODE_NET_GUARD_IMPL: code-net-guard.cjs's COWORK_CODE_NET_ADDR
// parsing, the addresses resolveOnce keeps from a lookup, and refuses(localAddress). The same file is
// committed byte-for-byte in sbstndalton/noevia-rs
// (crates/code-net-guard/tests/fixtures/code-net-guard.v1.json); noevia-core CI compares them.
//   node tools/gen-code-net-guard-fixtures.cjs > tests/fixtures/code-net-guard.v1.json
//
// Every expectation is what the JS itself returns (parseCodeNetSpec, normalizeAddress, net.isIP).
// All addresses and names are synthetic. Rows whose JS answer could depend on the Node/ICU version
// or the resolver (non-ASCII text, a %zone literal, an xn-- label, IPv4-like host names; #1115)
// record no JS answer: they sit in the strict tables with want { refused: 'ambiguous' }.
//
// Sections:
//   spec:          { spec, wire, want: { literals, hosts } | { malformed } }   op 1
//   strictSpec:    { spec, wire, want: { refused: 'ambiguous' } }               op 1
//   answers:       { answers, wire, want: { addresses } }                       op 2
//   strictAnswers: { answers, wire, want: { refused: 'ambiguous' } }            op 2
//   refuses:       { addresses, local, wire, want: bool }                       op 3
//   stricter:      { addresses, local, wire, js: false, want: true }            op 3: the same IP
//                  spelled differently; the JS's string compare lets it through, the port refuses
//   strictRefuses: { addresses, local, wire, want: { refused: 'ambiguous' } }   op 3

const net = require('node:net');
const path = require('node:path');
const { parseCodeNetSpec, normalizeAddress } = require(path.join(__dirname, '..', 'server', 'code-net-guard.cjs'));

const refused = { refused: 'ambiguous' };

function specRow(spec) {
  let want;
  try {
    const { literals, hosts } = parseCodeNetSpec(spec);
    want = { literals: [...literals], hosts };
  } catch (err) {
    const m = /not "([\s\S]*)"$/.exec(err.message);
    if (!m) throw err;
    want = { malformed: m[1] };
  }
  return { spec, wire: JSON.stringify(spec), want };
}

const SPECS = [
  '', ' ', ',', ' ,\t,\n', 'egress', 'EGRESS', 'egress,egress', 'egress egress2', ' egress , web ', 'egress\n\r\t\v\fweb',
  '172.30.0.2', '172.30.0.2,172.30.0.2', '172.30.0.2 egress', '0.0.0.0', '255.255.255.255', '::', '::1', 'FE80::1', '0:0:0:0:0:0:0:1',
  '::ffff:172.30.0.2', '::FFFF:172.30.0.2,172.30.0.2', '::ffff:ac1e:2', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8',
  '1:2:3:4:5::1.2.3.4', '1:2:3:4:5:6:1.2.3.4', '::1.2.3.4', '2001:db8::1', '2001:DB8::A:b',
  'a', '1a', 'a1', 'a-b', 'a.b', 'a..b', 'a.b.', '.a', '-a', 'a-', 'egress.code.internal', 'Web-1.Example', `${'a'.repeat(253)}`,
  // Malformed: the JS throws naming the first such entry.
  'a_b', 'egress,a_b,c_d', `${'a'.repeat(254)}`, 'a/b', 'a:b', '[::1]', '1.2.3.4:80', 'http://egress', 'a b_c',
  '1:2:3:4:5:6:7:8:9', ':::', '1::2::3', '12345::', 'g::', '1.2.3.4::', '::1.2.3.256', '*', 'egress;rm', 'a"b', 'a\\b',
];

const STRICT_SPECS = [
  'fe80::1%eth0', '::1%lo', 'egress,fe80::1%25eth0', 'xn--e1a.example', 'a.XN--e1a', 'egress xn--x',
  '2130706433', '010.0.0.1', '0x7f.1', '0x7f000001', '1.2.3', '1.2.3.256', '01.2.3.4', 'a.1', 'egress.123', '1..2',
  'egréss', ' egress', 'egress web', 'egress,﻿', 'Kelvin', 'egress　web', '\ud800',
];

function answersRow(answers) {
  const addresses = answers.map((a) => normalizeAddress(a)).filter((a) => net.isIP(a));
  return { answers, wire: JSON.stringify(answers), want: { addresses } };
}

const ANSWERS = [
  [], ['172.30.0.2'], [null], ['172.30.0.2', '172.30.0.3'], ['172.30.0.2', '172.30.0.2'], [' 172.30.0.2 '], ['::FFFF:172.30.0.2'],
  ['::ffff:999.1.1.1'], ['::ffff:ac1e:2'], ['FE80::1%ETH0'], ['fe80::1%'], ['nope', '', null, '172.30.0.2'], ['1.2.3'],
  ['2001:DB8::1', '10.0.0.1'], ['\t::1\n'], ['01.2.3.4'], ['1.2.3.4 5'],
];

const STRICT_ANSWERS = [[' 172.30.0.2'], ['172.30.0.2', 'hé'], ['﻿::1']];

function refusesRow(addresses, local) {
  const want = new Set(addresses).has(normalizeAddress(local === null ? undefined : local));
  return { addresses, local, wire: JSON.stringify([addresses, local]), want };
}

const CODE = ['172.30.0.2'];
const MIXED = ['172.30.0.2', '::1', 'fe80::1%eth0', '2001:db8::1'];
const REFUSES = [
  [CODE, '172.30.0.2'], [CODE, '::ffff:172.30.0.2'], [CODE, '::FFFF:172.30.0.2'], [CODE, ' 172.30.0.2 '], [CODE, '172.30.0.3'],
  [CODE, '172.18.0.5'], [CODE, '127.0.0.1'], [CODE, '::1'], [CODE, null], [CODE, ''], [CODE, '::ffff:172.30.0.20'],
  [CODE, '172.30.0.2%x'], [CODE, '0172.30.0.2'], [[], '172.30.0.2'], [[], null],
  [MIXED, '::1'], [MIXED, 'fe80::1%eth0'], [MIXED, 'FE80::1%ETH0'], [MIXED, 'fe80::1%eth1'], [MIXED, '2001:DB8::1'], [MIXED, '2001:db8::2'],
  [MIXED, '172.30.0.2'],
];

// The same IP spelled differently: the JS compares strings and lets these through.
const STRICTER = [
  [['0:0::1'], '::1'], [['::ffff:ac1e:2'], '172.30.0.2'], [['::ffff:ac1e:2'], '::ffff:172.30.0.2'], [['172.30.0.2'], '::ffff:ac1e:2'],
  [['2001:db8:0:0:0:0:0:1'], '2001:db8::1'], [['2001:db8::1'], '2001:0db8::0001'],
];

const STRICT_REFUSES = [[CODE, ' 172.30.0.2'], [CODE, '172.30.0.2　'], [CODE, '١']];

function out() {
  const stricter = STRICTER.map(([a, l]) => {
    const row = refusesRow(a, l);
    if (row.want !== false) throw Error(`stricter row ${l}: the JS refuses already`);
    return { addresses: a, local: l, wire: row.wire, js: false, want: true };
  });
  return {
    version: 1,
    spec: SPECS.map(specRow),
    strictSpec: STRICT_SPECS.map((spec) => ({ spec, wire: JSON.stringify(spec), want: refused })),
    answers: ANSWERS.map(answersRow),
    strictAnswers: STRICT_ANSWERS.map((answers) => ({ answers, wire: JSON.stringify(answers), want: refused })),
    refuses: REFUSES.map(([a, l]) => refusesRow(a, l)),
    stricter,
    strictRefuses: STRICT_REFUSES.map(([a, l]) => ({ addresses: a, local: l, wire: JSON.stringify([a, l]), want: refused })),
  };
}

process.stdout.write(`${JSON.stringify(out())}\n`);
