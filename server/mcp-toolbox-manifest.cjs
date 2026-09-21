'use strict';

// The curated MCP toolboxes: which tools each box offers and which of them are reads.
// Data only, except that the Diary box's append tool depends on the `diaryMcpWrite` flag,
// so the manifest is built once from the injected `features`. `mcp-boxes.cjs` binds a box to
// a discovered server and `index.cjs` gates its writes.

function buildToolboxManifest({ features }) {
// ── MCP toolboxes (master step 15) ───────────────────────────────────────
//
// Curation is by explicit tool NAME, not by app prefix, and that is not
// fussiness — it is forced by measurement. Against the reference server on
// 2026-09-08 the full catalogue is 160 tools / ~40k prompt tokens converted,
// but the cost is wildly uneven: nc_calendar_create_event alone is 7,355
// chars (~3,900 tokens), twenty times the entire core box, while
// nc_notes_search_notes is 449. A whole-app box is therefore still far too
// expensive — "Calendar" as a unit is ~20k tokens, unusable at ~14 tok/s.
//
// So each box is a hand-picked working set: the smallest group of tools that
// makes the app genuinely useful, and nothing else. Tools not listed here are
// simply never offered; adding one is a deliberate, costed decision.
const MCP_TOOLBOX_MANIFEST = [
  // ── noevia's own capabilities (server `noevia`, the in-process one) ────
  //
  // These bind like any other MCP box, so they are opt-in per project, they
  // obey the same cap and token budget, and their writes go through the same
  // approval card. When MCP_INTERNAL_PORT is unset the server is not
  // configured, both boxes lose every tool and neither is offered.
  {
    id: 'diary',
    server: 'noevia',
    label: 'Diary',
    description: 'Read your diary: today, a whole month, or which months exist.',
    // Read-only, and not by oversight. The sidecar has no append endpoint —
    // /api/entries/edit corrects one already-logged exchange by its xid, and
    // /api/chat is the only route that creates entries, which AGENTS.md puts
    // out of bounds. Writing to the user's real journal needs a deliberate
    // decision and a sidecar change, not a tool quietly added here.
    // diary_append (D10) is listed only when features.diaryMcpWrite is on; it is not in
    // `reads`, so every call stops at the approval card.
    tools: ['diary_read_today', 'diary_read_month', 'diary_list_months', ...(features.enabled('diaryMcpWrite') ? ['diary_append'] : [])],
    reads: ['diary_read_today', 'diary_read_month', 'diary_list_months'],
  },
  {
    id: 'project-docs',
    server: 'noevia',
    label: 'Project documents',
    description: 'List, read, search and edit the files attached to this project.',
    tools: [
      'project_list_files', 'project_read_file', 'project_search',
      'project_create_file', 'project_append_file', 'project_replace_text',
    ],
    // The three writes are absent, so the default-deny rule makes them writes
    // and each one stops for a human with its arguments shown in full.
    reads: ['project_list_files', 'project_read_file', 'project_search'],
  },
  // Boxes are task-shaped, not app-shaped. An app with seventeen tools becomes
  // two or three boxes, because the budget is spent per selection: a project
  // that wants to read a calendar should not also pay for bulk deletion.
  //
  // `reads` is the allowlist that runs without asking. Everything absent from
  // it is a write and is gated, so a tool omitted here by mistake costs an
  // extra prompt rather than unreviewed data loss.
  //
  // Two offered tools are deliberately absent: nc_cookbook_set_config and
  // nc_cookbook_reindex administer the app itself rather than doing anything
  // with a recipe, and nothing a chat asks for should reach them.
  {
    id: 'web-search',
    server: 'tavily',
    label: 'Web search',
    description: 'Search the web, read a page, and research a topic.',
    // Every one of these is a read, and none of them touch your data — but
    // they do reach the public internet and spend metered credits, which is a
    // different kind of consequence from reading a local file.
    tools: ['tavily_search', 'tavily_extract', 'tavily_research'],
    reads: ['tavily_search', 'tavily_extract', 'tavily_research'],
  },
  {
    id: 'web-crawl',
    server: 'tavily',
    label: 'Web crawl',
    description: 'Map a site’s structure and crawl it page by page.',
    // Separated because a crawl is many requests from one call: it can spend a
    // month of credits on a single large site, which a search cannot.
    tools: ['tavily_crawl', 'tavily_map'],
    reads: ['tavily_crawl', 'tavily_map'],
  },
  {
    id: 'nextcloud-notes',
    server: 'nextcloud',
    label: 'Nextcloud Notes',
    description: 'Search, read, create and edit notes.',
    tools: [
      'nc_notes_search_notes', 'nc_notes_get_note', 'nc_notes_get_attachment',
      'nc_notes_create_note', 'nc_notes_append_content', 'nc_notes_update_note', 'nc_notes_delete_note',
    ],
    reads: ['nc_notes_search_notes', 'nc_notes_get_note', 'nc_notes_get_attachment'],
  },
  {
    id: 'nextcloud-calendar',
    server: 'nextcloud',
    label: 'Nextcloud Calendar',
    description: 'Read the calendar, find free slots, and create, change or cancel events.',
    tools: [
      'nc_calendar_list_calendars', 'nc_calendar_list_events', 'nc_calendar_get_event',
      'nc_calendar_get_upcoming_events', 'nc_calendar_find_availability',
      'nc_calendar_create_event', 'nc_calendar_update_event', 'nc_calendar_delete_event',
      'nc_calendar_create_meeting',
    ],
    reads: [
      'nc_calendar_list_calendars', 'nc_calendar_list_events', 'nc_calendar_get_event',
      'nc_calendar_get_upcoming_events', 'nc_calendar_find_availability',
    ],
  },
  {
    id: 'nextcloud-calendar-admin',
    server: 'nextcloud',
    label: 'Calendar management',
    description: 'Create and delete whole calendars, and change many events at once.',
    // Separated deliberately: bulk_operations can delete every event matching a
    // filter, which is not something a project asking "what is on Tuesday"
    // should be carrying.
    tools: ['nc_calendar_manage_calendar', 'nc_calendar_bulk_operations'],
    reads: [],
  },
  {
    id: 'nextcloud-tasks',
    server: 'nextcloud',
    label: 'Nextcloud Tasks',
    description: "Tasks, to-dos, reminders and checklists — add one, tick one off, or see what's outstanding.",
    tools: [
      'nc_calendar_list_todos', 'nc_calendar_search_todos', 'nc_calendar_create_todo',
      'nc_calendar_update_todo', 'nc_calendar_complete_todo', 'nc_calendar_delete_todo',
    ],
    // Every tool here is named `nc_calendar_*` and described in calendar words, because that is
    // where Nextcloud keeps to-dos. A small model asked to "add a task" does not make that leap
    // on its own, so noevia says it in the user's vocabulary (tool-hints.cjs).
    hints: {
      nc_calendar_list_todos: 'Use this for tasks, to-dos, reminders or a checklist: it lists them.',
      nc_calendar_search_todos: 'Use this to find a task, to-do or reminder by its text.',
      nc_calendar_create_todo: 'Use this to add a task, to-do or reminder.',
      nc_calendar_update_todo: 'Use this to change a task, to-do or reminder.',
      nc_calendar_complete_todo: 'Use this to tick off or finish a task, to-do or reminder.',
      nc_calendar_delete_todo: 'Use this to remove a task, to-do or reminder.',
    },
    reads: ['nc_calendar_list_todos', 'nc_calendar_search_todos'],
  },
  {
    id: 'nextcloud-files',
    server: 'nextcloud',
    label: 'Nextcloud Files',
    description: 'Browse, search and read files; write, move, copy and delete them.',
    tools: [
      'nc_webdav_list_directory', 'nc_webdav_read_file', 'nc_webdav_search_files',
      'nc_webdav_find_by_name', 'nc_webdav_find_by_type', 'nc_webdav_list_favorites',
      'nc_webdav_write_file', 'nc_webdav_create_directory', 'nc_webdav_move_resource',
      'nc_webdav_copy_resource', 'nc_webdav_delete_resource',
    ],
    reads: [
      'nc_webdav_list_directory', 'nc_webdav_read_file', 'nc_webdav_search_files',
      'nc_webdav_find_by_name', 'nc_webdav_find_by_type', 'nc_webdav_list_favorites',
    ],
  },
  {
    id: 'nextcloud-file-comments',
    server: 'nextcloud',
    label: 'File comments',
    description: 'Read and post comments on files.',
    tools: ['nc_webdav_list_comments', 'nc_webdav_create_comment'],
    reads: ['nc_webdav_list_comments'],
  },
  {
    id: 'nextcloud-sharing',
    server: 'nextcloud',
    label: 'Nextcloud Sharing',
    description: 'See who a file is shared with, and create or revoke shares.',
    // Every write here changes who can reach a file, so none of them run
    // unattended — a public link is a disclosure, not a convenience.
    tools: ['nc_share_list', 'nc_share_get', 'nc_share_create', 'nc_share_create_public_link', 'nc_share_update', 'nc_share_delete'],
    reads: ['nc_share_list', 'nc_share_get'],
  },
  {
    id: 'nextcloud-mail',
    server: 'nextcloud',
    label: 'Nextcloud Mail',
    description: 'Read mail, and file, flag or delete it.',
    tools: [
      'nc_mail_list_accounts', 'nc_mail_list_mailboxes', 'nc_mail_list_messages',
      'nc_mail_get_message', 'nc_mail_get_message_source', 'nc_mail_get_attachment',
      'nc_mail_set_flags', 'nc_mail_move_message', 'nc_mail_delete_message',
      'nc_mail_create_tag', 'nc_mail_set_tag', 'nc_mail_remove_tag',
    ],
    reads: [
      'nc_mail_list_accounts', 'nc_mail_list_mailboxes', 'nc_mail_list_messages',
      'nc_mail_get_message', 'nc_mail_get_message_source', 'nc_mail_get_attachment',
    ],
  },
  {
    id: 'nextcloud-mail-send',
    server: 'nextcloud',
    label: 'Send mail',
    description: 'Send email from a configured account.',
    // Its own box because sending is irreversible and reaches other people.
    // Reading your inbox should not imply the ability to mail from it.
    tools: ['nc_mail_send_message'],
    reads: [],
  },
  {
    id: 'nextcloud-contacts',
    server: 'nextcloud',
    label: 'Nextcloud Contacts',
    description: 'Search and manage contacts and address books.',
    tools: [
      'nc_contacts_list_addressbooks', 'nc_contacts_list_contacts', 'nc_contacts_search_contacts',
      'nc_contacts_create_contact', 'nc_contacts_update_contact', 'nc_contacts_delete_contact',
      'nc_contacts_create_addressbook', 'nc_contacts_delete_addressbook',
    ],
    reads: ['nc_contacts_list_addressbooks', 'nc_contacts_list_contacts', 'nc_contacts_search_contacts'],
  },
  {
    id: 'nextcloud-talk',
    server: 'nextcloud',
    label: 'Nextcloud Talk',
    description: 'Read conversations and post messages and reactions.',
    tools: [
      'talk_list_conversations', 'talk_get_conversation', 'talk_get_messages',
      'talk_list_participants', 'talk_list_reactions',
      'talk_send_message', 'talk_mark_as_read', 'talk_react', 'talk_remove_reaction',
      'talk_create_conversation', 'talk_add_participant',
    ],
    reads: [
      'talk_list_conversations', 'talk_get_conversation', 'talk_get_messages',
      'talk_list_participants', 'talk_list_reactions',
    ],
  },
  {
    id: 'nextcloud-tables',
    server: 'nextcloud',
    label: 'Nextcloud Tables',
    description: 'Read table schemas and rows, and insert, update or delete rows.',
    tools: [
      'nc_tables_list_tables', 'nc_tables_get_schema', 'nc_tables_read_table',
      'nc_tables_insert_row', 'nc_tables_update_row', 'nc_tables_delete_row',
    ],
    reads: ['nc_tables_list_tables', 'nc_tables_get_schema', 'nc_tables_read_table'],
  },
  {
    id: 'nextcloud-deck',
    server: 'nextcloud',
    label: 'Nextcloud Deck',
    description: 'Read boards and create, edit or delete cards.',
    tools: [
      'deck_get_boards', 'deck_get_board', 'deck_get_board_overview', 'deck_get_stacks',
      'deck_get_stack', 'deck_get_cards', 'deck_get_card',
      'deck_create_card', 'deck_update_card', 'deck_delete_card',
    ],
    reads: [
      'deck_get_boards', 'deck_get_board', 'deck_get_board_overview', 'deck_get_stacks',
      'deck_get_stack', 'deck_get_cards', 'deck_get_card',
    ],
  },
  {
    id: 'nextcloud-deck-workflow',
    server: 'nextcloud',
    label: 'Deck workflow',
    description: 'Move, archive, assign and link cards.',
    tools: [
      'deck_get_archived_stacks',
      'deck_archive_card', 'deck_unarchive_card', 'deck_reorder_card', 'deck_move_card_to_board',
      'deck_assign_user_to_card', 'deck_unassign_user_from_card',
      'deck_assign_dependent_card', 'deck_remove_dependent_card',
    ],
    reads: ['deck_get_archived_stacks'],
  },
  {
    id: 'nextcloud-deck-structure',
    server: 'nextcloud',
    label: 'Deck structure',
    description: 'Create and delete boards, stacks and labels.',
    tools: [
      'deck_get_labels', 'deck_get_label',
      'deck_create_board', 'deck_create_stack', 'deck_update_stack', 'deck_delete_stack',
      'deck_create_label', 'deck_update_label', 'deck_delete_label',
      'deck_assign_label_to_card', 'deck_remove_label_from_card',
    ],
    reads: ['deck_get_labels', 'deck_get_label'],
  },
  {
    id: 'nextcloud-deck-notes',
    server: 'nextcloud',
    label: 'Deck comments & files',
    description: 'Comment on cards and attach existing files or notes.',
    tools: [
      'deck_get_card_comments', 'deck_list_attachments',
      'deck_create_card_comment', 'deck_update_card_comment', 'deck_delete_card_comment',
      'deck_attach_file', 'deck_attach_note', 'deck_delete_attachment',
    ],
    reads: ['deck_get_card_comments', 'deck_list_attachments'],
  },
  {
    id: 'nextcloud-collectives',
    server: 'nextcloud',
    label: 'Nextcloud Collectives',
    description: 'Read and write collective wiki pages.',
    tools: [
      'collectives_get_collectives', 'collectives_get_pages', 'collectives_get_page',
      'collectives_search_pages', 'collectives_get_tags',
      'collectives_create_page', 'collectives_move_page', 'collectives_set_page_emoji',
      'collectives_create_tag', 'collectives_assign_tag', 'collectives_remove_tag',
    ],
    reads: [
      'collectives_get_collectives', 'collectives_get_pages', 'collectives_get_page',
      'collectives_search_pages', 'collectives_get_tags',
    ],
  },
  {
    id: 'nextcloud-collectives-admin',
    server: 'nextcloud',
    label: 'Collectives management',
    description: 'Create, trash, restore and permanently delete collectives and pages.',
    tools: [
      'collectives_get_trashed_pages', 'collectives_get_trashed_collectives',
      'collectives_create_collective', 'collectives_set_collective_emoji',
      'collectives_trash_collective', 'collectives_restore_collective', 'collectives_delete_collective',
      'collectives_trash_page', 'collectives_restore_page',
    ],
    reads: ['collectives_get_trashed_pages', 'collectives_get_trashed_collectives'],
  },
  {
    id: 'nextcloud-news',
    server: 'nextcloud',
    label: 'Nextcloud News',
    description: 'Read feeds and articles. Read-only.',
    tools: [
      'nc_news_list_folders', 'nc_news_list_feeds', 'nc_news_list_items', 'nc_news_get_item',
      'nc_news_get_starred_items', 'nc_news_get_unread_items', 'nc_news_get_feed_health', 'nc_news_get_status',
    ],
    reads: [
      'nc_news_list_folders', 'nc_news_list_feeds', 'nc_news_list_items', 'nc_news_get_item',
      'nc_news_get_starred_items', 'nc_news_get_unread_items', 'nc_news_get_feed_health', 'nc_news_get_status',
    ],
  },
  {
    id: 'nextcloud-cookbook',
    server: 'nextcloud',
    label: 'Nextcloud Cookbook',
    description: 'Search recipes, and import, create or edit them.',
    tools: [
      'nc_cookbook_list_recipes', 'nc_cookbook_get_recipe', 'nc_cookbook_search_recipes',
      'nc_cookbook_list_categories', 'nc_cookbook_get_recipes_in_category',
      'nc_cookbook_list_keywords', 'nc_cookbook_get_recipes_with_keywords',
      'nc_cookbook_import_recipe', 'nc_cookbook_create_recipe', 'nc_cookbook_update_recipe',
      'nc_cookbook_delete_recipe',
    ],
    reads: [
      'nc_cookbook_list_recipes', 'nc_cookbook_get_recipe', 'nc_cookbook_search_recipes',
      'nc_cookbook_list_categories', 'nc_cookbook_get_recipes_in_category',
      'nc_cookbook_list_keywords', 'nc_cookbook_get_recipes_with_keywords',
    ],
  },
];
  return MCP_TOOLBOX_MANIFEST;
}

module.exports = { buildToolboxManifest };
