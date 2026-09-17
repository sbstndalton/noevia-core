'use strict';
// R1 "measure first": per-round context accounting, opt-in with CONTEXT_LOG=1.
// Records estimated token counts and tool NAMES only — never message text, tool
// arguments or results — in the tenant's own directory, bounded in size.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { tokens } = require('./chat-context.cjs');

const MAX_BYTES = 2 * 1024 * 1024;
const SUMMARY_PREFIX = 'Earlier conversation summary';

function enabled(env = process.env) { return env.CONTEXT_LOG === '1'; }

function breakdown(messages, tools) {
  const namesById = new Map();
  for (const m of messages) for (const call of m.tool_calls || []) namesById.set(call.id, call.function?.name || 'unknown');
  const out = { system: 0, history: 0, summary: 0, toolSchemas: {}, toolResults: [], toolSequence: [] };
  for (const m of messages) {
    const size = tokens(m);
    if (m.role === 'system') out.system += size;
    else if (m.role === 'tool') out.toolResults.push({ name: namesById.get(m.tool_call_id) || 'unknown', tokens: size });
    else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX)) out.summary += size;
    else out.history += size;
    for (const call of m.tool_calls || []) out.toolSequence.push(call.function?.name || 'unknown');
  }
  for (const tool of tools || []) {
    const name = tool.function?.name || 'unknown';
    out.toolSchemas[name] = (out.toolSchemas[name] || 0) + tokens(tool);
  }
  return out;
}

function record({ chatId, model, limit, round, compacted, messages, tools, now = Date.now() }) {
  const parts = breakdown(messages, tools);
  const schemaTotal = Object.values(parts.toolSchemas).reduce((n, v) => n + v, 0);
  const resultTotal = parts.toolResults.reduce((n, r) => n + r.tokens, 0);
  return {
    at: now,
    chat: crypto.createHash('sha256').update(String(chatId)).digest('hex').slice(0, 16),
    model, limit, round, compacted: !!compacted,
    total: parts.system + parts.history + parts.summary + schemaTotal + resultTotal,
    ...parts,
  };
}

function append(dir, entry) {
  const file = path.join(dir, 'context-log.jsonl');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch { /* first write */ }
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

// Rank what consumes context: tools by total result + schema tokens, and
// recurring tool sequences (per chat round) by the result tokens they produced.
function report(lines) {
  const tools = new Map(), sequences = new Map();
  let rounds = 0, compactions = 0, totals = [];
  for (const line of lines) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    rounds++; if (entry.compacted) compactions++; totals.push(entry.total || 0);
    for (const [name, value] of Object.entries(entry.toolSchemas || {})) {
      const row = tools.get(name) || { name, schemaTokens: 0, resultTokens: 0, results: 0 };
      row.schemaTokens += value; tools.set(name, row);
    }
    for (const result of entry.toolResults || []) {
      const row = tools.get(result.name) || { name: result.name, schemaTokens: 0, resultTokens: 0, results: 0 };
      row.resultTokens += result.tokens; row.results++; tools.set(result.name, row);
    }
    if ((entry.toolSequence || []).length) {
      const key = entry.toolSequence.join(' → ');
      const row = sequences.get(key) || { sequence: key, count: 0, resultTokens: 0 };
      row.count++; row.resultTokens += (entry.toolResults || []).reduce((n, r) => n + r.tokens, 0); sequences.set(key, row);
    }
  }
  totals.sort((a, b) => a - b);
  return {
    rounds, compactions,
    medianTotal: totals.length ? totals[Math.floor(totals.length / 2)] : 0,
    tools: [...tools.values()].sort((a, b) => (b.resultTokens + b.schemaTokens) - (a.resultTokens + a.schemaTokens)),
    sequences: [...sequences.values()].sort((a, b) => b.resultTokens - a.resultTokens || b.count - a.count),
  };
}

module.exports = { enabled, breakdown, record, append, report, MAX_BYTES };

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node server/context-log.cjs <context-log.jsonl> [...]'); process.exit(2); }
  const lines = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean));
  console.log(JSON.stringify(report(lines), null, 2));
}
