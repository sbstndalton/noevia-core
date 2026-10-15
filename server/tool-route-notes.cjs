'use strict';
// What the model is told about this chat's tools when the message depends on them (#1520, #1521).
//
// #1520: a request that names a storage connector must go to that connector's tools, and a named
// connector that is off for this chat must be said so, not replaced by another storage (a Nextcloud
// request answered from Google Drive). Each connector's tools are named, so the model can tell them apart.
// #1521: a time-sensitive question with Web search off must say the answer cannot be verified now and
// suggest turning Web search on, not claim the model cannot browse at all.
//
// Only notes are produced. Nothing here offers a tool, widens a permission or changes what the gate
// allows; the chat loop still decides what runs. Empty string when no note applies, so an ordinary
// chat gets exactly the system text it had before.

const CONNECTORS = [
  { label: 'Nextcloud Files', boxId: 'nextcloud-files', prefix: 'nc_webdav_', named: /\bnextcloud\b/i },
  { label: 'Google Drive', boxId: 'gdrive', prefix: 'drive_', named: /\bgoogle\s+drive\b|\bmy\s+drive\b|\bthe\s+drive\b/i },
];
const WEB_BOX = 'web-search';
// #1786: words that make a message about the person's own stored files. Without one (and with no connector named),
// a message the tool gate judged to need no tool is not a reason to search storage.
const ABOUT_FILES = /\b(files?|folders?|documents?|docs?|pdfs?|spreadsheets?|sheets?|slides?|notes?|attachments?|uploads?|uploaded|saved|stored|drive|nextcloud|webdav|dav)\b/i;
const TIME_SENSITIVE = /\b(latest|newest|current(?:ly)?|today|tonight|right now|this (?:week|month|year)|as of|up[- ]to[- ]date|recent(?:ly)?|news|weather|exchange rate|stock price)\b/i;

/**
 * @param {object} input
 * @param {string} input.message        the user's message for this turn
 * @param {Iterable<string>} input.offered   box ids this request carries (requestToolboxes)
 * @param {Iterable<string>} input.onServer  box ids this server offers at all (allToolboxes)
 * @param {boolean} [input.automatic]        Tools: Automatic (#1550). It shows no tool list to tick, and it already
 *   adds Web search and a named Nextcloud when they are usable, so what is missing is a connection, not a tick.
 *   Its web note follows the Automatic web rule (tools-mode.cjs automaticBoxesFor), not the wider TIME_SENSITIVE.
 * @param {boolean} [input.localModel]       Automatic only: the answering model is local. Nextcloud is never added
 *   for a cloud model, so that is what the note says then.
 * @param {boolean} [input.gateNone]         #1786: the tool gate ran on this request and picked no tool.
 * @returns {string} the note for the system text, or '' when none applies
 */
function toolRouteNotes({ message, offered, onServer, automatic = false, localModel = true, gateNone = false }) {
  const text = typeof message === 'string' ? message : '';
  const on = new Set(offered || []);
  const exists = new Set(onServer || []);
  const notes = [];
  const onConnectors = CONNECTORS.filter((c) => on.has(c.boxId));
  for (const c of CONNECTORS) {
    if (!c.named.test(text)) continue;
    if (on.has(c.boxId)) {
      notes.push(`The user named ${c.label}. Answer that request with the ${c.label} tools (${c.prefix}*), and do not search another storage in its place.`);
    } else {
      const how = !automatic ? 'turn it on under + > Tools, or connect it under Settings > Connectors if it is not connected yet'
        : !localModel && c.boxId !== 'gdrive' ? 'your own files are only offered to a local model; choose a local model to use it'
        : 'connect it under Settings > Connectors, or ask the administrator to offer it on this server';
      notes.push(`The user named ${c.label}, but ${c.label} is not available in this chat (${how}). Do not use another storage's tools in its place: say that ${c.label} is not available in this chat.`);
    }
  }
  if (notes.length && onConnectors.length) {
    notes.push(`Connectors in this chat, and the tools that belong to each: ${onConnectors.map((c) => `${c.label} (${c.prefix}* tools)`).join('; ')}. Tools from one connector do not read another's files.`);
  }
  // #1786: a storage connector is offered (a connected Drive is on every Automatic turn), the gate picked no tool,
  // and the message names no connector and does not talk about files. A small model still searched Drive for a QA
  // tag in a packing-list request and then refused. It keeps the tools (the gate can be wrong), but is told plainly.
  if (gateNone === true && onConnectors.length && !notes.length && !ABOUT_FILES.test(text)) {
    notes.push(`This message does not ask about the person's stored files, so answer it directly from what you know: do not search ${onConnectors.map((c) => c.label).join(' or ')} for it. A label, code or ID in the message (such as a ticket number or a test tag) is not a file to look up. Use those tools only if the person asks about a file or folder of theirs.`);
  }
  const needsWeb = automatic ? require('./tools-mode.cjs').automaticBoxesFor(text).includes(WEB_BOX) : TIME_SENSITIVE.test(text);
  if (!on.has(WEB_BOX) && needsWeb) {
    notes.push(exists.has(WEB_BOX) && !automatic
      ? 'Web search is off for this chat, so you cannot check current information. For a question about the latest or current state of something, say that you cannot verify it right now, give what you knew at your training cutoff and say it may be out of date, and suggest the user turn Web search on under + > Tools to check. Do not say that you cannot browse the internet in general, and do not present an older answer as the latest.'
      : exists.has(WEB_BOX)
        ? 'Web search could not be used for this message, so you cannot check current information. For a question about the latest or current state of something, say that you cannot verify it right now, give what you knew at your training cutoff and say it may be out of date. Do not say that you cannot browse the internet in general, and do not present an older answer as the latest.'
        : 'Web search is not available on this server, so you cannot check current information. For a question about the latest or current state of something, say that you cannot verify it right now, give what you knew at your training cutoff and say it may be out of date. Do not present an older answer as the latest.');
  }
  return notes.join(' ');
}

module.exports = { toolRouteNotes, CONNECTORS, TIME_SENSITIVE, ABOUT_FILES };
