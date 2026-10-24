'use strict';
// Generated mirror of noevia-rs/contracts/features/catalog.json. The lock is checked
// on every boot, so stale or edited metadata refuses startup before flags are read.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadCatalog({ mirror = path.join(__dirname, 'feature-catalog.json'),
  lockFile = path.join(__dirname, 'feature-catalog.lock.json') } = {}) {
  const bytes = fs.readFileSync(mirror);
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (lock.canonical !== 'sbstndalton/noevia-rs/contracts/features/catalog.json' ||
      !/^[0-9a-f]{40}$/.test(lock.canonicalRef) ||
      !/^[0-9a-f]{64}$/.test(lock.sha256) || digest !== lock.sha256) {
    throw new Error('Generated feature catalog does not match its canonical lock');
  }
  const catalog = JSON.parse(bytes);
  if (catalog.version !== 1 || !Array.isArray(catalog.features) || catalog.features.length !== 23) {
    throw new Error('Unsupported generated feature catalog');
  }
  return catalog;
}

module.exports = { loadCatalog };
