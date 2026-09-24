'use strict';
// ── Toolboxes and built-in tools ──────────────────────────────────────────
// Everything about WHICH tools a chat is offered and how the built-in ones
// run: the core box, the per-model count cap and token budget, the resolver,
// the read/write classification that gates approvals, and the executor for
// noevia's own tools. MCP boxes arrive through the injected `mcpBoxes`; the
// MCP executor is injected too, so this module never touches the network.
//
// Pure parts (estimateToolTokens, toolCapFor, the constants) are exported at
// module level. Everything that needs live state comes from createToolboxes,
// so tests can hand it a fake discovery result and a fake prefill store
// without booting the server.

// ── Built-in tools (Pi-style JSON-Schema schema, master step 13) ──────────
// Two safe built-ins to start. The schema follows the OpenAI-compatible
// function-calling format every provider speaks (and pi-ai uses TypeBox to
// produce exactly this shape). Results return to the model as role:'tool'
// messages keyed by tool_call_id — the wire form of pi's toolResult.
const CORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description:
        'Get the current date and time on the server, optionally in a specific IANA timezone (e.g. Europe/Berlin). Use whenever freshness, "today", or a timezone matters.',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'Optional IANA timezone name' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_project_file',
      description:
        'Read an attached source or enabled instruction skill by exact name. Skills support offset pagination. For PDFs use startPage/endPage (up to 5 pages) and offset to read beyond summaries; results include page and version references.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exact file name, e.g. notes.md' }, startPage: { type: 'integer', minimum: 1 }, endPage: { type: 'integer', minimum: 1 }, offset: { type: 'integer', minimum: 0 } },
        required: ['name'],
      },
    },
  },
];

const DELEGATED_FAILURE = /^ERROR(?: from tool)?: /;
const TOOL_RESULT_CAP = 8000; // chars — protect the context window

// A tool definition is re-sent on EVERY turn, so its size is a recurring cost.
//
// Estimating it as chars/4 is wrong twice over. The provider does not put the
// JSON on the wire as-is — llama.cpp's chat template re-renders every tool —
// and there is a FIXED preamble for enabling tool calling at all, which a flat
// multiplier cannot express. That fixed cost is why a tiny box looks wildly
// expensive per character while a large one looks cheap.
//
// Measured directly against the live endpoint on 2026-09-08 (same message,
// only `tools` differing, so nothing else contaminates the comparison):
//
//   box        chars   actual   model    err
//   core         719      390     440   +13%
//   notes      2,349      883     892    +1%
//   talk       2,749      895   1,004   +12%
//   calendar  15,535    4,512   4,555    +1%
//   files      8,170    2,190   2,509   +15%
//   contacts   6,038    1,650   1,917   +16%
//   deck       8,415    2,533   2,578    +2%
//
// So: tokens ≈ TOOL_PREAMBLE_TOKENS + chars/3.6. It never under-predicts and
// is at worst 16% high, which is the right direction for a budget — but only
// just. An earlier version of this used a flat 2.1x factor derived from the
// core box alone, which over-predicted the MCP boxes by up to 2x and made
// nc_calendar_create_event unreachable despite it fitting comfortably. An
// estimate that is too high silently withholds tools the hardware can afford,
// which is a quieter failure than one that is too low, not a safer one.
const TOOL_PREAMBLE_TOKENS = 240; // paid once per request that sends any tool
const TOOL_CHARS_PER_TOKEN = 3.6;

// The MARGINAL cost of these tools — the fixed preamble is deliberately not
// included, so per-box numbers stay additive and the caller adds the preamble
// exactly once for the whole request.
function estimateToolTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0; // no tools, no cost
  return Math.round(JSON.stringify(tools).length / TOOL_CHARS_PER_TOKEN);
}

// How many tools a model can be handed before the catalogue crowds out the
// conversation. This is a hardware/capability question, not a "what does this
// work need" question — which is precisely why box *selection* is per-project
// and only the cap looks at the model.
const TOOL_CAP_DEFAULT = 24;
const TOOL_CAP_SMALL = 12;

