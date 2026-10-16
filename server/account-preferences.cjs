'use strict';
// Per-user interface preferences that should follow the person between browsers (#227, #230,
// #231): which events may raise a browser notification, how the composer sends, and the locale
// used for dates and numbers. Stored per user beside projects.json, like the other account-*.cjs
// records. Browser notification *permission* stays per device; only the event choices live here.
// The Rust front reads and writes them (/api/account/preferences, sbstndalton/noevia#1071); the
// names and the reader stay here for the web client's parity tests.
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

module.exports = { read, defaults, NOTIFICATION_EVENTS, SEND_KEYS, LOCALES };
