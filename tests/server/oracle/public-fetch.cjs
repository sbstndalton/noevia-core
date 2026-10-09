'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). What publicFetch decided about a URL before it opened a socket, with the JS
// denylist (tests/server/oracle/ssrf.cjs) and no Rust URL check: the scheme and credentials checks,
// then the private-literal check, then the connection attempt (`http(s).request`, which the fixture
// generator and the differential tests replace so nothing connects). It is the reference for the
// `fetch` column of tests/fixtures/ssrf.v1.json (tools/gen-ssrf-fixtures.cjs). Production decides
// with the Rust module (server/public-fetch.cjs).
// Moved from server/public-fetch.cjs createPublicFetch, without the response handling.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { isPrivateIpJs } = require('./ssrf.cjs');

function refusal(message) {
  return Object.assign(new Error(message), { code: 'EPRIVATEADDR' });
}

function createPublicFetchJs({ isPublicAddress = (ip) => !isPrivateIpJs(ip), allowLoopbackLiteral = false } = {}) {
  return async function publicFetchJs(input) {
    const url = new URL(String(input));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`refused: ${url.protocol} is not http(s)`);
    if (url.username || url.password) throw new TypeError('refused: credentials in the URL');
    // An IP literal is never looked up, so it is judged here instead. It cannot rebind.
    if (net.isIP(host) && !isPublicAddress(host) && !(allowLoopbackLiteral && host === '127.0.0.1')) {
      throw refusal(`refused: ${host} is a private address`);
    }
    const mod = url.protocol === 'https:' ? https : http;
    mod.request({ protocol: url.protocol, hostname: host, port: url.port || undefined, path: `${url.pathname}${url.search}`, method: 'GET', agent: false });
  };
}

module.exports = { createPublicFetchJs };
