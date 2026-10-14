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
// down and never adds tools to chit-chat. Bounded:
//   - only boxes with at least one read tool (a box of writes only, such as sending mail or calendar
//     administration, stays a hand-picked Manual choice), at most MAX_ADDED per turn;
//   - a box holding the user's data (anything but PUBLIC_BOXES) only when the answering model is local
//     (the #815 rule): a cloud provider or cloud route never gets the user's Nextcloud through Automatic;
//   - Web search is not added beside a Nextcloud box unless the message asks for the web explicitly, so
//     private note text is not sent to a search service on a guess; a URL only in a short one-line
//     message (tool-gate prefetchableSearch), so a pasted email with a link is not fetched;
//   - every write still stops at the approval card, and one reachable only through an added box asks per
//     call even under "Allow for this chat" (chat.cjs).

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;
// Explicit requests to use the web. These alone add Web search beside a Nextcloud box.
const EXPLICIT_WEB_RE = /\b(?:search(?:\s+(?:the|on\s+the))?\s+(?:web|internet|online)|web\s*search|(?:on|from)\s+the\s+(?:web|internet)|(?:search|look(?:\s+it)?\s*up|find\s+it)\s+online|google(?!\s+(?:drive|docs?|sheets?|slides|calendar|photos|keep|mail))\s+(?:it|this|that|for)\b|browse\s+(?:the\s+)?(?:web|internet))\b/i;
// A question about the current state of the world. Qualified on purpose: a bare "current", "recent",
// "online" or "today's" fires on questions that need no web ("the current through a resistor", "a poem
// about today's sunset").
const WEB_RE = new RegExp([
  String.raw`\b(?:latest|newest)\b`,
  String.raw`\b(?:most\s+)?recent(?:ly)?\s+(?:news|releases?|versions?|updates?|events|changes)\b`,
  String.raw`\bcurrent(?:ly)?\s+(?:stable\s+)?(?:versions?|releases?|prices?|rates?|exchange\s+rates?|news|events|weather|status|president|prime\s+minister|ceo|champions?|lts)\b`,
  String.raw`\b(?:today|tonight|this\s+(?:week|month|year))'?s\s+(?:top\s+)?(?:news|headlines|weather|forecast|prices?|rates?|exchange\s+rates?|scores?|results|releases?)\b`,
  String.raw`\b(?:news|headlines|weather|forecast|exchange\s+rates?|stock\s+prices?|price\s+of)\b`,
  String.raw`\b(?:cite\s+(?:your\s+|the\s+)?sources?|with\s+sources?|source\s+urls?)\b`,
  String.raw`\blook\s*up\b`,
].join('|'), 'i');
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
// Boxes that hold no user data: Automatic may add them whichever provider answers.
const PUBLIC_BOXES = new Set(['web-search', 'offline-wikipedia']);
// #1646: boxes whose results hold no user data, so a hybrid cloud route may offer them. An allow-list:
// every other box (storage, Nextcloud, Drive, Project documents, the Diary, any connector or MCP box
// this server learns about later) counts as private-data and fails closed. `core` is the clock and
// the project-file reader; the reader is private-data and is taken out of it (PRIVATE_CORE_TOOLS).
const CLOUD_SAFE_BOXES = new Set(['core', 'web-search', 'web-crawl', 'offline-wikipedia']);
const PRIVATE_CORE_TOOLS = new Set(['read_project_file']);
// #1592 review: boxes whose results the health pre-rule may skip on a cloud route: search results and
// offline Wikipedia are public reference text. web-crawl is NOT here: a fetched page can be the user's
// own document behind a share link, so its results keep the health rule (#1647: when in doubt, stay local).
const HEALTH_PUBLIC_BOXES = new Set(['web-search', 'offline-wikipedia']);
/** Whether a toolbox may be offered to a hybrid cloud route that has no per-chat allowCloud grant. */
function isPrivateDataBox(id) { return !CLOUD_SAFE_BOXES.has(id); }

const possessive = (words) => new RegExp(`\\b(?:my|our)\\s+(?:[\\w-]+\\s+){0,2}(?:${words})\\b`, 'i');
const bare = (words) => new RegExp(`\\b(?:${words})\\b`, 'i');

/** Whether a message asks for current information from the web (a short one-line message with a URL counts). */
function wantsWeb(message) {
  const text = typeof message === 'string' ? message.slice(0, 4000) : '';
  if (!text.trim()) return false;
  // A link inside pasted text (an email, a long multi-line message) is never fetched on a word like
  // "latest" alone: the gate prefetches a URL first and without a length limit, so only an explicit
  // request to use the web adds Web search there (#1550 review).
  const hasUrl = URL_RE.test(text), shortSearch = require('./tool-gate.cjs').prefetchableSearch(text);
  if (hasUrl && !shortSearch) return EXPLICIT_WEB_RE.test(text);
  if (EXPLICIT_WEB_RE.test(text) || WEB_RE.test(text)) return true;
  return hasUrl && shortSearch;
}

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
  // Beside the user's own Nextcloud data, the web only when asked for by name: "the latest in my notes"
  // must not send note text to a search service.
  const private_ = out.some((id) => id.startsWith('nextcloud-'));
  if (private_ ? EXPLICIT_WEB_RE.test(text) : wantsWeb(text)) out.push('web-search');
  return out;
}

