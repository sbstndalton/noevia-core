const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '../..');

// This is what the Docker build actually does: compose.yaml passes
// COWORK_VERSION as a build arg, and apps/web/Dockerfile exports it as
// STAMP_VERSION before `npm run build` runs. If that chain ever breaks, the
// release SHA never reaches version.json/__NOEVIA_BUILD__, package.json's
// static version gets stamped every time, and the stale-shell guard
// (src/stale-shell-guard.ts) and favicon cache-busting go silently inert in
// production (issue #311 regressed). This builds through the real
// scripts/build.cjs entry point with STAMP_VERSION set, the same as the
// Docker build, and asserts the release identifier actually made it through.
test('a release SHA passed as STAMP_VERSION reaches dist/version.json, the stamped icon/manifest URLs, and the bundle', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-build-stamp-'));
  const outDir = path.join(runtimeDir, 'dist');
  const sha = 'deadbee';
  try {
    const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.cjs'), '--outDir', outDir], {
      cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, STAMP_VERSION: sha },
    });
    assert.equal(build.status, 0, `build failed:\n${build.stdout}\n${build.stderr}`);

    const version = JSON.parse(fs.readFileSync(path.join(outDir, 'version.json'), 'utf8'));
    assert.equal(version.version, sha);
    // The Docker runtime has no build-stage STAMP_VERSION. Its resolver must
    // report the exact artifact version that the static server serves.
    const serverDir = path.join(runtimeDir, 'server');
    fs.mkdirSync(serverDir);
    fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    const { resolveVersion } = require('../../server/version-resolve.cjs');
    const { createReadyRoutes } = require('../../server/routes/health.cjs');
    let ready;
    const route = createReadyRoutes({ json: (_res, status, body) => { ready = { status, body }; }, isReady: () => true, version: resolveVersion({}, serverDir) });
    route({ method: 'GET' }, {}, { path: '/api/ready' });
    assert.deepEqual(ready, { status: 200, body: { ready: true, version: sha } });

    const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.match(html, new RegExp(`href="/icon\\.svg\\?v=${sha}"`));

    const manifest = fs.readFileSync(path.join(outDir, 'manifest.webmanifest'), 'utf8');
    assert.match(manifest, new RegExp(`\\?v=${sha}"`));

    // __NOEVIA_BUILD__ is inlined by esbuild/rollup as a bare string literal
    // wherever it's referenced (src/stale-shell-guard.ts), so it shows up
    // verbatim in whichever chunk that module landed in.
    const chunkFiles = fs.readdirSync(path.join(outDir, 'assets')).filter((f) => f.endsWith('.js'));
    const hasSha = chunkFiles.some((f) => fs.readFileSync(path.join(outDir, 'assets', f), 'utf8').includes(`"${sha}"`));
    assert.ok(hasSha, `expected "${sha}" baked into one of: ${chunkFiles.join(', ')}`);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('COWORK_VERSION default ("dev", unset) still produces a usable, non-colliding version rather than a literal "dev" stamp', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-build-stamp-dev-'));
  try {
    const build = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.cjs'), '--outDir', outDir], {
      cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, STAMP_VERSION: 'dev' },
    });
    assert.equal(build.status, 0, `build failed:\n${build.stdout}\n${build.stderr}`);
    const version = JSON.parse(fs.readFileSync(path.join(outDir, 'version.json'), 'utf8'));
    assert.notEqual(version.version, 'dev');
    assert.match(version.version, /^\d+\.\d+\.\d+\+[a-z0-9]+$/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
