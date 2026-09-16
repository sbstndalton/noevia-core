// Full-repository check: the web Docker build only includes apps/web and runs tests/*.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { composeEnvKeys } = require('./compose-env-keys.cjs');

test('both diary compose definitions pass through TZ with the documented default', () => {
  const root = path.resolve(__dirname, '../../..');
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const defaultZone = example.match(/^TZ=(.+)$/m)[1];
  assert.equal(defaultZone, 'America/New_York');
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: defaultZone }));
  for (const name of ['compose.yaml', 'deploy/examples/unraid-compose-manager.yml']) {
    const compose = fs.readFileSync(path.join(root, name), 'utf8');
    const diary = compose.split('  diary:')[1].split('\n  web:')[0];
    assert.ok(diary.includes(`      TZ: ${'${TZ:-'}${defaultZone}}`));
  }
});

// The live Unraid deployment keeps its Compose file in a third place that does
// not auto-sync (docs/deployment.md:47). On 2026-09-15 that file was missing all
// six MCP/toolbox keys, so MCP_ENABLED was false, startup logged `mcp: disabled`,
// and boxes that lose every tool are not rendered at all — which reads as the
// feature having been removed rather than as a configuration gap.
//
// Comparing key NAMES only. A value belongs to a deployment; the set of knobs a
// deployment is even able to turn does not.
test('both web compose definitions pass through an identical env-key set', () => {
  const root = path.resolve(__dirname, '../../..');
  const keysFor = (name) =>
    composeEnvKeys(fs.readFileSync(path.join(root, name), 'utf8'), 'web');

  const canonical = keysFor('compose.yaml');
  assert.ok(canonical && canonical.length > 10, 'compose.yaml web environment did not parse');
  const unraid = keysFor('deploy/examples/unraid-compose-manager.yml');
  assert.ok(unraid, 'Unraid example has no web service');

  assert.deepEqual(
    [...unraid].sort(),
    [...canonical].sort(),
    'deploy/examples/unraid-compose-manager.yml and compose.yaml disagree on which env vars the web service accepts',
  );

  // Named so a future removal has to be deliberate rather than a copy slip.
  for (const key of ['MCP_SERVERS', 'MCP_SERVER_URL', 'MCP_NEXTCLOUD_ORIGINS',
    'TAVILY_API_KEY', 'ENABLED_TOOLBOXES', 'TRUST_PROXY']) {
    assert.ok(canonical.includes(key), `compose.yaml no longer passes ${key}`);
  }
});

// The preflight drift check runs on the Docker host, where the repo may not be
// present, so it reads the expected names from a shipped file. Regenerate with
// `node -e` against compose-env-keys.cjs if this fails.
test('the preflight expected-key list matches compose.yaml', () => {
  const root = path.resolve(__dirname, '../../..');
  const shipped = fs.readFileSync(path.join(root, 'deploy/preflight/web-env-keys.txt'), 'utf8')
    .split('\n').map((line) => line.trim()).filter(Boolean);
  const canonical = composeEnvKeys(fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8'), 'web');
  assert.deepEqual(shipped, [...canonical].sort(),
    'deploy/preflight/web-env-keys.txt is stale relative to compose.yaml');
});
