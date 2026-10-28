'use strict';
// Typed provenance for the two existing owners that supply feature availability.
// This is not a settings namespace API and performs no feature or epoch writes.
const { createHash } = require('node:crypto');
const KEYS = new Set(['decision:configuration', 'inference:machines']);
const MAX_BYTES = 1024 * 1024;
const projection = `typeof(value) AS kind, length(CAST(value AS BLOB)) AS size,
  CASE WHEN value IS NULL OR length(CAST(value AS BLOB)) <= ${MAX_BYTES} THEN value ELSE NULL END AS value,
  CASE WHEN value IS NULL OR length(CAST(value AS BLOB)) <= ${MAX_BYTES} THEN hex(CAST(value AS BLOB)) ELSE NULL END AS bytes`;
function unavailable() {
  return Object.assign(new Error('Feature runtime settings are unavailable.'), { status: 503, code: 'FEATURE_RUNTIME_SOURCE_UNAVAILABLE' });
}
function checkKey(key) {
  if (!KEYS.has(key)) throw new TypeError('Unsupported feature runtime source key');
}
function fact(key, row) {
  if (row && (row.size > MAX_BYTES || row.bytes === null)) throw unavailable();
  const kind = row ? row.kind : 'missing';
  const bytes = row ? row.bytes : '';
  const source = createHash('sha256').update(`${key}\0${kind}\0${bytes}`).digest('hex');
  return Object.freeze({ key, value: row?.value, source });
}
function createStore(db) {
  const read = db.prepare(`SELECT ${projection} FROM settings WHERE key=?`);
  const write = db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?) RETURNING ${projection}`);
  const remove = db.prepare('DELETE FROM settings WHERE key=?');
  const readFact = key => { checkKey(key); return fact(key, read.get(key)); };
  const writeFact = (key, value) => {
    checkKey(key);
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw unavailable();
    // RETURNING binds provenance to this statement's stored value, not a later reread.
    const row = write.get(key, value);
    if (!row) throw unavailable(); // RAISE(IGNORE) is not proof the cache's new value was stored.
    return fact(key, row);
  };
  const deleteFact = key => { checkKey(key); remove.run(key); return fact(key, undefined); };
  return Object.freeze({ readFact, writeFact, deleteFact,
    get: key => readFact(key).value,
    set: (key, value) => { writeFact(key, value); },
    delete: key => { deleteFact(key); },
  });
}
module.exports = { createStore, MAX_BYTES };
