'use strict';
// D6: DAV DELETE, MOVE and COPY per docs/dav.md § Storage contract. The companion
// (/api/workspace-ops) owns every rule that touches data — protected paths incl. AI Memory/**,
// Trash capsules, bounds, one transaction; this module only translates HTTP into those calls.
// Advertises DAV class 1. No LOCK: class 2 waits until a client needs it.

const ETAG = /^"[a-f0-9]{64}"$/;
const fail = (status, message) => Object.assign(Error(message), { status });

/** Resolve a Destination header to a tenant-relative path on this same endpoint. */
function destinationPath(header, { origin, username }) {
  if (typeof header !== 'string' || !header || header.length > 2000) throw fail(400, 'Destination header required');
  let url;
  try { url = new URL(header, origin); } catch { throw fail(400, 'Invalid Destination'); }
  if (url.origin !== new URL(origin).origin) throw fail(502, 'Destination must be on this sharing endpoint');
  if (url.search || url.hash || url.username || url.password) throw fail(400, 'Invalid Destination');
  const raw = url.pathname;
  const prefix = '/dav/' + encodeURIComponent(username) + '/';
  if (!raw.toLowerCase().startsWith(prefix.toLowerCase())) throw fail(403, 'Destination must be inside your own folder');
  let segments;
  try { segments = raw.slice(prefix.length).split('/').map(decodeURIComponent); } catch { throw fail(400, 'Invalid Destination encoding'); }
  if (segments.at(-1) === '') segments.pop();
  if (!segments.length || segments.some(s => !s || s.startsWith('.') || /[\\/%\x00-\x1f\x7f]/.test(s))) throw fail(403, 'Invalid Destination path');
  const path = segments.join('/');
  if (path.length > 500) throw fail(414, 'Path too long');
  return path;
}

/** Destination precondition from an RFC 4918 tagged If header: If: <dest-url> (["etag"]). */
function destinationTag(ifHeader, destinationUrl) {
  if (!ifHeader) return null;
  for (const m of String(ifHeader).matchAll(/<([^>]+)>\s*\(\s*\[("[a-f0-9]{64}")\]\s*\)/g)) {
    try { if (new URL(m[1], destinationUrl).href === new URL(destinationUrl).href) return m[2].slice(1, -1); } catch { /* ignore */ }
  }
  return null;
}

function createDavOps({ ops: call }) {
  // A companion that timed out may have applied the change; say so instead of guessing (contract 7).
  // A retry with the same If-Match then yields success or 412, never a second effect.
  const ops = async (userId, body) => {
    try { return await call(userId, body); }
    catch (error) {
      if (error.status) throw error;
      throw Object.assign(fail(503, 'The outcome is unknown; read the file again before retrying'), { retryAfter: 5 });
    }
  };
  const methods = ['DELETE', 'MOVE', 'COPY'];
  return {
    methods,
    /** Keep a file's current bytes in Trash before an unconditional PUT replaces them. */
    async preserve(userId, path, version) {
      return ops(userId, { op: 'preserve', path, version });
    },
    /** A collection's ETag, for PROPFIND. */
    async folderTag(userId, path) {
      try { return (await ops(userId, { op: 'stat', path })).version; } catch { return null; }
    },
    async handle({ req, method, path, identity, username, origin, allowed, audit, readBody }) {
      if (!path) throw fail(403, 'The diary root cannot be changed');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw fail(415, 'Encoded bodies are unsupported');
      if ((await readBody(req, 8192)).length) throw fail(415, 'Request bodies are unsupported');
      const depth = req.headers.depth;
      if (depth !== undefined && depth !== 'infinity' && !(method === 'COPY' && depth === '0')) throw fail(400, 'Folder operations apply to the whole folder (Depth: infinity)');
      const match = req.headers['if-match'];
      if (match !== undefined && !ETAG.test(match)) throw fail(400, 'A single strong ETag is required');
      if (!allowed()) throw fail(403, 'Sharing was disabled');
      // Ordinary clients (rclone, Finder, Explorer, Obsidian sync) never send If-Match (docs/dav.md,
      // interop run 1). DELETE and MOVE are reversible — Trash, or a move back — so without one the
      // current version is read and used; with one, it is checked exactly as before. Protected
      // paths are refused by the companion either way.
      const unconditional = !match && method !== 'COPY';
      const version = match ? match.slice(1, -1) : unconditional ? (await ops(identity.userId, { op: 'stat', path })).version : null;
      if (method === 'DELETE') {
        const result = await ops(identity.userId, { op: 'delete', path, version });
        audit('dav.delete', { path, trashed: result.trash?.length || 0, unconditional });
        return { status: 204 };
      }
      const destination = destinationPath(req.headers.destination, { origin, username });
      const overwriteHeader = req.headers.overwrite;
      if (overwriteHeader !== undefined && !['T', 'F'].includes(String(overwriteHeader).toUpperCase())) throw fail(400, 'Overwrite must be T or F');
      // RFC 4918 §10.6: a missing Overwrite header defaults to T, not F. The replaced
      // destination goes to Trash (not deleted outright) either way, so defaulting to
      // T here is safe and matches the RFC rather than the old fail-closed reading.
      const overwrite = String(overwriteHeader ?? 'T').toUpperCase() !== 'F';
      const destinationUrl = new URL(req.headers.destination, origin).href;
      let destinationVersion = destinationTag(req.headers.if, destinationUrl);
      // Replacing a destination sends it to Trash first (the companion capsules it), so an untagged
      // Overwrite: T reads the destination's current version rather than refusing.
      if (overwrite && !destinationVersion) {
        try { destinationVersion = (await ops(identity.userId, { op: 'stat', path: destination })).version; }
        catch (error) { if (error.status !== 404) throw error; }
      }
      if (depth === '0' && method === 'COPY') {
        const stat = await ops(identity.userId, { op: 'stat', path });
        if (stat.isDir) throw fail(403, 'Copying a folder without its contents is unsupported');
      }
      const body = { op: method.toLowerCase(), path, destination, overwrite,
        ...(version ? { version } : {}), ...(destinationVersion ? { destinationVersion } : {}) };
      const result = await ops(identity.userId, body);
      audit(`dav.${method.toLowerCase()}`, { path, destination, replaced: !!result.replaced, unconditional });
      return { status: result.replaced ? 204 : 201 };
    },
  };
}

module.exports = { createDavOps, destinationPath, destinationTag };
