#!/usr/bin/env node
'use strict';
// A repo-search MCP server for agents working ON noevia. Dev tooling only.
//
// Why it exists: this repo is 816 tracked files and server/index.cjs
// alone is 264 KB. Without a way to ask "where is the tool budget decided",
// an agent reads whole files, and the reading is most of what the session
// costs. That is the problem zilliztech/claude-context solves with Milvus and
// a hosted embedding provider; neither is wanted here — noevia already runs
// its own embedding server and its own sqlite-vec store, and a dev tool has no
// business adding infrastructure the product does not need.
//
// So this is ripgrep plus a brace-counting outliner: no index to build, no
// service to run, nothing to keep in sync with the working tree. It answers
// the question that was actually being asked.
//
// Three JSON-RPC methods and nothing more — the same discipline
// server/mcp.cjs keeps on the client side, for the same reason.
//
// It is NOT part of the product: it is not reachable from server, it
// is not in MCP_SERVERS, and it is not in any compose file. It reads the
// working tree and never writes.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { outline, enclosing } = require('./symbols.cjs');
const { tabulate } = require('../../server/tool-result-reduce.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const MAX_CHARS = 8000; // same budget the product gives a tool result
const PROTOCOL_VERSION = '2024-11-05';

// Every path from a caller is resolved and then checked to be inside ROOT.
// The model picks these strings, so "../../etc/passwd" is a thing that will be
// asked for eventually, by accident or otherwise.
function resolveInRoot(rel) {
  const abs = path.resolve(ROOT, String(rel || ''));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('path is outside the repository');
  return abs;
}

function rg(args) {
  // stdin must be closed, not inherited: this process's stdin is the JSON-RPC
  // stream, and with no path argument ripgrep would search THAT instead of the
  // repository — silently returning zero matches for text that is plainly there.
  const res = spawnSync('rg', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) throw new Error(`ripgrep is required but could not be run: ${res.error.message}`);
  // rg exits 1 for "no matches", which is an answer, not a failure.
  if (res.status !== 0 && res.status !== 1) throw new Error(`ripgrep failed: ${(res.stderr || '').slice(0, 200)}`);
  return res.stdout || '';
}

const fileCache = new Map();
function readFile(abs) {
  if (!fileCache.has(abs)) {
    try { fileCache.set(abs, fs.readFileSync(abs, 'utf8')); } catch { fileCache.set(abs, null); }
  }
  return fileCache.get(abs);
}

function searchCode({ query, k = 20, glob }) {
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const args = ['--line-number', '--no-heading', '--color=never', '--max-columns=240', '--max-columns-preview', '-e', query];
  if (glob) args.push('--glob', String(glob));
  args.push('.'); // explicit path, so a missing one can never mean "search stdin" again
  const lines = rg(args).split('\n').filter(Boolean);
  const limit = Math.max(1, Math.min(Number(k) || 20, 100));
  const hits = [];
  for (const line of lines.slice(0, limit)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    // rg was given an explicit '.' to search, so it prefixes every path with
    // './'. Strip it: these paths get pasted back into a read, and the noise
    // is repeated on every hit.
    const file = m[1].replace(/^\.\//, '');
    const [, , lineNo, text] = m;
    // The enclosing declaration is the difference between "index.cjs:1030" and
    // a range the agent can read on its own. Only worth computing for source.
    let symbol = '';
    if (/\.(c?js|mjs|ts|tsx|py)$/.test(file)) {
      const body = readFile(path.join(ROOT, file));
      const d = body && enclosing(body, Number(lineNo));
      if (d) symbol = `${d.name} (${d.line}-${d.endLine})`;
    }
    hits.push({ file, line: Number(lineNo), symbol, text: text.trim() });
  }
  if (!hits.length) return '[0 matches]';
  const total = lines.length;
  const table = tabulate(hits, { maxChars: MAX_CHARS });
  const header = total > table.kept
    ? `[${table.kept} of ${total} matches; raise k or narrow the query for the rest. Tab-separated, first line is the column names.]`
    : `[${table.kept} matches. Tab-separated, first line is the column names.]`;
  return `${header}\n${table.text}`;
}

function outlineFile({ path: rel }) {
  const abs = resolveInRoot(rel);
  const body = readFile(abs);
  if (body === null) throw new Error(`cannot read ${rel}`);
  const decls = outline(body);
  if (!decls.length) return `[${rel}: ${body.split('\n').length} lines, no top-level declarations found. Read it directly.]`;
  const table = tabulate(decls, { maxChars: MAX_CHARS });
  const header = `[${rel}: ${body.split('\n').length} lines, ${decls.length} top-level declarations${table.note ? `; ${table.note.slice(1, -1)}` : ''}. Tab-separated, first line is the column names. End lines are from brace counting and are advisory — read the range to confirm.]`;
  return `${header}\n${table.text}`;
}

const TOOLS = [
  {
    name: 'search_code',
    description: 'Search the noevia working tree with ripgrep and report each hit with the declaration that encloses it, so you can read one function instead of a whole file. Use this before opening any large file.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A ripgrep regular expression.' },
        k: { type: 'number', description: 'Maximum hits to return (default 20, max 100).' },
        glob: { type: 'string', description: "Optional path filter, e.g. 'server/*.cjs'." },
      },
      required: ['query'],
    },
    run: searchCode,
  },
  {
    name: 'outline_file',
    description: "List a file's top-level declarations with their line ranges. Built for server/index.cjs (264 KB): outline it, then read only the range you need.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repository-relative file path.' } },
      required: ['path'],
    },
    run: outlineFile,
  },
];

function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    return reply({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'noevia-repo-index', version: '0.1.0' },
    });
  }
  if (method === 'tools/list') {
    return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params?.name}` } };
    try {
      return reply({ content: [{ type: 'text', text: tool.run(params.arguments || {}) }] });
    } catch (err) {
      // Returned as tool content, not as a protocol error: a failed search is
      // something the agent can act on, and an error kills the call instead.
      return reply({ content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true });
    }
  }
  if (typeof id === 'undefined') return null; // a notification; nothing is owed
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported method: ${method}` } };
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let out;
      try { out = handle(JSON.parse(line)); }
      catch (err) { out = { jsonrpc: '2.0', id: null, error: { code: -32700, message: String(err.message) } }; }
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) main();
module.exports = { handle, searchCode, outlineFile, resolveInRoot };
