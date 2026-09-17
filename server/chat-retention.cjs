'use strict';
// Settings → Data → Delete old chats. Off unless the user picks a period. Pinned chats and chats
// without a date are never deleted. The sweep runs when the user's workspace loads (at most
// hourly) through the normal delete path, so tombstones and history removal behave the same.
const fs = require('node:fs');
const path = require('node:path');

const PERIODS = [30, 90, 365];
const FILE = 'chat-retention.json';
const DAY = 86400000;
const SWEEP_EVERY = 3600000;

function readable(message, status = 400) { return Object.assign(Error(message), { publicMessage: message, status }); }

function read(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return { days: PERIODS.includes(data.days) ? data.days : 0, lastSweep: Number.isFinite(data.lastSweep) ? data.lastSweep : 0 };
  } catch { return { days: 0, lastSweep: 0 }; }
}

function save(dir, record) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}

function write(dir, days) {
  if (days !== 0 && !PERIODS.includes(days)) throw readable('Choose off, or 30, 90 or 365 days.');
  return save(dir, { days, lastSweep: read(dir).lastSweep });
}

function markSwept(dir, now = Date.now()) { return save(dir, { ...read(dir), lastSweep: now }); }

function expired({ freeChats = [], projects = [], days, now = Date.now() }) {
  if (!days) return [];
  const cutoff = now - days * DAY;
  const old = (chat) => chat && !chat.pinned && Number.isFinite(chat.updatedAt) && chat.updatedAt < cutoff;
  return [
    ...freeChats.filter(old).map((chat) => ({ projectId: null, id: chat.id })),
    ...projects.flatMap((project) => (project.chats || []).filter(old).map((chat) => ({ projectId: project.id, id: chat.id }))),
  ];
}

function sweepDue(settings, now = Date.now()) { return settings.days > 0 && now - settings.lastSweep >= SWEEP_EVERY; }

module.exports = { read, write, markSwept, expired, sweepDue, PERIODS };