// The count cap is a separate question from the token budget: it guards
// against handing a small model too many CHOICES, which degrades tool
// selection accuracy regardless of how cheap the definitions are.
function toolCapFor(model) {
  // Parameter count in the model id (…-9B-…, …-4b-it…) is the only signal
  // available here, and local GGUF names carry it by convention. An
  // unrecognised name gets the roomier default: wrongly withholding tools is
  // a worse failure than sending a few more than ideal.
  const m = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(String(model || ''));
  if (m && Number(m[1]) <= 12) return TOOL_CAP_SMALL;
  return TOOL_CAP_DEFAULT;
}

// The budgets and the prefill target are explained where they are used, in createToolboxes.
const TOOL_TOKEN_BUDGET_DEFAULT = 8000;
const TOOL_TOKEN_BUDGET_SMALL = 5000;
const TOOL_PREFILL_TARGET_MS = 14000;

/**
 * @param {object} deps
 * @param {object[]} [deps.boxes]         extra built-in boxes (Kiwix, Drive) in offer order
 * @param {object|null} [deps.kiwixTools] { names:Set, execute(name,args) } or null
 * @param {object|null} [deps.driveTools] { names:Set, connected(user), execute(user,name,args) } or null
 * @param {() => object[]} deps.mcpBoxes  boxes MCP discovery found (live, not copied)
 * @param {() => Map} deps.mcpTools       name -> { readOnly, serverId } from discovery
 * @param {(id:string) => boolean} deps.offered   the ENABLED_TOOLBOXES filter
 * @param {object} deps.prefill           { budgetFor(model, targetMs), rateFor(model) }
 * @param {{run(store, fn), getStore()}} deps.scope   the per-request AsyncLocalStorage; { authn, workspace }
 * @param {(id:string) => object|null} deps.getProject
 * @param {object} deps.documentSources   { readPages(ws, projectId, file, start, end, offset, cap), notice(file) }
 * @param {() => object} deps.workspace
 * @param {(name, args) => Promise<string>} deps.executeMcp   runs a discovered MCP tool; reads the project it acts for from scope
 */
