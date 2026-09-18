'use strict';
// Whose Google Drive a chat tool reaches. Every account uses its own connection, so one
// person's Drive is never readable from another account (tenant isolation).
//
// The server-wide backup connection (offsite-service, sealed with the backup key) doubles as
// the personal connection of the administrator who made it: it records `owner` since
// 2026-09-18, and a connection saved before that belongs to whichever administrator opens it,
// since only administrators could create it. Everyone else gets their own sealed file.
const fs = require('node:fs');
const path = require('node:path');

function createDriveAccounts({ backupDrive, backupUsable = () => !!backupDrive, makeDrive, dataDir, userKey }) {
  const dir = path.join(dataDir, 'google-drive-users');
  const personal = new Map();

  const ownsBackup = (user) => {
    if (!backupDrive || user.role !== 'admin' || !backupUsable()) return false;
    const s = backupDrive.state();
    if (s.state === 'connected' || s.state === 'error') return !s.owner || s.owner === user.id;
    // Nothing saved yet: an administrator connecting from Connectors fills the backup slot,
    // unless they already have a personal connection.
    return !fs.existsSync(path.join(dir, `${user.id}.sealed`));
  };

  function forUser(user) {
    if (!user || !user.id) throw Object.assign(Error('Sign in first.'), { status: 401, publicMessage: 'Sign in first.' });
    if (ownsBackup(user)) return { drive: backupDrive, backup: true };
    if (!/^[\w-]+$/.test(user.id)) throw Error('unexpected user id');
    if (!personal.has(user.id)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      personal.set(user.id, makeDrive({ tokenFile: path.join(dir, `${user.id}.sealed`), backupKey: userKey }));
    }
    return { drive: personal.get(user.id), backup: false };
  }

  /** Forget a deleted account's connection (revoked at Google first). */
  async function removeUser(userId) {
    const file = path.join(dir, `${userId}.sealed`);
    if (!/^[\w-]+$/.test(userId)) return;
    const d = personal.get(userId) || (fs.existsSync(file) ? makeDrive({ tokenFile: file, backupKey: userKey }) : null);
    if (d) await d.disconnect().catch(() => {});
    personal.delete(userId);
  }

  return { forUser, removeUser };
}

module.exports = { createDriveAccounts };
