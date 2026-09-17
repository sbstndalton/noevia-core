'use strict';

// The tools noevia offers over its own MCP server. Kept apart from index.cjs
// and from mcp-internal.cjs so the behaviour can be unit-tested against fakes:
// the transport and token machinery are one concern, what the tools DO is
// another.
//
// Every handler receives `(args, ctx)` where ctx.userId / ctx.projectId come
// from the verified capability token. Nothing here reads identity out of args,
// and no schema declares a user, project or tenant field, so a prompt-injected
// argument has nothing to aim at.
//
// Descriptions are terse on purpose. Two limits bind at resolve time —
// toolCapFor(model) and toolTokenBudgetFor(model) — and a box is all-or-nothing,
// so prose here is paid for on every request by the smallest model.

const MAX_TEXT_BYTES = 256 * 1024;

function requireProject(ports, ctx) {
  const project = ports.getProject(ctx.projectId);
  if (!project) throw new Error('this chat is not in a project, so there are no project files');
  return project;
}

function cleanName(raw) {
  const name = String(raw || '').split('/').pop().split('\\').pop().trim().slice(0, 200);
  if (!name || name === '.' || name === '..') throw new Error('a filename is required');
  return name;
}

/** A file the project holds, or a readable error naming what it does have. */
function findFile(project, wanted) {
  const files = Array.isArray(project.files) ? project.files : [];
  const file = files.find((f) => f.name === wanted);
  if (file) return file;
  const names = files.map((f) => f.name).join(', ') || '(none attached)';
  throw new Error(`no project file named "${wanted}". Available: ${names}`);
}

/** Files that came from an attached storage folder are owned by the server —
 *  the sync loop rewrites them — so editing one here would be undone silently.
 *  Uploads are ours to change. */
function assertEditable(file) {
  if (file.source) throw new Error(`"${file.name}" comes from the attached folder "${file.source}" and is kept in sync from there. Edit it in that folder instead.`);
  if (file.attachment && file.attachment.state === 'stored') throw new Error(`"${file.name}" is stored in its original format and has no editable text.`);
  if (file.document) throw new Error(`"${file.name}" is an extracted document, not an editable text file.`);
}

