#!/usr/bin/env node
'use strict';
// Downloads ONLY the first N MiB (one HTTP Range request each; never the whole file, no model
// run) of a few public large-vocabulary GGUFs into tests/fixtures/real-gguf-headers/ (gitignored;
// the files are licensed by their publishers and ~32 MiB each). tests/server/gguf-meta-real-headers
// .test.cjs uses them if present (REAL_GGUF_HEADERS_REQUIRED=1 makes absence a failure).
//   node tools/fetch-real-gguf-headers.cjs [MiB=32]
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '../tests/fixtures/real-gguf-headers');
// Smallest quantisation of each; the metadata block (vocabulary, merges, template) does not depend on it.
// #1195: pinned to a commit and the file's exact size, so a re-upload under the same name cannot
// change the fixtures silently. To move a pin, look up the new commit and size and change both.
const SOURCES = [
  { name: 'gemma3-262k', license: 'gemma', repo: 'unsloth/gemma-3-1b-it-GGUF', revision: 'f0b45be0aac41bd6a100a4b5734cad5f67255bfb', file: 'gemma-3-1b-it-Q2_K.gguf', size: 689814560 },
  { name: 'gemma4-262k', license: 'apache-2.0', repo: 'unsloth/gemma-4-12b-it-GGUF', revision: 'fc034cfff751157913579611efad8462ac1be606', file: 'gemma-4-12b-it-IQ4_XS.gguf', size: 6375734080 },
  { name: 'qwen3-151k', license: 'apache-2.0', repo: 'Qwen/Qwen3-0.6B-GGUF', revision: '23749fefcc72300e3a2ad315e1317431b06b590a', file: 'Qwen3-0.6B-Q8_0.gguf', size: 639446688 },
];
const sourceUrl = (s) => `https://huggingface.co/${s.repo}/resolve/${s.revision}/${s.file}`;
function checkTotal(s, total) {
  if (!Number.isSafeInteger(total)) throw Error(`${s.name}: no total size in Content-Range`);
  if (total !== s.size) throw Error(`${s.name}: total size ${total} is not the pinned size ${s.size}`);
  return total;
}

// #1195: --mib is a whole number of MiB from 1 to MAX_MIB. Anything else (NaN, a fraction, zero) would
// make the Range header bytes=0-NaN, or ask for no bytes at all.
const MAX_MIB = 256;
function parseMib(arg) {
  if (arg === undefined || arg === '') return 32;
  const mib = Number(arg);
  if (!Number.isInteger(mib) || mib < 1 || mib > MAX_MIB) throw Error(`--mib must be a whole number of MiB from 1 to ${MAX_MIB}, got ${JSON.stringify(arg)}`);
  return mib;
}

async function main() {
  const mib = parseMib(process.argv[2]);
  const bytes = mib * 1024 * 1024;
  fs.mkdirSync(DIR, { recursive: true });
  const manifest = [];
  for (const s of SOURCES) {
    const url = sourceUrl(s);
    const res = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, redirect: 'follow' });
    if (res.status !== 206) throw Error(`${s.name}: expected 206 Partial Content, got ${res.status}`);
    const total = checkTotal(s, Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1]));
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > bytes) throw Error(`${s.name}: server sent more than asked`);
    fs.writeFileSync(path.join(DIR, `${s.name}.head`), body);
    manifest.push({ name: s.name, url, revision: s.revision, license: s.license, totalSize: total, headBytes: body.length });
    console.error(`${s.name}: ${body.length} of ${total} bytes`);
  }
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { parseMib, MAX_MIB, SOURCES, sourceUrl, checkTotal };
