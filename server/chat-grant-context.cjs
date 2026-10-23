'use strict';
// #1071 slice7: Rust's durable context, never a local holder/file fallback.
const { START_ID } = require('./chat-partial.cjs');
const safeId = raw => typeof raw === 'string' ? raw.replace(/[^a-zA-Z0-9_-]/g, '') : '';
const decimal = v => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 20 && BigInt(v) <= 18446744073709551615n;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
function holder(v) {
  if (!object(v)) return null;
  const keys = Object.keys(v).sort().join(',');
  if (keys === 'kind' && (v.kind === 'free' || v.kind === 'absent')) return Object.freeze({ kind: v.kind });
  if (keys === 'id,kind' && v.kind === 'project' && typeof v.id === 'string' && v.id) return Object.freeze({ kind: 'project', id: v.id });
  return null;
}
function invalid() { return Object.assign(new Error('The chat permission context is unavailable. Ask again before running this tool.'), { code: 'CHAT_PERMISSION_CONTEXT', status: 503 }); }
function validate(raw, v, start = START_ID) {
  const canonical = safeId(raw), h = holder(v?.holder);
  if (!canonical || !object(v) || v.canonicalChatId !== canonical || !h || !decimal(v.generation) ||
      !/^[0-9a-f]{32}$/.test(v.start || '') || v.start !== start || typeof v.tombstoned !== 'boolean') throw invalid();
  return Object.freeze({ canonicalChatId: canonical, holder: h, generation: v.generation, start: v.start, tombstoned: v.tombstoned });
}
const sameHolder = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind !== 'project' || a.id === b.id);
const same = (a, b) => !!a && !!b && a.canonicalChatId === b.canonicalChatId && sameHolder(a.holder, b.holder) && a.generation === b.generation && a.start === b.start && !a.tombstoned && !b.tombstoned;
function binding(user, raw, scope, context) {
  if (!user || !scope || !safeId(raw)) return null;
  const value = validate(raw, context);
  if (value.tombstoned) throw invalid();
  return Object.freeze({ user, canonicalChatId: value.canonicalChatId, scope, context: value });
}
const matches = (a, b) => !!a && !!b && a.user === b.user && a.scope === b.scope && a.canonicalChatId === b.canonicalChatId && same(a.context, b.context);
const key = (user, raw) => user && safeId(raw) ? JSON.stringify([user, safeId(raw)]) : null;
module.exports = { safeId, decimal, holder, validate, sameHolder, same, binding, matches, key, invalid };