/** Whether one box may be added: not a connector, at least one read tool, local-only if it holds user data,
 *  and ready for this account. `ready` throwing counts as not ready. */
function automaticEligible(box, { connectorBoxes, isWriteTool, ready, privateData }) {
  if (!box || typeof box.id !== 'string' || connectorBoxes.has(box.id)) return false;
  if (!privateData && !PUBLIC_BOXES.has(box.id)) return false;
  const names = (box.tools || []).map((t) => t && t.function && t.function.name).filter((n) => typeof n === 'string');
  if (!names.some((n) => !isWriteTool(n))) return false;
  try { return ready(box) === true; } catch { return false; }
}

/**
 * #1550: the boxes this Automatic turn adds to its own list. The message is matched first; only the boxes it
 * names are looked up and checked, so `ready` (the account's storage read) runs only for those.
 *
 * @param {{ message: string, base?: string[], boxes: object[], connectorBoxes: Set<string>,
 *           isWriteTool: (name: string) => boolean, ready?: (box: object) => boolean,
 *           privateData?: boolean, max?: number }} input
 *   `boxes` is allToolboxes() (offered and discovered); `privateData` is true only when the answering
 *   model is local (no external provider, no cloud route, the default provider).
 * @returns {string[]}
 */
function automaticAdditions({ message, base = [], boxes, connectorBoxes, isWriteTool, ready = () => true, privateData = false, max = MAX_ADDED }) {
  const have = new Set(base);
  const byId = new Map((Array.isArray(boxes) ? boxes : []).filter((b) => b && typeof b.id === 'string').map((b) => [b.id, b]));
  const out = [];
  for (const id of automaticBoxesFor(message)) {
    if (out.length >= max) break;
    if (have.has(id) || out.includes(id) || !byId.has(id)) continue;
    if (automaticEligible(byId.get(id), { connectorBoxes, isWriteTool, ready, privateData })) out.push(id);
  }
  return out;
}

/**
 * The order a turn's boxes are resolved in (resolveTools spends the tool cap and token budget in this order):
 * the default boxes and the Project documents box first (`head`), then the boxes Automatic added, then the
 * rest. So an added box can never push out the core tools.
 */
function orderWithAdditions(ids, added, head) {
  const isHead = (id) => head.includes(id) && !added.includes(id);
  return [...ids.filter(isHead), ...added.filter((id) => ids.includes(id)), ...ids.filter((id) => !isHead(id) && !added.includes(id))];
}

/** A storage connection whose app password the Nextcloud MCP server can be handed (mcp-wiring mcpAuthHeaders). */
function nextcloudStorageConnected(storage) {
  return !!storage && ['nextcloud', 'webdav'].includes(storage.kind) && !!storage.username && !!storage.secret;
}

/**
 * #1550: per request, whether Automatic may add a box for `user`. A box on the `nextcloud` MCP server needs the
 * account's own Nextcloud connection with an allowed origin, the same test the tool call makes before forwarding
 * the credential; without it the turn gets the "connect Nextcloud" note instead of a tool that can only fail.
 * Other boxes are ready once this server offers them (the sign-in and Diary add-on filters run later). The
 * storage is read at most once per checker, and only when a Nextcloud box is asked about. Fails closed.
 *
 * @param {{ getStorage: (userId: string) => object, originAllowed: (url: string) => boolean }} deps
 * @returns {(user: { id: string }|null) => (box: { server?: string }) => boolean}
 */
function createAutomaticToolsReady({ getStorage, originAllowed }) {
  return function automaticToolsReady(user) {
    let nextcloud;
    const nextcloudReady = () => {
      if (nextcloud !== undefined) return nextcloud;
      nextcloud = false;
      if (!user || typeof user.id !== 'string') return nextcloud;
      try {
        const storage = getStorage(user.id);
        nextcloud = nextcloudStorageConnected(storage) && originAllowed(storage.baseUrl) === true;
      } catch { nextcloud = false; }
      return nextcloud;
    };
    return (box) => !box || box.server !== 'nextcloud' || nextcloudReady();
  };
}

module.exports = { toolsModeOf, initialToolsMode, gateSaysToolNeeded, toolCapableRoute, FALLBACK_ROLES,
  automaticBoxesFor, automaticEligible, automaticAdditions, orderWithAdditions, wantsWeb, MAX_ADDED, PUBLIC_BOXES,
  CLOUD_SAFE_BOXES, PRIVATE_CORE_TOOLS, HEALTH_PUBLIC_BOXES, isPrivateDataBox,
  nextcloudStorageConnected, createAutomaticToolsReady };
