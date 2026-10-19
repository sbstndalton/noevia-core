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


// Two checked-in deployment generations are supported: the historical core CI
// input has three services; the settings-driven overlay adds these exact two.
// Fixed schemas reject unknown services, partial upgrades and duplicate names.
function assertOverlayTopology(text) {
  const names = serviceNames(text), declared = new Set(names);
  assert.equal(names.length, declared.size, 'duplicate overlay service');
  const legacy = names.length === 3;
  assert.deepEqual(declared, new Set(legacy
    ? ['embed', 'web', 'diary']
    : ['embed', 'model-loader', 'embed-next', 'web', 'diary']),
  'overlay must match the complete historical or managed embedding service set');
  if (legacy) return 'legacy';

  // #1668: the manager must render embedding.ini before the router starts.
  const embed = serviceBlock(text, 'embed');
  assert.equal(serviceKeys(embed).filter(key => key === 'depends_on').length, 1,
    'managed embed has exactly one dependency block');
  const dependency = /^ {4}depends_on:\s*\n((?: {6}.*\n?)+)/m.exec(embed);
  assert.ok(dependency, 'managed embed waits for the preset renderer');
  assert.deepEqual(dependency[1].split('\n').filter(line => line.trim() && !line.trim().startsWith('#')),
    ['      model-loader:', '        condition: service_healthy'],
    'managed embed must wait for model-loader health before reading its preset');

  // #1668 adds environment wiring to the existing models-only socket holder.
  // The overlay must not grant it a network, port, image or mount override.
  const loader = serviceBlock(text, 'model-loader');
  assert.deepEqual(serviceKeys(loader), ['environment'], 'model-loader override is environment only');
  const loaderEnvKeys = composeEnvKeys(text, 'model-loader');
  assert.equal(loaderEnvKeys.length, 6, 'model-loader has exactly six raw environment entries');
  assert.equal(new Set(loaderEnvKeys).size, 6, 'model-loader environment keys are unique');
  assert.deepEqual(new Set(loaderEnvKeys), new Set([
    'EMBED_CONTAINER', 'EMBED_URL', 'EMBED_PRESET_PATH',
    'EMBEDDING_MODEL', 'EMBED_MODEL_FILE', 'NOEVIA_MULTIMODAL_RAG',
  ]), 'model-loader embedding wiring must be complete');
  assert.match(loader, /^ {6}EMBED_URL: http:\/\/embed:8080\s*$/m);
  assert.match(loader, /^ {6}EMBED_PRESET_PATH: \/config\/embedding\.ini\s*$/m);

  // #1636's separate parity reader is opt-in, CPU-only and reads only models.
  const next = serviceBlock(text, 'embed-next'), keys = serviceKeys(next);
  assert.equal(new Set(keys).size, keys.length, 'embed-next service keys are unique');
  assert.match(next, /^ {4}profiles: \[embed-next\]\s*$/m, 'embed-next stays opt-in');
  const allowedReaderKeys = ['profiles', 'image', 'restart', 'command', 'volumes',
    'mem_limit', 'memswap_limit', 'cpus', 'healthcheck', 'networks'];
  for (const key of keys) {
    assert.ok(allowedReaderKeys.includes(key), 'embed-next must not declare ' + key);
  }
  assert.match(next, /^ {4}networks: \[default, models\]\s*$/m);
  const command = /^ {4}command:\s*\n((?: {6}.*\n?)+)/m.exec(next);
  assert.ok(command, 'embed-next declares its command sequence');
  // The checked-in command uses JSON-compatible double-quoted YAML scalars.
  // Decode every sequence item before checking options; do not let a second
  // --device or an escaped spelling override the first CPU-only selection.
  const commandArgs = command[1].split('\n').filter(line => /^ {6}-/.test(line)).map(line => {
    const scalar = /^ {6}- ("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(line);
    assert.ok(scalar, 'embed-next command items use double-quoted scalars');
    try { return JSON.parse(scalar[1]); } catch { assert.fail('embed-next command scalar is not JSON-compatible'); }
  });
  assert.equal(commandArgs.filter(value => value === '--device').length, 1, 'embed-next has exactly one --device option');
  assert.equal(commandArgs[commandArgs.indexOf('--device') + 1], 'none', 'embed-next device is CPU-only');
  const volumes = /^ {4}volumes:\s*\n((?: {6}.*\n?)+)/m.exec(next);
  assert.ok(volumes, 'embed-next declares its read-only model mount');
  const mounts = volumes[1].split('\n').filter(line => /^ {6}-/.test(line));
  assert.equal(mounts.length, 1, 'embed-next has exactly its model mount');
  assert.match(mounts[0], /^ {6}- \$\{LLAMACPP_MODELS_DIR:\?[^}]+\}:\/models:ro\s*$/);
  return 'managed';
}

