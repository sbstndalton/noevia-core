'use strict';
// Per-user interface preferences that should follow the person between browsers (#227, #230,
// #231): which events may raise a browser notification, how the composer sends, and the locale
// used for dates and numbers. Stored per user beside projects.json, like the other account-*.cjs
// records. Browser notification *permission* stays per device; only the event choices live here.
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'account-preferences.json';
// Only events noevia actually produces. Adding one here is what makes it appear in Settings.
const NOTIFICATION_EVENTS = ['replyFinished', 'approvalNeeded'];
const SEND_KEYS = ['enter', 'mod-enter'];
// Formats the app can honestly offer; the interface text itself is English only for now.
const LOCALES = ['system', 'en-GB', 'en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nb-NO', 'nl-NL', 'pt-BR', 'sv-SE'];

function defaults() {
  return { notifications: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, true])), sendKey: 'enter', locale: 'system', updatedAt: null };
}

function readable(message, status = 400) { return Object.assign(Error(message), { publicMessage: message, status }); }

function normalise(data) {
  const out = defaults();
  if (!data || typeof data !== 'object') return out;
  if (data.notifications && typeof data.notifications === 'object') {
    for (const e of NOTIFICATION_EVENTS) if (typeof data.notifications[e] === 'boolean') out.notifications[e] = data.notifications[e];
  }
  if (SEND_KEYS.includes(data.sendKey)) out.sendKey = data.sendKey;
  if (LOCALES.includes(data.locale)) out.locale = data.locale;
  if (Number.isFinite(data.updatedAt)) out.updatedAt = data.updatedAt;
  return out;
}

function read(dir) {
  try { return normalise(JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'))); } catch { return defaults(); }
}

/** A partial patch: fields left out keep their saved value. Unknown values are refused, not coerced. */
function write(dir, patch, now = Date.now()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw readable('Send preferences as an object.');
  const next = read(dir);
  if (patch.notifications !== undefined) {
    if (!patch.notifications || typeof patch.notifications !== 'object') throw readable('Send notification choices as an object.');
    for (const [event, on] of Object.entries(patch.notifications)) {
      if (!NOTIFICATION_EVENTS.includes(event)) throw readable(`Unknown notification event: ${event}.`);
      if (typeof on !== 'boolean') throw readable(`${event} must be true or false.`);
      next.notifications[event] = on;
    }
  }
  if (patch.sendKey !== undefined) {
    if (!SEND_KEYS.includes(patch.sendKey)) throw readable('Choose enter or mod-enter to send.');
    next.sendKey = patch.sendKey;
  }
  if (patch.locale !== undefined) {
    if (!LOCALES.includes(patch.locale)) throw readable('That format is not available.');
    next.locale = patch.locale;
  }
  next.updatedAt = now;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

module.exports = { read, write, defaults, NOTIFICATION_EVENTS, SEND_KEYS, LOCALES };
