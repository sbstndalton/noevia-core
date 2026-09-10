// Full-repository check: the web Docker build only includes apps/web and runs tests/*.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
