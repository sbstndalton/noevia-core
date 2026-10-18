'use strict';
// #1213: Nextcloud storage calls that the Diary-folder path check cannot see (no path at all, or
// a file named by id) are refused for an external provider, and a local provider is untouched.
// Synthetic folder and provider only: the Diary folder is `Diary`, the files are `Work/…`.
const test = require('node:test'), assert = require('node:assert/strict');
const pe = require('./provider-egress.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const CHATGPT = { id: 'c', kind: 'chatgpt-oauth', label: 'ChatGPT', baseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: 'sk-synthetic' };
const LOCAL = { id: 'local', label: 'Local', baseUrl: 'http://llama:8080/v1' };
const STORAGE = { kind: 'nextcloud', corpusRoot: 'Diary', baseUrl: 'https://nc.example/remote.php/dav/files/alice', password: 'synthetic' };
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !require('node:fs').existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const refusal = (toolName, rawArgs, provider = CHATGPT) => pe.toolRefusal({ provider, toolName, rawArgs, storage: STORAGE });

test('a favourites listing is refused for an external provider: it names no path (#1213)', { skip: skipWasm }, () => {
  // Attack input: the bare tool call. Favourites span every folder, so the Diary can be in the list.
  for (const rawArgs of ['{}', '', { }]) {
    assert.match(refusal('nc_webdav_list_favorites', rawArgs), /names no path, so the Diary folder cannot be ruled out/);
  }
  assert.equal(refusal('nc_webdav_list_favorites', '{}', LOCAL), null, 'a local provider keeps the tool');
});

test('a file named by numeric or string id is refused, with or without a path beside it (#1213)', { skip: skipWasm }, () => {
  // Attack inputs: {"fileId": 5} reads the file with numeric id 5 (a Diary entry), which the path
  // check never sees because the value is not a string. {"path":"Work/a","fileId":"5"} carries a
  // harmless path next to the id the server would act on.
  for (const [tool, args] of [
    ['nc_webdav_read_file', '{"fileId":5}'],
    ['nc_webdav_read_file', '{"fileId":"5"}'],
    ['nc_webdav_read_file', '{"path":"Work/a","fileId":"5"}'],
    ['nc_webdav_read_file', '{"path":"Work/a","item":5}'],
    ['nc_webdav_get_metadata', '{"file_id":7}'],
    ['nc_webdav_list_directory', '{"node":5}'],
    ['nc_webdav_list_comments', '{"fileId":12}'],
    ['nc_webdav_create_comment', '{"fileId":12,"message":"hi"}'],
  ]) {
    assert.match(refusal(tool, args) || '', /addresses a file by id, which cannot be checked against the Diary folder/, `${tool} ${args}`);
  }
});

test('a path-less call is refused, except the bare listing of the root (#1213)', { skip: skipWasm }, () => {
  // Attack input: a root listing with any argument at all is not the bare listing and is refused.
  assert.equal(refusal('nc_webdav_list_directory', '{}'), null, 'bare root listing names only the root');
  assert.match(refusal('nc_webdav_list_directory', '{"recursive":true}') || '', /names no path|needs a folder/);
  assert.match(refusal('nc_webdav_delete_resource', '{}') || '', /names no path/);
});

test('the Diary folder check still refuses a path inside or above the Diary (#1213 keeps #452)', { skip: skipWasm }, () => {
  assert.match(refusal('nc_webdav_read_file', '{"path":"Diary/entry.md"}') || '', /in the Diary folder/);
  assert.match(refusal('nc_webdav_read_file', '{"path":"/remote.php/dav/files/alice/diary/x"}') || '', /in the Diary folder/);
  assert.match(refusal('nc_webdav_search_files', '{"path":""}') || '', /contains the Diary folder/);
  // Ordinary files outside the Diary, by path, stay allowed.
  assert.equal(refusal('nc_webdav_read_file', '{"path":"Work/a.md"}'), null);
  assert.equal(refusal('nc_webdav_search_files', '{"path":"Work","query":"budget"}'), null);
});

// #1213 as the Rust port itself answers it (the only implementation since #1071): path-less and id-addressed
// storage calls cannot be checked against the Diary folder, so the port refuses them for an external provider.
// These call dav-parse.wasm directly, with the host's projections, not through the wrapper above.
test('the port itself refuses path-less and id-addressed storage tools for an external provider, and allows the bare root listing (#1213)', { skip: skipWasm },  { skip: skipWasm }, () => {
  const provider = pe.providerProjection(CHATGPT);
  const local = pe.providerProjection(LOCAL);
  const storage = pe.storageProjection(STORAGE);
  const ask = (toolName, rawArgs, p = provider) => davParseWasm.providerEgressToolRefusal(p, toolName, rawArgs, storage).refusal;
  for (const rawArgs of ['{}', '', {}]) assert.match(ask('nc_webdav_list_favorites', rawArgs), /names no path, so the Diary folder cannot be ruled out/);
  for (const [tool, args] of [['nc_webdav_read_file', '{"fileId":5}'], ['nc_webdav_read_file', '{"path":"Work/a","fileId":"5"}'], ['nc_webdav_get_metadata', '{"file_id":7}'],
    ['nc_webdav_list_directory', '{"node":5}'], ['nc_webdav_create_comment', '{"fileId":12,"message":"hi"}']]) {
    assert.match(ask(tool, args), /addresses a file by id, which cannot be checked against the Diary folder/, `${tool} ${args}`);
  }
  assert.equal(ask('nc_webdav_list_directory', '{}'), null);
  assert.match(ask('nc_webdav_list_directory', '{"recursive":true}'), /names no path|needs a folder/);
  assert.match(ask('nc_webdav_delete_resource', '{}'), /names no path/);
  assert.match(ask('nc_webdav_search_files', '{"path":""}'), /contains the Diary folder/);
  assert.equal(ask('nc_webdav_read_file', '{"path":"Work/a.md"}'), null);
  // A local provider is untouched, and the Diary folder not being identified closes storage for an external one.
  assert.equal(ask('nc_webdav_list_favorites', '{}', local), null);
  const none = davParseWasm.providerEgressToolRefusal(provider, 'nc_webdav_read_file', '{"path":"Work/a.md"}', pe.storageProjection({ ...STORAGE, corpusRoot: '' })).refusal;
  assert.match(none, /the Diary folder could not be identified, so storage is closed to external providers/);
});
