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
const SOURCES = [
  { name: 'gemma3-262k', license: 'gemma', url: 'https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q2_K.gguf' },
  { name: 'gemma4-262k', license: 'apache-2.0', url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-IQ4_XS.gguf' },
  { name: 'qwen3-151k', license: 'apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf' },
];

async function main() {
  const mib = Number(process.argv[2] || 32);
  const bytes = mib * 1024 * 1024;
  fs.mkdirSync(DIR, { recursive: true });
  const manifest = [];
  for (const s of SOURCES) {
    const res = await fetch(s.url, { headers: { Range: `bytes=0-${bytes - 1}` }, redirect: 'follow' });
    if (res.status !== 206) throw Error(`${s.name}: expected 206 Partial Content, got ${res.status}`);
    const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1]);
    if (!Number.isSafeInteger(total)) throw Error(`${s.name}: no total size in Content-Range`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > bytes) throw Error(`${s.name}: server sent more than asked`);
    fs.writeFileSync(path.join(DIR, `${s.name}.head`), body);
    manifest.push({ name: s.name, url: s.url, license: s.license, totalSize: total, headBytes: body.length });
    console.error(`${s.name}: ${body.length} of ${total} bytes`);
  }
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
