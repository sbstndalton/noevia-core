'use strict';
// How a project or free chat picks its tools (Automatic or Manual), and what Automatic does when the
// routed model cannot take tools. Pure: the caller supplies the project record and the template check.
//
// toolsModeOf mirrors the web (noevia-web src/tools-mode.ts): an explicit toolsMode wins; without one,
// a project that holds its own toolbox list is Manual, and one without a list is Automatic. Records
// stored before toolsMode existed keep the meaning they had (a list means Manual), so reading an old
// project never changes its tool set.

/** 'auto' (Automatic: the default set, plus what a message needs (#1550), narrowed per message) or
 *  'manual' (the project's own list). */
function toolsModeOf(project) {
  if (project && (project.toolsMode === 'auto' || project.toolsMode === 'manual')) return project.toolsMode;
  return project && Array.isArray(project.toolboxes) ? 'manual' : 'auto';
}

/** The mode a new project starts in (#1522). Automatic, unless the request chose Manual: an explicit
 *  toolsMode, or its own toolbox list (an API caller that sends a list has picked its tools by hand,
 *  and Automatic would silently ignore that list). The web sends neither, so it gets Automatic. */
function initialToolsMode(body) {
  if (body && (body.toolsMode === 'auto' || body.toolsMode === 'manual')) return body.toolsMode;
  return body && Array.isArray(body.toolboxes) ? 'manual' : 'auto';
}

/**
 * #1550: whether the tool gate's verdict (tool-gate.cjs evaluate) says this turn needs a tool. A rule or
 * the decision service picking a tool is `decision` = { tool, mode }. Everything else is not a verdict
 * that a tool is needed: 'none' (chit-chat, low confidence, a timeout, an error, the gate off, or no gate
 * at all). An unavailable gate therefore keeps the routed model.
 */
function gateSaysToolNeeded(gate) {
  return !!gate && !!gate.decision && gate.decision !== 'none';
}

// Roles tried, in order, when the routed role's model cannot take tools (#1550): Smart first, the
// model meant for tool work; then Code, then Fast. The routed role itself is never retried.
const FALLBACK_ROLES = ['smart', 'code', 'fast'];

/**
 * #1550: Automatic tools on a routed model whose chat template cannot take tools would be answered
 * without them. Keep the model when it can take tools (or when its template is unknown, which the
 * template gate allows); otherwise move the turn to the first tool-capable role model.
 *
 * @param {{ model: string, routedRole: string|null, roles: Record<string, string|null|undefined>,
 *           allowsTools: (model: string) => Promise<boolean> }} input
 * @returns {Promise<{ rerouted: boolean, model: string, role: string|null }>} `rerouted: false` keeps
 *   the routed model; the caller's template gate then sends the "answers without tools" notice.
 */
async function toolCapableRoute({ model, routedRole, roles = {}, allowsTools }) {
  if (await allowsTools(model)) return { rerouted: false, model, role: routedRole };
  for (const role of FALLBACK_ROLES) {
    const candidate = roles[role];
    if (!candidate || role === routedRole || candidate === model) continue;
    if (await allowsTools(candidate)) return { rerouted: true, model: candidate, role };
  }
  return { rerouted: false, model, role: routedRole };
}

