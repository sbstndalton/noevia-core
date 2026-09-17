'use strict';
// D8: after a project delete commits, remove the directories it leaves behind — but only
// empty ones, only inside the tenant root, never recursively. Idempotent and logged.
//
// Local: rmdir (non-recursive; ENOTEMPTY means an upload raced us and the dir stays).
// Remote WebDAV: PROPFIND Depth 1 must show no children, then DELETE with If-Match on the
// collection's ETag, so a file written between the check and the delete makes it fail (412).
// S3 has no directories (an empty prefix doesn't exist), so there is nothing to sweep.

const nodePath = require('node:path');

function inside(child, parent) {
  const rel = nodePath.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

/**
 * @param {{ fs?: typeof import('node:fs'), storage?: { removeEmptyFolder(conn:object, path:string): Promise<{removed:boolean, reason?:string}> },
 *           log?: (event:object)=>void }} deps
 */
function createProjectSweep({ fs = require('node:fs'), storage = null, log = () => {} } = {}) {
  function sweepLocal(tenantRoot, dirs) {
    const results = [];
    let root;
    try { root = fs.realpathSync(tenantRoot); } catch { return results; }
    for (const dir of dirs) {
      let real;
      try { real = fs.realpathSync(dir); }
      catch (e) { results.push({ dir, removed: false, reason: e.code === 'ENOENT' ? 'missing' : 'unresolvable' }); continue; }
      if (!inside(real, root)) { results.push({ dir, removed: false, reason: 'outside-tenant' }); continue; }
      try {
        if (!fs.lstatSync(real).isDirectory()) { results.push({ dir, removed: false, reason: 'not-directory' }); continue; }
        fs.rmdirSync(real); // never recursive
        results.push({ dir, removed: true });
      } catch (e) {
        results.push({ dir, removed: false, reason: ['ENOTEMPTY', 'EEXIST'].includes(e.code) ? 'not-empty' : e.code === 'ENOENT' ? 'missing' : 'error' });
      }
    }
    return results;
  }

  async function sweepRemote(connection, folder, { root = '', groups = [] } = {}) {
    const results = [];
    if (!storage || !connection || !['webdav', 'nextcloud'].includes(connection.kind) || !folder) return results;
    const clean = String(folder).replace(/^\/+|\/+$/g, '');
    const cleanRoot = String(root).replace(/^\/+|\/+$/g, '');
    const segments = clean.split('/');
    // Only a folder directly under the projects root that noevia allocated, never the root itself.
    if (segments.some(s => !s || s === '.' || s === '..') || !cleanRoot || nodePath.posix.dirname(clean) !== cleanRoot) {
      results.push({ dir: clean, removed: false, reason: 'outside-projects-root' });
      return results;
    }
    for (const target of [...groups.map(g => `${clean}/${g}`), clean]) {
      try { results.push({ dir: target, ...(await storage.removeEmptyFolder(connection, target)) }); }
      catch { results.push({ dir: target, removed: false, reason: 'error' }); }
    }
    return results;
  }

  async function afterDelete({ tenantRoot, localDirs = [], connection = null, folder = '', root = '', groups = [], projectId = '' }) {
    const results = [...sweepLocal(tenantRoot, localDirs), ...(await sweepRemote(connection, folder, { root, groups }))];
    for (const r of results) if (r.reason !== 'missing') log({ event: 'project.sweep', projectId, dir: r.dir, removed: r.removed, reason: r.reason });
    return results;
  }

  return { sweepLocal, sweepRemote, afterDelete };
}

module.exports = { createProjectSweep, inside };
