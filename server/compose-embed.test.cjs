// compose.embed.yaml (issue #298) reproduces the live-only `embed` sidecar
// (docs/deployment.md "Release ea57c83"; docs/spec-service-boundaries.md §2,
// finding 8). No compose validation runs in CI, so this parses the overlay
// text directly rather than shelling out to `docker compose config`.
//
// There is no YAML parser in this project's dependencies, so rather than pull
// one in (or rely on ad hoc regexes across the whole file), this walks the
// file by indentation the same way compose-env-keys.cjs does: two-space
// top-level service names, four-space keys inside a service body.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { composeEnvKeys } = require('./compose-env-keys.cjs');

const root = path.resolve(__dirname, '../../..');
const overlayPath = path.join(root, 'compose.embed.yaml');
const llamacppPath = path.join(root, 'compose.llamacpp.yaml');

/** Top-level (0-indent) keys, in file order, ignoring comments/blank lines. */
function topLevelKeys(text) {
  const keys = [];
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(#.*)?$/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/** Second-level (2-indent) keys directly under `services:`, in file order. */
function serviceNames(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === 'services:');
  assert.ok(start >= 0, 'no top-level `services:` key');
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // back to 0-indent: services block ended
    const m = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** The raw text of one service's body (4-indent-and-deeper lines), by name. */
function serviceBlock(text, service) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  assert.ok(start >= 0, `no top-level service \`${service}:\``);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break; // next 0- or 2-indent key
    body.push(line);
  }
  return body.join('\n');
}

/** Direct (4-indent) keys of a service body, in file order. */
function serviceKeys(block) {
  const keys = [];
  for (const line of block.split('\n')) {
    const m = /^ {4}([A-Za-z_][\w-]*):/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

test('compose.embed.yaml top-level keys are services and the shared models network only', () => {
  const text = fs.readFileSync(overlayPath, 'utf8');
  assert.deepEqual(topLevelKeys(text), ['services', 'networks'],
    'overlay must declare only `services:` and `networks:` (no volumes)');
  assert.match(text, /\nnetworks:\n(?: {2}#.*\n)* {2}models: \{\}\s*$/,
    'the only network the overlay declares is `models` (same as compose.llamacpp.yaml)');
});

test('compose.embed.yaml declares exactly the embed, web and diary services', () => {
  const text = fs.readFileSync(overlayPath, 'utf8');
  assert.deepEqual(new Set(serviceNames(text)), new Set(['embed', 'web', 'diary']),
    'overlay must declare exactly {embed, web, diary}');
  // #697: Diary only gains its embedding endpoint, so it never asks the one-model engine to embed.
  const diary = serviceBlock(text, 'diary');
  assert.deepEqual(diary.split('\n').filter(l => /^ {6}\w/.test(l)).map(l => l.trim()), ['LLM_EMBED_BASE_URL: http://embed:8080/v1']);
});

test('compose.embed.yaml embed service is digest-pinned, healthchecked and default and models networks only', () => {
  const text = fs.readFileSync(overlayPath, 'utf8');
  const block = serviceBlock(text, 'embed');
  const keys = serviceKeys(block);

  const imageLine = block.match(/^ {4}image:\s*(\S+)/m);
  assert.ok(imageLine, 'embed service has no image line');
  assert.ok(imageLine[1].includes('@sha256:'), 'embed image is not digest-pinned');

  assert.ok(keys.includes('healthcheck'), 'embed must declare a healthcheck');
  assert.ok(keys.includes('restart'), 'embed must declare a restart policy');
  assert.ok(!keys.includes('ports'), 'embed must not publish a port');

  const networksFlow = block.match(/^ {4}networks:\s*\[([^\]]*)\]/m);
  const networksBlock = /^ {4}networks:\s*\n((?: {6}-.*\n?)+)/m.exec(block);
  let networks;
  if (networksFlow) {
    networks = networksFlow[1].split(',').map((n) => n.trim()).filter(Boolean);
  } else if (networksBlock) {
    networks = networksBlock[1].split('\n')
      .map((l) => /^ {6}-\s*(\S+)/.exec(l))
      .filter(Boolean)
      .map((m) => m[1]);
  }
  assert.ok(networks, 'embed service declares no networks');
  // Issue #549: model-loader is on `models` only (it holds the Docker socket, so it must not be
  // on `default`); embed joins `models` so the loader can probe it. No other network.
  assert.deepEqual(networks, ['default', 'models']);
  const llamacpp = fs.readFileSync(llamacppPath, 'utf8');
  assert.match(serviceBlock(llamacpp, 'model-loader'), /^ {4}networks:\s*\[models\]/m,
    'model-loader must stay on models only; embed joins it, not the other way round');
});

test('compose.embed.yaml pins embed to the same digest as llama, openly', () => {
  const embedText = fs.readFileSync(overlayPath, 'utf8');
  const llamacppText = fs.readFileSync(llamacppPath, 'utf8');

  const embedImage = embedText.match(/^ {4}image:\s*(\S+)/m)[1];
  const embedDigest = embedImage.split('@')[1];
  const llamaBlock = serviceBlock(llamacppText, 'llama');
  const llamaImage = llamaBlock.match(/^ {4}image:\s*(\S+)/m)[1];
  const llamaDigest = llamaImage.split('@')[1];

  const sameDigest = embedDigest === llamaDigest;
  const hasDisclosureComment = /#\s*same image as llama by design/.test(embedText);
  assert.ok(!sameDigest || hasDisclosureComment,
    'embed shares llama\'s image digest but the file does not openly say so ' +
    '(expected a `# same image as llama by design` comment)');
});

test('compose.embed.yaml web override only touches environment and depends_on', () => {
  const text = fs.readFileSync(overlayPath, 'utf8');
  const block = serviceBlock(text, 'web');
  assert.deepEqual(new Set(serviceKeys(block)), new Set(['environment', 'depends_on']),
    'web override must only set environment and depends_on');
});

test('compose.embed.yaml wires EMBEDDING_BASE_URL onto web', () => {
  const text = fs.readFileSync(overlayPath, 'utf8');
  const webKeys = composeEnvKeys(text, 'web');
  assert.ok(webKeys && webKeys.includes('EMBEDDING_BASE_URL'),
    'overlay must set web.environment.EMBEDDING_BASE_URL');
});
