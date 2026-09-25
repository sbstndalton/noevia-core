// Resolves the version string reported by GET /api/ready (#297, #337).
//
// Priority: STAMP_VERSION env var (set from COWORK_VERSION at build time,
// see Dockerfile) > the repo-root package.json (present in the runtime image
// alongside dist/ and server/) > server/package.json (always present since
// it ships the server's own deps) > 'unknown'. Never throws: a missing or
// unreadable file must not take the process down (#337 — root package.json
// was omitted from the runtime image and the previous inline `require`
// crashed the container on every start).
'use strict';
const fs = require('fs');
const path = require('path');

function readVersionFrom(jsonPath) {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === 'string' && parsed.version) return parsed.version;
  } catch {
    // Missing file, bad JSON, no version field — fall through.
  }
  return null;
}

function resolveVersion(env = process.env, baseDir = __dirname) {
  if (env.STAMP_VERSION) return env.STAMP_VERSION;
  const rootVersion = readVersionFrom(path.join(baseDir, '..', 'package.json'));
  if (rootVersion) return rootVersion;
  const serverVersion = readVersionFrom(path.join(baseDir, 'package.json'));
  if (serverVersion) return serverVersion;
  return 'unknown';
}

module.exports = { resolveVersion, readVersionFrom };