// ── #1550: what Automatic adds for one message ─────────────────────────────
//
// Automatic's own list is the operator default (core) plus the account's connected connectors
// (toolboxes-permitted.cjs). Tool routing and the tool gate only narrow or pick from that list, so
// without this step an Automatic chat could never search the web or reach Nextcloud: the model said
// it could not browse, and the #1520/#1521 notes pointed at a "+ > Tools" list Automatic does not show.
//
// Here a message that plainly needs a box adds it for that turn, from the boxes this server offers
// to this account. Deterministic (no model, no embedding), so it works when the search model is
// down and never adds tools to chit-chat. Bounded: only boxes with at least one read tool (a box of
// writes only, such as sending mail or calendar administration, stays a hand-picked Manual choice),
// at most MAX_ADDED per turn, and every write still stops at the approval card.

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;
// A question about the current state of the world, or an explicit request to search. Same words as
// tool-route-notes TIME_SENSITIVE (the note that says Web search is off), plus explicit search verbs.
const WEB_RE = /\b(latest|newest|current(?:ly)?|today'?s?|tonight|right now|this (?:week|month|year)|as of|up[- ]to[- ]date|recent(?:ly)?|news|headlines?|weather|forecast|exchange rate|stock price|price of|search(?:\s+(?:the|on\s+the))?\s+(?:web|internet|online)|web\s*search|on the (?:web|internet)|online|look\s*up|google(?!\s+(?:drive|docs?|sheets?|slides|calendar|photos|keep|mail))|browse|cite (?:your |the )?sources?|with sources?|source urls?)\b/i;
const NEXTCLOUD_RE = /\bnext\s?cloud\b/i;
// "my calendar", "our shared notes", "my Nextcloud tasks": a possessive or the Nextcloud name points
// the app word at the user's own data rather than at the topic in general.
const NEXTCLOUD_APPS = [
  { box: 'nextcloud-notes', words: 'notes?' },
  { box: 'nextcloud-calendar', words: 'calendars?|appointments?|meetings?|events?|agenda|schedule' },
  { box: 'nextcloud-tasks', words: 'tasks?|to-?dos?|reminders?' },
  { box: 'nextcloud-contacts', words: 'contacts?|address\\s*books?' },
  { box: 'nextcloud-mail', words: 'e-?mails?|mail|inbox' },
];
const FILES_WORDS = 'files?|folders?|director(?:y|ies)|documents?|docs';
const WIKIPEDIA_RE = /\bwikipedia\b/i;
const MAX_ADDED = 3;

const possessive = (words) => new RegExp(`\\b(?:my|our)\\s+(?:[\\w-]+\\s+){0,2}(?:${words})\\b`, 'i');
const bare = (words) => new RegExp(`\\b(?:${words})\\b`, 'i');

/** The box ids a message plainly needs, most specific first. Pure; the caller checks availability. */
function automaticBoxesFor(message) {
  const text = typeof message === 'string' ? message.slice(0, 4000) : '';
  if (!text.trim()) return [];
  const out = [];
  const named = NEXTCLOUD_RE.test(text);
  let app = false;
  for (const { box, words } of NEXTCLOUD_APPS) {
    if ((named && bare(words).test(text)) || possessive(words).test(text)) { out.push(box); app = true; }
  }
  // Nextcloud named with no app means its files ("list my Nextcloud top folders"); "my files" too.
  if ((named && (!app || bare(FILES_WORDS).test(text))) || possessive(FILES_WORDS).test(text)) out.push('nextcloud-files');
  if (WIKIPEDIA_RE.test(text)) out.push('offline-wikipedia');
  if (URL_RE.test(text) || WEB_RE.test(text)) out.push('web-search');
  return out;
}

/**
 * The boxes Automatic may add on this server for this account: offered (allToolboxes, so already
 * filtered by ENABLED_TOOLBOXES and discovery), not an account connector (those join through
 * connectedBoxes), holding at least one read tool, and ready for this account (`ready`, e.g. its
 * Nextcloud connection). The Diary add-on and sign-in filters still apply after (requestToolboxes).
 *
 * @param {{ boxes: object[], connectorBoxes: Set<string>, isWriteTool: (name: string) => boolean,
 *           ready?: (box: object) => boolean }} input
 * @returns {Set<string>}
 */
function automaticPool({ boxes, connectorBoxes, isWriteTool, ready = () => true }) {
  const out = new Set();
  for (const box of Array.isArray(boxes) ? boxes : []) {
    if (!box || typeof box.id !== 'string' || connectorBoxes.has(box.id)) continue;
    const names = (box.tools || []).map((t) => t && t.function && t.function.name).filter((n) => typeof n === 'string');
    if (!names.some((n) => !isWriteTool(n))) continue;
    let ok = false;
    try { ok = ready(box) === true; } catch { ok = false; }
    if (ok) out.add(box.id);
  }
  return out;
}

/**
 * #1550: the boxes this Automatic turn adds to its own list, in the order they should be resolved
 * (before the base list, so the box the message asked for wins the tool cap and token budget).
 *
 * @param {{ message: string, base: string[], pool: Set<string>, max?: number }} input
 * @returns {string[]}
 */
function automaticAdditions({ message, base = [], pool, max = MAX_ADDED }) {
  const have = new Set(base);
  const out = [];
  for (const id of automaticBoxesFor(message)) {
    if (out.length >= max) break;
    if (pool.has(id) && !have.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** A storage connection whose app password the Nextcloud MCP server can be handed (mcp-wiring mcpAuthHeaders). */
function nextcloudStorageConnected(storage) {
  return !!storage && ['nextcloud', 'webdav'].includes(storage.kind) && !!storage.username && !!storage.secret;
}

/**
 * #1550: whether Automatic may add `box` for `user`. A box on the `nextcloud` MCP server needs the account's own
 * Nextcloud connection with an allowed origin, the same test the tool call makes before forwarding the credential;
 * without it the turn gets the "connect Nextcloud" note instead of a tool that can only fail. Other boxes are ready
 * once this server offers them (the sign-in and Diary add-on filters run later, per request). Fails closed.
 *
 * @param {{ getStorage: (userId: string) => object, originAllowed: (url: string) => boolean }} deps
 * @returns {(user: { id: string }|null, box: { server?: string }) => boolean}
 */
function createAutomaticToolsReady({ getStorage, originAllowed }) {
  return function automaticToolsReady(user, box) {
    if (!box || box.server !== 'nextcloud') return true;
    if (!user || typeof user.id !== 'string') return false;
    try {
      const storage = getStorage(user.id);
      return nextcloudStorageConnected(storage) && originAllowed(storage.baseUrl) === true;
    } catch { return false; }
  };
}

module.exports = { toolsModeOf, initialToolsMode, gateSaysToolNeeded, toolCapableRoute, FALLBACK_ROLES,
  automaticBoxesFor, automaticPool, automaticAdditions, MAX_ADDED, nextcloudStorageConnected, createAutomaticToolsReady };
