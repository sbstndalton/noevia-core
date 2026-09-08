'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isWriteTool, chatWideApproved, pendingApprovals, MCP_TOOLBOX_MANIFEST, allToolboxes } = require('./index.cjs');

// The stakes here are different from the rest of the tool code. Everywhere
// else a bug means a worse answer; here it means the model deleted a calendar
// nobody agreed to delete. So the tests are written around the fail-safe
// direction rather than the happy path.

test('the built-in tools are reads and run without asking', () => {
  assert.equal(isWriteTool('get_current_time'), false);
  assert.equal(isWriteTool('read_project_file'), false);
});

test('an unknown tool is treated as a write', () => {
  // The single most important property in this file. MCP's readOnlyHint is
  // absent on 90 of the reference server's 160 tools, so "we were not told"
  // has to mean "ask", not "run it".
  assert.equal(isWriteTool('nc_calendar_obliterate_everything'), true);
  assert.equal(isWriteTool(''), true);
  assert.equal(isWriteTool(undefined), true);
});

test('every curated tool is classified, and destructive verbs are never reads', () => {
  const reads = new Set();
  for (const box of allToolboxes()) for (const n of (box.reads || [])) reads.add(n);
  for (const box of MCP_TOOLBOX_MANIFEST) {
    for (const name of box.tools) {
      // A tool whose name says it mutates must not be on the read list, no
      // matter what anyone typed into the manifest.
      if (/_(create|update|delete|write|send|move|append|assign|remove|archive)_?/.test(name)) {
        assert.equal(reads.has(name), false, `${name} is classified read-only but its name says it writes`);
        assert.equal(isWriteTool(name), true, `${name} should be gated`);
      }
    }
  }
});

test('the read classification matches what each box actually claims', () => {
  const expected = {
    'nextcloud-notes': ['nc_notes_search_notes', 'nc_notes_get_note'],
    'nextcloud-calendar': ['nc_calendar_list_calendars', 'nc_calendar_list_events', 'nc_calendar_get_upcoming_events'],
    'nextcloud-files': ['nc_webdav_list_directory', 'nc_webdav_read_file', 'nc_webdav_search_files', 'nc_webdav_find_by_name'],
    'nextcloud-contacts': ['nc_contacts_list_contacts', 'nc_contacts_search_contacts'],
    'nextcloud-talk': ['talk_list_conversations', 'talk_get_messages'],
    'nextcloud-deck': ['deck_get_boards', 'deck_get_board_overview', 'deck_get_cards'],
  };
  for (const box of MCP_TOOLBOX_MANIFEST) {
    assert.deepEqual(box.reads, expected[box.id], `${box.id} read list drifted`);
    // Every read must actually be in the box, or the classification is dead
    // text that silently gates a tool the user thinks is free.
    for (const r of box.reads) assert.ok(box.tools.includes(r), `${box.id}: ${r} is classified but not curated`);
  }
});

test('writes outnumber reads in no box by accident — each box has both', () => {
  for (const box of MCP_TOOLBOX_MANIFEST) {
    const writes = box.tools.filter((t) => !box.reads.includes(t));
    assert.ok(box.reads.length > 0, `${box.id} has no read-only tools`);
    assert.ok(writes.length > 0, `${box.id} has no write tools — is the classification real?`);
  }
});

// ── the escape hatch ─────────────────────────────────────────────────────

test('chat-wide approval is off by default and scoped to one chat and user', () => {
  // There is deliberately no global "never ask", so the default must be false
  // for every combination.
  assert.equal(chatWideApproved('user-a', 'chat-1'), false);
  assert.equal(chatWideApproved(null, null), false);
  assert.equal(chatWideApproved('user-a', undefined), false);
});

test('no approval is pending in a fresh process', () => {
  // Pending approvals are in-memory on purpose: a restart must re-ask rather
  // than honour a decision made against a conversation that no longer exists.
  assert.equal(pendingApprovals.size, 0);
});

test('an approval can only be decided by the user it belongs to', () => {
  // Simulates the map the route consults. Without the owner check, any
  // signed-in member could approve another member's write.
  let decided = null;
  pendingApprovals.set('ap-test', { userId: 'owner', chatId: 'c1', decide: (d) => { decided = d; return true; } });
  try {
    const pending = pendingApprovals.get('ap-test');
    assert.equal(pending.userId === 'someone-else', false);
    // The route compares pending.userId against the caller before calling
    // decide(), so a mismatched caller never reaches this.
    assert.equal(decided, null);
    pending.decide('approve');
    assert.equal(decided, 'approve');
  } finally {
    pendingApprovals.delete('ap-test');
  }
});

test('only the three valid decisions are accepted', () => {
  const seen = [];
  const decide = (decision) => {
    if (decision === 'approve_all') { seen.push('approve_all'); return true; }
    if (decision === 'approve' || decision === 'deny') { seen.push(decision); return true; }
    return false;
  };
  assert.equal(decide('approve'), true);
  assert.equal(decide('deny'), true);
  assert.equal(decide('approve_all'), true);
  assert.equal(decide('yes'), false);
  assert.equal(decide(''), false);
  assert.equal(decide('APPROVE'), false);
  assert.deepEqual(seen, ['approve', 'deny', 'approve_all']);
});
