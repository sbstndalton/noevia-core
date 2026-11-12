'use strict';
// The coworker conversation's one native tool, `space_page_save` (sbstndalton/noevia#2446, slice 4b).
// Registration only: the tool's definition, where it is offered, and the loopback call to the Rust
// front, which owns every grant, limit and the same-draft rule (noevia-rs server-specialists
// tools.rs, `POST /v1/specialists/page-save` on the project store, the store secret as
// project-store-client.cjs sends it). Nothing here decides what may be saved or where.
const NAME = 'space_page_save';
// A coworker's hidden backing project (noevia-rs backing.rs SPECIALIST_PREFIX). The tool is offered
// only in a conversation of that project; the front still checks the chat and the project are one
// coworker's own, so a made-up id gets nothing.
const PROJECT_PREFIX = 'specialist-';
// A write that needs a person to look at it every time: no "Allow for this chat", no account policy
// that lets it run unasked (chat.cjs and approvals.cjs consult this).
const NEVER_STANDING = new Set([NAME]);

const TOOL = Object.freeze({
  type: 'function',
  function: {
    name: NAME,
    description: 'Save a finished draft as a page in one of your Spaces. The person reviews the full draft and approves before anything is saved. Use it when they ask you to write something down or keep it. Saving the same draft again returns the same page.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: { type: 'string', description: 'Optional: the id of one of your Spaces. Leave it out to use your default Space.' },
        title: { type: 'string', description: 'The page title, one line.' },
        content: { type: 'string', description: 'The whole page, as Markdown.' },
      },
      required: ['title', 'content'],
    },
  },
});

const appliesTo = (project) => !!project && typeof project.id === 'string' && project.id.startsWith(PROJECT_PREFIX);
const neverStanding = (name) => NEVER_STANDING.has(name);

/** The message the model reads for a refusal; always an `ERROR: ` result, so the loop marks the call failed. */
const refusal = (text) => {
  const t = String(text || 'The page was not saved').trim().replace(/\.$/, '');
  return `ERROR: ${t}.${/nothing was saved/i.test(t) ? '' : ' Nothing was saved.'}`;
};

/**
 * @param {{ specialistPageSave(payload: object): Promise<{status:number, body:any}> }} deps.store  project-store-client.cjs
 */
function createPageSave({ store }) {
  async function execute(project, args, { user, chatKey } = {}) {
    if (!appliesTo(project)) return `ERROR: ${NAME} is only available in a coworker's conversation.`;
    const userId = user && typeof user.id === 'string' ? user.id : (typeof user === 'string' ? user : '');
    if (!userId || typeof chatKey !== 'string' || !chatKey) return refusal('This conversation could not be identified');
    if (typeof args.title !== 'string' || typeof args.content !== 'string') return refusal('title and content are required');
    if (args.spaceId !== undefined && typeof args.spaceId !== 'string') return refusal('spaceId must be a text id');
    let res;
    try {
      res = await store.specialistPageSave({
        user: userId, projectId: project.id, chatId: chatKey,
        ...(args.spaceId ? { spaceId: args.spaceId } : {}), title: args.title, content: args.content,
      });
    } catch { return refusal('The page store is unavailable'); }
    const body = res && res.body;
    if (res && res.status === 200 && body && typeof body.pageId === 'string' && typeof body.link === 'string') {
      return JSON.stringify({ pageId: body.pageId, spaceId: body.spaceId, title: body.title, link: body.link });
    }
    if (res && res.status === 404) return refusal('This conversation is not a coworker\'s');
    if (res && res.status >= 400 && res.status < 500 && body && typeof body.error === 'string') return refusal(body.error);
    return refusal('The page store could not save it');
  }
  return Object.freeze({ NAME, TOOL, appliesTo, execute, neverStanding });
}

module.exports = { NAME, TOOL, PROJECT_PREFIX, NEVER_STANDING, appliesTo, neverStanding, createPageSave };
