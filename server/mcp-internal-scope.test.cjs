'use strict';
// The project an internal MCP call acts for must belong to that call, not to
// whichever chat touched the module last.
//
// This used to be a module-level `let`, set immediately before the await and
// cleared in a finally. Node is single-threaded but not non-reentrant: two
// chats calling internal tools interleave at the await, and the second
// overwrites the first's project before the first mints its token. Because
// that project id goes into an HMAC'd capability token, the loser acts against
// the other chat's project — across users.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { AsyncLocalStorage } = require('node:async_hooks');

// The real executeToolCall (toolboxes.cjs) and the real token-minting path
// (mcpInternalAuth, still in index.cjs), with everything they touch faked out.
function harness() {
  const server = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const minted = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const context = {
    require,
    console,
    requestScope: new AsyncLocalStorage(),
    MCP_INTERNAL_KEY: 'test-key',
    isWriteTool: () => false,
    authService: { getStorage: () => ({ kind: 'local' }) },
    mcpInternal: { mintToken: (_key, claims) => { minted.push(claims); return 'tok'; } },
  };
  vm.createContext(context);
  const cut = (from, to) => server.slice(server.indexOf(from), server.indexOf(to));
  vm.runInContext(cut('function mcpInternalAuth(', '/** Discovery runs with no user'), context);
  const { executeToolCall } = require('./toolboxes.cjs').createToolboxes({
    scope: context.requestScope,
    mcpTools: () => new Map([['nc_notes_search_notes', {}]]),
    documentSources: { notice: () => '' },
    // Stands in for the real MCP round trip: the first caller parks here so
    // the second can run to completion underneath it.
    async executeMcp(name) {
      if (minted.length === 0 && !context.__second) { context.__second = true; await gate; }
      return JSON.stringify(context.mcpInternalAuth(name));
    },
  });
  context.executeToolCall = executeToolCall;
  return { context, minted, release };
}

const call = (context, userId, projectId) => context.requestScope.run(
  { workspace: { userId }, authn: { user: { id: userId } } },
  () => context.executeToolCall({ id: projectId }, 'nc_notes_search_notes', '{}'),
);

test('two interleaved internal tool calls each mint a token for their own project', async () => {
  const { context, minted, release } = harness();
  // Chat A enters the tool and parks inside the await.
  const a = call(context, 'user-a', 'project-a');
  await new Promise((r) => setImmediate(r));
  // Chat B runs to completion while A is parked.
  await call(context, 'user-b', 'project-b');
  release();
  await a;

  assert.equal(minted.length, 2);
  const byUser = Object.fromEntries(minted.map((m) => [m.uid, m.pid]));
  assert.deepEqual(byUser, { 'user-a': 'project-a', 'user-b': 'project-b' });
});

test('a call with no project mints a null project id rather than inheriting one', async () => {
  const { context, minted, release } = harness();
  const a = call(context, 'user-a', 'project-a');
  await new Promise((r) => setImmediate(r));
  await context.requestScope.run(
    { workspace: { userId: 'user-b' }, authn: { user: { id: 'user-b' } } },
    () => context.executeToolCall(null, 'nc_notes_search_notes', '{}'),
  );
  release();
  await a;

  assert.equal(minted.find((m) => m.uid === 'user-b').pid, null);
  assert.equal(minted.find((m) => m.uid === 'user-a').pid, 'project-a');
});