test('compose.embed.yaml top-level keys are services and the shared models network only', () => {
  const text = fs.readFileSync(overlayPath, 'utf8');
  assert.deepEqual(topLevelKeys(text), ['services', 'networks'],
    'overlay must declare only `services:` and `networks:` (no volumes)');
  assert.match(text, /\nnetworks:\n(?: {2}#.*\n)* {2}models: \{\}\s*$/,
    'the only network the overlay declares is `models` (same as compose.llamacpp.yaml)');
});

test('compose.embed.yaml has the complete historical or managed service topology', () => {
  const text = fs.readFileSync(overlayPath, 'utf8');
  assertOverlayTopology(text);
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

// Synthetic topology controls exercise both schemas even with historical CI inputs.
const legacyTopologyFixture = 'services:\n  embed:\n  web:\n  diary:\n';
const managedTopologyFixture = [
  "services:",
  "  embed:",
  "    depends_on:",
  "      model-loader:",
  "        condition: service_healthy",
  "  model-loader:",
  "    environment:",
  "      EMBED_CONTAINER: ${EMBED_CONTAINER:-cowork-embed-1}",
  "      EMBED_URL: http://embed:8080",
  "      EMBED_PRESET_PATH: /config/embedding.ini",
  "      EMBEDDING_MODEL: ${EMBEDDING_MODEL:-}",
  "      EMBED_MODEL_FILE: ${EMBED_MODEL_FILE:-}",
  "      NOEVIA_MULTIMODAL_RAG: ${NOEVIA_MULTIMODAL_RAG:-0}",
  "  embed-next:",
  "    profiles: [embed-next]",
  "    command:",
  "      - \"--device\"",
  "      - \"none\"",
  "    volumes:",
  "      - ${LLAMACPP_MODELS_DIR:?Set the existing public models directory}:/models:ro",
  "    networks: [default, models]",
  "  web:",
  "  diary:",
  '',
].join('\n');

test('embedding topology validator accepts both fixed deployment generations', () => {
  assert.equal(assertOverlayTopology(legacyTopologyFixture), 'legacy');
  assert.equal(assertOverlayTopology(managedTopologyFixture), 'managed');
});

test('embedding topology validator rejects partial, unknown and widened reader overlays', () => {
  const malformed = [
    ['unknown legacy service', legacyTopologyFixture + '  other:\n'],
    ['partial upgrade', legacyTopologyFixture + '  embed-next:\n'],
    ['unknown managed service', managedTopologyFixture + '  other:\n'],
    ['router starts before preset renderer', managedTopologyFixture.replace('condition: service_healthy', 'condition: service_started')],
    ['duplicate service', managedTopologyFixture + '  embed:\n'],
    ['unconditional next reader', managedTopologyFixture.replace('    profiles: [embed-next]\n', '')],
    ['socket holder joins default', managedTopologyFixture.replace('  model-loader:\n', '  model-loader:\n    networks: [default]\n')],
    ['incomplete manager wiring', managedTopologyFixture.replace('      EMBED_URL: http://embed:8080\n', '')],
    ['incorrect manager endpoint', managedTopologyFixture.replace('http://embed:8080', 'http://web:8021')],
    ['reader publishes a port', managedTopologyFixture.replace('  embed-next:\n', '  embed-next:\n    ports: [8080]\n')],
    ['reader grants device access', managedTopologyFixture.replace('  embed-next:\n', '  embed-next:\n    devices: [/dev/dri]\n')],
    ['duplicate manager environment key', managedTopologyFixture.replace('      EMBED_URL: http://embed:8080\n', '      EMBED_URL: http://embed:8080\n      EMBED_URL: http://web:8021\n')],
    ['duplicate reader service key', managedTopologyFixture.replace('    profiles: [embed-next]\n', '    profiles: [embed-next]\n    profiles: []\n')],
    ['second device overrides CPU', managedTopologyFixture.replace('      - "none"\n', '      - "none"\n      - "--device"\n      - "all"\n')],
    ['reader changes allowed network set', managedTopologyFixture.replace('networks: [default, models]', 'networks: [models]')],
    ['reader requests GPU', managedTopologyFixture.replace('      - "none"', '      - "all"')],
    ['reader writes models', managedTopologyFixture.replace(':/models:ro', ':/models:rw')],
    ['reader gains another mount', managedTopologyFixture.replace('    networks: [default, models]', '      - /var/run/docker.sock:/var/run/docker.sock:ro\n    networks: [default, models]')],
  ];
  for (const [name, text] of malformed) assert.throws(() => assertOverlayTopology(text), assert.AssertionError, name);
});