function createToolboxes({
  boxes = [], kiwixTools = null, driveTools = null, mcpBoxes = () => [], mcpTools = () => new Map(),
  offered = () => true, prefill, scope = { run: (_s, fn) => fn(), getStore: () => undefined }, getProject = () => null,
  documentSources, workspace = () => null, executeMcp = async (name) => `ERROR: unknown tool "${name}"`,
} = {}) {
  // ── Toolboxes (master step 14) ────────────────────────────────────────────
  // Tools are no longer one flat global list. A *toolbox* is a named, selectable
  // set; a project picks which boxes it wants and the active list is resolved
  // per request. The seam exists so MCP-sourced tools can arrive as further
  // boxes without the chat loop changing shape — but it already earns its keep:
  // on the target hardware (a 9B model at ~14 tok/s) the catalogue is a real
  // per-turn cost paid on every message, not a rounding error.
  const TOOLBOXES = [
    {
      id: 'core',
      label: 'Core',
      description: 'Always-safe built-ins: the server clock, and full reads of this project\'s knowledge files.',
      source: 'builtin',
      tools: CORE_TOOLS,
      reads: ['get_current_time', 'read_project_file'],
    },
    ...boxes,
  ];

  const CONNECTOR_BOXES = new Set(['gdrive']);
  function connectedBoxes(user) { return user && driveTools && driveTools.connected(user) ? ['gdrive'] : []; }

  const DEFAULT_TOOLBOXES = ['core'];

  // Built-ins plus whatever MCP discovery found. Everything downstream — the
  // picker, the validator, the resolver — goes through here so an MCP box is
  // indistinguishable from a built-in one once it exists.
  function allToolboxes() {
    // Connector boxes are selected per account in chat, not by the operator's
    // ENABLED_TOOLBOXES list. Keep them resolvable even when omitted there.
    return [
      ...TOOLBOXES.filter((b) => CONNECTOR_BOXES.has(b.id) || offered(b.id)),
      ...mcpBoxes().filter((b) => offered(b.id)),
    ];
  }

  // A COUNT cap alone is the wrong unit, which only became clear once real MCP
  // tools arrived. Measured against the reference server: nc_calendar_create_event
  // is ~2,739 calibrated tokens while nc_notes_search_notes is 449. "12 tools"
  // therefore describes anything between ~250 and ~47,000 tokens of prompt. The
  // count cap still guards against overwhelming a small model with too many
  // CHOICES; this budget guards latency, which is the constraint that bites.
  //
  // The budget is NOT about running out of context. Measured 2026-09-08 on this
  // deployment: the model advertises a 262,144-token window and llama-server is
  // configured with n_ctx=32,768 — so context only becomes the limit at the full
  // 160-tool catalogue (39,791 tokens, which does 400). Everything below that
  // fits comfortably.
  //
  // What actually degrades is TIME TO FIRST TOKEN. Prefill runs at roughly
  // 360 tok/s (~2.75 ms/token) on this hardware, and the tool catalogue is
  // re-sent on EVERY message, so its cost is paid on every turn before the model
  // says a word:
  //
  //     0 tools      17 tok    0.2 s
  //     6 tools     924 tok    3.1 s
  //    12 tools   1,500 tok    4.5 s
  //    20 tools   4,161 tok   11.7 s
  //    30 tools   6,895 tok   21.2 s
  //
  // So the budget is really a latency target, and these numbers are it:
  // ~5,000 tokens is about 14 seconds of silence before the first word. That is
  // a lot, and it is the honest price of the full calendar box on this hardware
  // (measured: 4,512 tokens, 14.1 s). It is the dial to turn if turns feel slow.
  // Larger/remote models are not prefill-bound in the same way and get more.

  // What the budget is really expressing: how long the user waits, before the
  // model says anything, for the privilege of having tools available. The
  // catalogue is re-read on every message, so this is paid every turn.
  //
  // 14 seconds is a lot. It is the honest price of the full calendar box on this
  // hardware (4,512 tokens measured at ~360 tok/s prefill), and it is the dial to
  // turn if turns feel sluggish.

  // Log the fallback→measured switch once per model, not once per request.
  const announcedMeasured = new Set();

  function toolTokenBudgetFor(model) {
    // Measured, if we have watched enough real traffic for this model. This is
    // the honest answer: a budget in tokens derived from how fast THIS model on
    // THIS hardware actually reads, rather than from what its filename says.
    const measured = prefill.budgetFor(model, TOOL_PREFILL_TARGET_MS);
    if (measured) {
      if (!announcedMeasured.has(model)) {
        announcedMeasured.add(model);
        const rate = Math.round(prefill.rateFor(model) * 1000);
        console.log(`[prefill] ${model}: measured ~${rate} tok/s; tool budget is now ${measured} tokens for a ${TOOL_PREFILL_TARGET_MS}ms target (was a filename guess)`);
      }
      // Clamped so a freak measurement cannot hand a small model the whole
      // catalogue or starve a fast one down to nothing.
      return Math.max(1500, Math.min(measured, 16000));
    }
    // Fallback until measured: parameter count in the model id is the only
    // signal available, and local GGUF names carry it by convention. It is a
    // guess, and it is why the measurement above exists — but it has to be
    // something on the very first request, before any traffic has been seen.
    const m = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(String(model || ''));
    if (m && Number(m[1]) <= 12) return TOOL_TOKEN_BUDGET_SMALL;
    return TOOL_TOKEN_BUDGET_DEFAULT;
  }

  // Resolve a project's selection into the list actually sent upstream. Unknown
  // box ids are ignored rather than fatal — a box can vanish when an MCP server
  // goes away, and that must degrade to fewer tools, not to a broken chat. Over
  // the cap the list is truncated, but never silently: the dropped names come
  // back so the caller can log them.
  function resolveTools(project, model, skip = () => false) {
    // An absent key means a project predating toolboxes: fall back to core so
    // upgrading does not silently disarm existing projects. An empty ARRAY is a
    // deliberate choice — the operator unticked every box — and must be honoured,
    // or the UI checkbox would lie about what it does.
    const wanted = Array.isArray(project && project.toolboxes) ? project.toolboxes : DEFAULT_TOOLBOXES;
    const available = allToolboxes();
    const boxes = [];
    const candidates = [];
    const seen = new Set();
    for (const id of wanted) {
      const box = available.find((b) => b.id === id);
      if (!box) continue;
      boxes.push(box.id);
      for (const tool of box.tools) {
        const name = tool && tool.function && tool.function.name;
        if (!name || seen.has(name) || skip(name)) continue; // first box wins a name clash
        seen.add(name);
        candidates.push(tool);
      }
    }
    // Two independent limits; whichever binds first stops the list. Tools are
    // taken in selection order, so the box a user picked first keeps its tools
    // when the budget runs out — a stable, explainable rule beats picking the
    // cheapest tools and silently reshaping what the model can do.
    const cap = toolCapFor(model);
    const budget = toolTokenBudgetFor(model);
    const tools = [];
    const dropped = [];
    // Enabling tool calling at all costs a fixed preamble, so it is charged once
    // up front rather than smeared across the tools.
    let spent = candidates.length ? TOOL_PREAMBLE_TOKENS : 0;
    for (const tool of candidates) {
      const cost = estimateToolTokens([tool]);
      if (tools.length >= cap) { dropped.push(`${tool.function.name} (over ${cap}-tool cap)`); continue; }
      if (spent + cost > budget) { dropped.push(`${tool.function.name} (~${cost} tok, over ${budget} budget)`); continue; }
      tools.push(tool);
      spent += cost;
    }
    return { tools, dropped, boxes, cap, budget, estTokens: spent };
  }

  // ── Tool permissions (master step 16) ────────────────────────────────────
  //
  // Once a tool can create a calendar event or send a Talk message, a small
  // local model that hallucinates an argument has consequences that a wrong
  // sentence does not. Reads run automatically; writes need a human.
  //
  // The classification lives HERE, per toolbox, not in the MCP server, because
  // MCP cannot be trusted to supply it: annotations.readOnlyHint is present on
  // only 70 of the reference server's 160 tools and absent on 90. It is a useful
  // signal and a useless guarantee.
  //
  // So the rule is: a tool is a WRITE unless noevia explicitly says otherwise.
  // A new or unrecognised tool is therefore gated by default — the failure mode
  // of an unnecessary prompt is an annoyed user, and the failure mode of a
  // missing one is deleted data.
  function readOnlyToolNames() {
    const names = new Set();
    const writes = new Set();
    const boxes = allToolboxes();
    for (const box of boxes) {
      const reads = new Set(box.reads || []);
      for (const tool of box.tools || []) {
        const name = tool?.function?.name;
        if (name && !reads.has(name)) writes.add(name);
      }
    }
    // If two boxes reuse a name and either declares it a write, keep the
    // approval gate. An unoffered box cannot declare an offered tool safe.
    for (const box of boxes) for (const n of (box.reads || [])) if (!writes.has(n)) names.add(n);
    return names;
  }

  function isWriteTool(name) {
    if (!readOnlyToolNames().has(name)) return true; // unknown ⇒ write
    // Our manifest says read-only. If the server itself claims the tool writes,
    // believe the server: the hint is unreliable when it is ABSENT, but a
    // positive "this is not read-only" is information we should not override.
    const known = mcpTools().get(name);
    if (known && known.readOnly === false) {
      console.warn(`[tools] ${name} is listed read-only in noevia but the MCP server reports it writes; treating as a write`);
      return true;
    }
    return false;
  }

  // Accept only ids that name a real box, so a stale selection persisted by an
  // older client cannot accumulate junk in the project record.
  function sanitizeToolboxes(value) {
    if (!Array.isArray(value)) return null;
    const ids = value.filter((v) => typeof v === 'string' && !CONNECTOR_BOXES.has(v) && allToolboxes().some((b) => b.id === v));
    return [...new Set(ids)];
  }

  function toolboxSummaries() {
    return allToolboxes().filter((b) => !CONNECTOR_BOXES.has(b.id)).map((b) => ({
      id: b.id,
      label: b.label,
      description: b.description,
      source: b.source,
      toolCount: b.tools.length,
      estTokens: estimateToolTokens(b.tools),
    }));
  }

  async function runToolCall(project, name, rawArgs, allowed, signal, fail) {
    // A model can name a tool it was never offered — by hallucination, or from
    // a box the project has since deselected mid-conversation. Enforce the
    // resolved list here rather than trusting that whatever was sent upstream is
    // still what came back.
    if (allowed instanceof Set && !allowed.has(name)) {
      return fail(`ERROR: tool "${name}" is not enabled for this project`);
    }
    let args = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return fail(`ERROR: tool arguments were not valid JSON: ${String(rawArgs).slice(0, 200)}`);
    }
    // A syntactically valid JSON value like `null`, `42`, or `"x"` parses fine
    // but is not an arguments object; every tool below assumes it can read
    // properties off `args`, so treat anything else as a clean argument error
    // rather than letting it surface as an unhandled TypeError.
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return fail(`ERROR: tool arguments must be a JSON object: ${String(rawArgs).slice(0, 200)}`);
    }
    if (kiwixTools?.names.has(name)) return kiwixTools.execute(name, args);
    if (driveTools?.names.has(name)) return driveTools.execute(scope.getStore()?.authn?.user, name, args);
    if (name === 'get_current_time') {
      const tz = typeof args.timezone === 'string' && args.timezone ? args.timezone : undefined;
      const now = new Date();
      try {
        const formatted = tz
          ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(now)
          : now.toString();
        return `Current time: ${formatted}${tz ? ` (${tz})` : ''} | ISO: ${now.toISOString()}`;
      } catch {
        return fail(`ERROR: unknown IANA timezone "${tz}"`);
      }
    }
    if (name === 'read_project_file') {
      const wanted = typeof args.name === 'string' ? args.name : '';
      const files = (project && Array.isArray(project.files)) ? project.files : [];
      const f = files.find((x) => x.name === wanted);
      if (!f) {
        const names = files.map((x) => x.name).join(', ') || '(none attached)';
        return fail(`ERROR: no project file named "${wanted}". Available: ${names}`);
      }
      const instructionSkills = require('./instruction-skills.cjs');
      if (instructionSkills.inspect(f, project)) return instructionSkills.read(project, f, getProject(project.id), args.offset ?? 0, TOOL_RESULT_CAP);
      if (f.attachment?.state === 'stored') return `${f.name}: original stored; readable contents are unavailable. Contents have not been read.`;
      if (f.document && args.startPage !== undefined) {
        try {
          const out = documentSources.readPages(workspace(), project.id, f, args.startPage, args.endPage ?? args.startPage, args.offset ?? 0, TOOL_RESULT_CAP);
          return `${out.notice}\n${out.text}${out.nextOffset !== null ? '\nContinue with offset ' + out.nextOffset : ''}`;
        } catch (err) { return fail('ERROR: ' + err.message); }
      }
      const warning = documentSources.notice(f);
      return `${warning ? warning + "\n" : ""}File "${f.name}" (${f.content.length} chars):\n\n${f.content.slice(0, TOOL_RESULT_CAP)}${f.content.length > TOOL_RESULT_CAP ? '\n…[truncated]' : ''}`;
    }
    // Not a built-in: if the name came from a discovered MCP box, the injected
    // executor runs it there. The project this call acts for travels in the
    // request scope, EXTENDING the current store rather than replacing it, so
    // the workspace and authn the rest of the call depends on survive — and
    // two interleaved chats each keep their own project (see the scope test).
    if (mcpTools().has(name)) {
      return scope.run({ ...scope.getStore(), internalCallProject: project || null }, () => executeMcp(name, args, signal));
    }
    return fail(`ERROR: unknown tool "${name}"`);
  }

  // Returns the tool's text. `outcome.failed` (optional out-parameter) is set
  // explicitly: built-in errors flag themselves; delegated executors (Kiwix,
  // Drive, MCP) report failure with their own fixed prefixes ("ERROR: " /
  // "ERROR from tool: "), matched exactly and case-sensitively, so a successful
  // result that merely begins with the word "Error" is never a failure.
  async function executeToolCall(project, name, rawArgs, allowed, signal, outcome = {}) {
    let flagged = false;
    const fail = (text) => { flagged = true; return text; };
    const text = await runToolCall(project, name, rawArgs, allowed, signal, fail);
    outcome.failed = flagged || (typeof text === 'string' && DELEGATED_FAILURE.test(text));
    return text;
  }

  return {
    TOOLBOXES, CONNECTOR_BOXES, DEFAULT_TOOLBOXES, connectedBoxes, allToolboxes,
    toolTokenBudgetFor, resolveTools, readOnlyToolNames, isWriteTool, sanitizeToolboxes,
    toolboxSummaries, executeToolCall,
  };
}

module.exports = {
  CORE_TOOLS, TOOL_RESULT_CAP, TOOL_PREAMBLE_TOKENS, TOOL_CHARS_PER_TOKEN, TOOL_CAP_DEFAULT, TOOL_CAP_SMALL,
  TOOL_TOKEN_BUDGET_DEFAULT, TOOL_TOKEN_BUDGET_SMALL, TOOL_PREFILL_TARGET_MS,
  estimateToolTokens, toolCapFor, createToolboxes,
};
