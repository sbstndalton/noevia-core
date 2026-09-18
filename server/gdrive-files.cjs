'use strict';
// File operations on one Google Drive connection (gdrive.cjs), for the chat's Drive tools.
// The connection's scope is drive.file, so every call here only ever sees files noevia created
// in that Drive; Google enforces that, not this module. Text only: binary files are described,
// not dumped into the model's context.
const crypto = require('node:crypto');

const fail = (message, status = 400) => Object.assign(Error(message), { status, publicMessage: message });
const FIELDS = 'id,name,mimeType,size,modifiedTime,createdTime,webViewLink,trashed';
const MAX_READ = 64 * 1024; // bytes pulled from Drive per read; the tool layer caps again for context
const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv|x-sh|sql|toml|markdown))/;

const clean = (v, name, max = 1000) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw fail(`${name} is required`);
  if (s.length > max) throw fail(`${name} is too long`);
  return s;
};
// Drive query strings quote with single quotes; a stray quote must not end the literal.
const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const fileId = (v) => { const id = clean(v, 'fileId', 200); if (!/^[\w-]+$/.test(id)) throw fail('fileId is not a Drive file id'); return id; };

function driveFiles(drive) {
  const { call, request, api, upload } = drive;
  const list = async (q, { limit = 10, orderBy = 'modifiedTime desc' } = {}) => {
    const n = Math.min(25, Math.max(1, Number(limit) || 10));
    const r = await call(`${api}/files?q=${encodeURIComponent(q)}&orderBy=${encodeURIComponent(orderBy)}&pageSize=${n}&fields=${encodeURIComponent(`files(${FIELDS})`)}`);
    return r.files || [];
  };
  const metadata = (id) => call(`${api}/files/${encodeURIComponent(fileId(id))}?fields=${encodeURIComponent(FIELDS)}`);

  return {
    search: ({ query, limit }) => list(`trashed=false and (name contains ${quote(clean(query, 'query', 200))} or fullText contains ${quote(query.trim())})`, { limit }),
    recent: ({ limit } = {}) => list('trashed=false', { limit }),
    metadata: ({ fileId: id }) => metadata(id),
    async read({ fileId: id }) {
      const meta = await metadata(id);
      const exportAs = EXPORTS[meta.mimeType];
      if (!exportAs && !TEXTUAL.test(meta.mimeType || '')) throw fail(`${meta.name} is ${meta.mimeType || 'a binary file'}; only text files and Google Docs, Sheets and Slides can be read.`);
      const url = exportAs
        ? `${api}/files/${encodeURIComponent(meta.id)}/export?mimeType=${encodeURIComponent(exportAs)}`
        : `${api}/files/${encodeURIComponent(meta.id)}?alt=media`;
      const r = await request(url);
      if (!r.ok) throw fail(`Google Drive answered ${r.status}.`, 502);
      const bytes = Buffer.from(await r.arrayBuffer());
      return { meta, text: bytes.subarray(0, MAX_READ).toString('utf8'), truncated: bytes.length > MAX_READ };
    },
    async create({ name, content, mimeType }) {
      const type = typeof mimeType === 'string' && /^text\/[\w.+-]+$|^application\/json$/.test(mimeType) ? mimeType : 'text/plain';
      const body = typeof content === 'string' ? content : '';
      const boundary = `noevia${crypto.randomBytes(8).toString('hex')}`;
      const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: clean(name, 'name', 255), mimeType: type })}\r\n--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\n\r\n`),
        Buffer.from(body, 'utf8'), Buffer.from(`\r\n--${boundary}--`),
      ]);
      return call(`${upload}/files?uploadType=multipart&fields=${encodeURIComponent(FIELDS)}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
    },
    async update({ fileId: id, content }) {
      const meta = await metadata(id);
      if (EXPORTS[meta.mimeType] || !TEXTUAL.test(meta.mimeType || '')) throw fail(`${meta.name} is not a plain text file, so noevia will not overwrite it.`);
      return call(`${upload}/files/${encodeURIComponent(meta.id)}?uploadType=media&fields=${encodeURIComponent(FIELDS)}`, { method: 'PATCH', headers: { 'Content-Type': `${meta.mimeType}; charset=UTF-8` }, body: typeof content === 'string' ? content : '' });
    },
    trash: ({ fileId: id }) => call(`${api}/files/${encodeURIComponent(fileId(id))}?fields=${encodeURIComponent(FIELDS)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }),
  };
}

module.exports = { driveFiles, quote };
