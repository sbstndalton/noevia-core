'use strict';
const contexts = require('../../server/chat-grant-context.cjs');
const { START_ID } = require('../../server/chat-partial.cjs');
function context(raw, { holder = { kind: 'project', id: 'p1' }, generation = '0', start = START_ID, tombstoned = false } = {}) {
  return { canonicalChatId: contexts.safeId(raw), holder, generation, start, tombstoned };
}
const binding = (user, raw, scope, options) => contexts.binding(user, raw, scope, context(raw, options));
module.exports = { context, binding };
