// Resolves the version string reported by GET /api/ready (#297, #337).
//
// Priority: dist/version.json (the artifact served to the browser) >
// STAMP_VERSION env var > the repo-root package.json > server/package.json >
// 'unknown'. The build-stage STAMP_VERSION is not inherited by the runtime
// Docker stage, so the served artifact must be authoritative. Never throws: a missing or
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
  const servedVersion = readVersionFrom(path.join(baseDir, '..', 'dist', 'version.json'));
  if (servedVersion) return servedVersion;
  if (env.STAMP_VERSION) return env.STAMP_VERSION;
  const rootVersion = readVersionFrom(path.join(baseDir, '..', 'package.json'));
  if (rootVersion) return rootVersion;
  const serverVersion = readVersionFrom(path.join(baseDir, 'package.json'));
  if (serverVersion) return serverVersion;
  return 'unknown';
}

module.exports = { resolveVersion, readVersionFrom };