function createInternalTools(ports) {
  const cap = ports.cap || 8000;
  const clip = (text) => {
    const s = String(text == null ? '' : text);
    return s.length > cap ? `${s.slice(0, cap)}\n…[truncated]` : s;
  };

  return {
    // ── Diary ────────────────────────────────────────────────────────────
    //
    // Reads always. One write, diary_append, exists only when the deployment turns on
    // features.diaryMcpWrite (D10) and passes ports.diaryAppend: it adds a new note to
    // TODAY through the sidecar's journaled append endpoint. It cannot edit, delete or
    // target a past day, and like every write it runs only after the approval card.
    diary_read_today: {
      description: "Read today's diary entries.",
      schema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const day = await ports.diary('/day');
        const parts = [];
        if (day.standing) parts.push(`Standing notes:\n${day.standing}`);
        parts.push(`${day.day || 'Today'}:\n${day.today_log || '(nothing written yet today)'}`);
        return clip(parts.join('\n\n'));
      },
    },
    diary_read_month: {
      description: 'Read one month of diary entries. month is YYYY-MM.',
      schema: { type: 'object', properties: { month: { type: 'string', description: 'YYYY-MM' } }, required: ['month'] },
      handler: async (args) => {
        const month = String(args.month || '').trim();
        if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month must look like 2026-09');
        const out = await ports.diary(`/day?month=${encodeURIComponent(month)}`);
        return clip(out.log || `(no entries in ${month})`);
      },
    },
    diary_list_months: {
      description: 'List the months that have diary entries.',
      schema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const out = await ports.diary('/months');
        const months = Array.isArray(out.months) ? out.months : [];
        if (!months.length) return 'The diary has no entries yet.';
        return clip(months.map((m) => (typeof m === 'string' ? m : m.month)).filter(Boolean).join(', '));
      },
    },

    ...(typeof ports.diaryAppend === 'function' ? {
      diary_append: {
        description: "Add a new note to today's diary entry. Cannot change earlier entries.",
        write: true,
        schema: { type: 'object', properties: {
          text: { type: 'string', description: 'the note, plain text' },
          title: { type: 'string', description: 'short one-line heading' },
          timezone: { type: 'string', description: "IANA timezone for today's date" },
        }, required: ['text'] },
        handler: async (args) => {
          const text = String(args.text == null ? '' : args.text).trim();
          if (!text) throw new Error('there is nothing to add');
          if (text.length > 8000) throw new Error('that note is too long; keep it under 8000 characters');
          const title = args.title == null ? undefined : String(args.title).trim().slice(0, 80) || undefined;
          const out = await ports.diaryAppend({ text, title, timezone: args.timezone ? String(args.timezone) : undefined });
          return `Added a note to the diary for ${out.day}.`;
        },
      },
    } : {}),

    // ── Project documents ────────────────────────────────────────────────
    project_list_files: {
      description: "List the files attached to this chat's project.",
      schema: { type: 'object', properties: {}, required: [] },
      handler: async (_args, ctx) => {
        const project = requireProject(ports, ctx);
        const files = Array.isArray(project.files) ? project.files : [];
        if (!files.length) return 'This project has no files attached.';
        return clip(files.map((f) => {
          const kind = f.source ? `from folder ${f.source}` : f.document ? 'document' : 'text';
          const size = typeof f.content === 'string' ? `${f.content.length} chars` : 'no readable text';
          return `${f.name} — ${kind}, ${size}`;
        }).join('\n'));
      },
    },
    project_read_file: {
      description: 'Read one project file by name. Use offset to continue a long file.',
      schema: { type: 'object', properties: {
        name: { type: 'string' },
        offset: { type: 'integer', description: 'characters to skip' },
        startPage: { type: 'integer', description: 'first page, for documents' },
        endPage: { type: 'integer' },
      }, required: ['name'] },
      // Delegates to the existing read_project_file branch so document paging,
      // instruction skills and the result cap behave identically to the
      // built-in tool rather than drifting into a second implementation.
      handler: async (args, ctx) => ports.readProjectFile(requireProject(ports, ctx), args),
    },
    project_search: {
      description: "Search this project's files for a phrase and return matching excerpts.",
      schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: async (args, ctx) => {
        const project = requireProject(ports, ctx);
        const query = String(args.query || '').trim();
        if (!query) throw new Error('a query is required');
        // An empty result from a deployment with no index reads to the model as
        // "there is nothing there", which is a different and wrong answer.
        if (!ports.ragAvailable()) return 'Retrieval is not available on this deployment, so the project could not be searched. Read a file by name instead.';
        const hits = await ports.search(project.id, query, ctx.userId);
        // A stale index row can outlive the file it came from; the project's
        // current file list is the authority on what is attached.
        const present = new Set((project.files || []).map((f) => f.name));
        const usable = hits.filter((h) => present.has(h.file));
        if (!usable.length) return `Nothing in this project matched "${query}".`;
        return clip(usable.map((h) => `[from ${h.file}] ${h.body}`).join('\n\n'));
      },
    },

    // ── Project writes: gated, and narrow on purpose ─────────────────────
    project_create_file: {
      description: 'Create a new text file in this project.',
      write: true,
      schema: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } }, required: ['name', 'text'] },
      handler: async (args, ctx) => {
        const project = requireProject(ports, ctx);
        const name = cleanName(args.name);
        const text = String(args.text == null ? '' : args.text);
        if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('that text is too large to write in one call');
        if ((project.files || []).some((f) => f.name === name)) throw new Error(`"${name}" already exists. Use project_append_file or project_replace_text.`);
        await ports.writeTextFile(project, name, text);
        return `Created "${name}" (${text.length} chars).`;
      },
    },
    project_append_file: {
      description: 'Add text to the end of an existing project text file.',
      write: true,
      schema: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } }, required: ['name', 'text'] },
      handler: async (args, ctx) => {
        const project = requireProject(ports, ctx);
        const file = findFile(project, cleanName(args.name));
        assertEditable(file);
        const addition = String(args.text == null ? '' : args.text);
        if (!addition) throw new Error('there is nothing to append');
        const next = `${file.content || ''}${(file.content || '').endsWith('\n') || !file.content ? '' : '\n'}${addition}`;
        if (Buffer.byteLength(next) > MAX_TEXT_BYTES) throw new Error('that would make the file too large to write in one call');
        await ports.writeTextFile(project, file.name, next);
        return `Appended ${addition.length} chars to "${file.name}".`;
      },
    },
    project_replace_text: {
      // Find/replace with an expected count, NOT a whole-file rewrite. A small
      // model asked to regenerate a long file silently drops parts of it, and
      // an approval card whose argument is the entire file is unreadable — so
      // the gate stops working exactly where it matters most.
      description: 'Replace exact text in a project file. Give expectedCount to require that many matches.',
      write: true,
      schema: { type: 'object', properties: {
        name: { type: 'string' },
        find: { type: 'string' },
        replace: { type: 'string' },
        expectedCount: { type: 'integer', description: 'how many matches you expect; defaults to 1' },
      }, required: ['name', 'find', 'replace'] },
      handler: async (args, ctx) => {
        const project = requireProject(ports, ctx);
        const file = findFile(project, cleanName(args.name));
        assertEditable(file);
        const find = String(args.find == null ? '' : args.find);
        if (!find) throw new Error('find must not be empty');
        const replace = String(args.replace == null ? '' : args.replace);
        const content = String(file.content || '');
        const parts = content.split(find);
        const found = parts.length - 1;
        const expected = args.expectedCount === undefined ? 1 : Number(args.expectedCount);
        if (!Number.isInteger(expected) || expected < 1) throw new Error('expectedCount must be a positive whole number');
        // Mismatch errors WITHOUT writing: the count is the model's statement
        // of what it believes the file contains, and a wrong belief is exactly
        // when not to edit.
        if (found !== expected) {
          throw new Error(found === 0
            ? `that exact text is not in "${file.name}", so nothing was changed`
            : `expected ${expected} match${expected === 1 ? '' : 'es'} but found ${found} in "${file.name}", so nothing was changed`);
        }
        const next = parts.join(replace);
        if (Buffer.byteLength(next) > MAX_TEXT_BYTES) throw new Error('that would make the file too large to write in one call');
        await ports.writeTextFile(project, file.name, next);
        return `Replaced ${found} occurrence${found === 1 ? '' : 's'} in "${file.name}".`;
      },
    },
  };
}

/** An ISO timestamp for `date` carrying the UTC offset of an IANA zone (server zone if absent). */
function isoWithOffset(date, timeZone) {
  if (!timeZone) {
    const offset = -date.getTimezoneOffset();
    return formatIso(date, offset);
  }
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date); }
  catch { throw new Error(`unknown IANA timezone "${timeZone}"`); }
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return formatIso(date, Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000));
}
function formatIso(date, offsetMinutes) {
  const local = new Date(date.getTime() + offsetMinutes * 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${local.toISOString().slice(0, 19)}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

module.exports = { createInternalTools, MAX_TEXT_BYTES, isoWithOffset };
