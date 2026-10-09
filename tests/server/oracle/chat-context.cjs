'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS reference for the provider-error "context full" check, kept only so
// tools/gen-chat-template-caps-fixtures.cjs can regenerate tests/fixtures/chat-template-caps.v1.json
// and the differential test can compare it with dav-parse.wasm (noevia-rs crates/provider-error).
// Moved here unchanged from server/chat-context.cjs providerErrorJs.

const { CONTEXT_FULL_TEXT, STREAM_FAILED_TEXT } = require('../../../server/chat-context.cjs');

function providerErrorJs(value) {const text=typeof value==='string'?value:JSON.stringify(value);return /context.*(exceed|full|length)|too many tokens|maximum context/i.test(text)?CONTEXT_FULL_TEXT:STREAM_FAILED_TEXT;}

module.exports = { providerErrorJs, CONTEXT_FULL_TEXT, STREAM_FAILED_TEXT };
