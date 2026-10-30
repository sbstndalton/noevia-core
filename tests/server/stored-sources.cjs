'use strict';
// #2191: GET /api/projects/{id}/sources/text, .../documents/original and .../uploads/original are the Rust front's
// (server/rust-project-reads.cjs), so a Node test can no longer read back what this process stored
// through them. These read the same files the front reads, as it reads them: projects.json's
// source entry, then its content-addressed text (project-sources/<safe id>/<textRef>.txt) or its
// stored upload (project-uploads/<sha256(id)>/<attachment.id>) or PDF original
// (project-documents/<sha256(id)>/<document.byteHash>.pdf). Round 4 moved GET .../documents/pages too
// (server/rust-project-document-pages.cjs): documentPages answers as the front does, through
// document-sources.cjs readPages over the stored result. Test-only; synthetic data.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REF = /^[0-9a-f]{64}$/;

/** The user directory under `dataDir` whose projects.json holds `projectId`, and that project. */
function locate(dataDir, projectId) {
  const users = path.join(dataDir, 'users');
  for (const u of fs.existsSync(users) ? fs.readdirSync(users) : []) {
    const file = path.join(users, u, 'projects.json');
    if (!fs.existsSync(file)) continue;
    const project = (JSON.parse(fs.readFileSync(file, 'utf8')).projects || []).find((p) => p && p.id === projectId);
    if (project) return { dir: path.join(users, u), project };
  }
  return null;
}

/** What the front answers for GET .../sources/text?name=: { status, json }. */
function sourceText(dataDir, projectId, name) {
  const hit = locate(dataDir, projectId);
  if (!hit) return { status: 404, json: { error: 'no such project' } };
  const file = (hit.project.files || []).find((f) => f && f.name === name);
  if (!file) return { status: 404, json: { error: 'no such source' } };
  let content = '';
  if (Object.prototype.hasOwnProperty.call(file, 'content')) content = typeof file.content === 'string' ? file.content : '';
  else if (REF.test(String(file.textRef))) {
    const safe = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '');
    try { content = fs.readFileSync(path.join(hit.dir, 'project-sources', safe, `${file.textRef}.txt`), 'utf8'); }
    catch { return { status: 404, json: { error: 'The text of this source is missing. Re-upload or refresh it.', code: 'SOURCE_TEXT_MISSING', name: file.name } }; }
  }
  return { status: 200, json: { name: file.name, content, chars: content.length } };
}

/** The stored bytes GET .../uploads/original?name= serves, or null where it answers 404. */
function uploadOriginal(dataDir, projectId, name) {
  const hit = locate(dataDir, projectId);
  const file = hit && (hit.project.files || []).find((f) => f && f.name === name && f.attachment);
  if (!file || !REF.test(String(file.attachment.id || ''))) return null;
  const full = path.join(hit.dir, 'project-uploads', crypto.createHash('sha256').update(String(projectId)).digest('hex'), file.attachment.id);
  try { return fs.readFileSync(full); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** What GET .../documents/original?name= answers: { status, bytes } (bytes only for a 200). */
function documentOriginal(dataDir, projectId, name) {
  const hit = locate(dataDir, projectId);
  const file = hit && (hit.project.files || []).find((f) => f && f.name === name);
  if (!file || !file.document) return { status: 404, bytes: null };
  const hash = file.document.byteHash;
  if (!REF.test(String(hash || ''))) return { status: 422, bytes: null };
  try { return { status: 200, bytes: fs.readFileSync(path.join(hit.dir, 'project-documents', crypto.createHash('sha256').update(String(projectId)).digest('hex'), `${hash}.pdf`)) }; }
  catch { return { status: 422, bytes: null }; }
}

/** What GET .../documents/pages?<query> answers for the user owning `projectId`: { status, json, text }
 *  (`text` is the page text of a 200, '' otherwise); the route's own order and words (routes/projects.cjs
 *  docRead before #2191 round 4). */
function documentPages(dataDir, projectId, query = '') {
  const url = new URL('http://localhost/?' + String(query).replace(/^[?&]/, ''));
  const hit = locate(dataDir, projectId);
  const file = hit && (hit.project.files || []).find((f) => f && f.name === url.searchParams.get('name'));
  const answer = (status, json) => ({ status, json, text: status === 200 ? json.text + '\n' + json.notice : JSON.stringify(json) });
  if (!file?.document) return answer(404, { error: 'no such document' });
  try {
    const start = Number(url.searchParams.get('startPage') || 1);
    return answer(200, require('../../server/document-sources.cjs').readPages({ dir: hit.dir }, projectId, file, start,
      Number(url.searchParams.get('endPage') || start), Number(url.searchParams.get('offset') || 0)));
  } catch (err) { return answer(err.status || 422, { error: err.status ? err.message : 'Saved document data is unavailable; upload or refresh again.' }); }
}

module.exports = { sourceText, uploadOriginal, documentOriginal, documentPages };
