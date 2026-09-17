// Pull the env-var NAMES a Compose service declares out of a compose file, by
// text rather than by parsing YAML: this runs inside the web image, which has
// no YAML dependency, and the shape we care about is two fixed indent levels.
//
// Names only, never values. `TAVILY_API_KEY` is a key name and safe to print;
// its value is a secret and is never read here.
'use strict';

/** Env-var names declared under `environment:` for `service` in compose text. */
function composeEnvKeys(text, service) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start < 0) return null;
  let inEnv = false;
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    // A new two-space key ends the service block.
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (inEnv && /^ {4}\S/.test(line)) { inEnv = false; continue; }
    if (!inEnv) continue;
    const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

module.exports = { composeEnvKeys };
