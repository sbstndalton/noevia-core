#!/usr/bin/env node
'use strict';
// Required synthetic front contracts for noevia#1271. No model/chat requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { SERVER, GUARD, startMocks, serverEnv } = require('../contract-corpus/mocks.cjs');
const { requireScan, requireReducedPdf, REDUCED_CAP } = require('./contracts.cjs');
const required = name => { assert.ok(process.env[name], `${name} is required; this gate cannot skip`); return path.resolve(process.env[name]); };
const children = new Set();
function child(command, args, env) {
  const proc = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(proc);
  let errors = '';
  proc.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
  proc.on('error', error => { errors += error.message; });
  proc.failure = () => errors;
  return proc;
}
async function stop(proc) {
  if (!proc || !proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  const done = once(proc, 'exit');
  proc.kill('SIGTERM');
  const timeout = setTimeout(() => proc.kill('SIGKILL'), 3000);
  await done;
  clearTimeout(timeout);
  children.delete(proc);
}
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}
async function port() { const server = await listen(); const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result; }
async function ready(base, route, proc) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    assert.equal(proc.exitCode, null, `process exited: ${proc.failure()}`);
    try { const response = await fetch(base + route); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`readiness failed: ${proc.failure()}`);
}
class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); }
  async call(method, route, body, status = 200) {
    const headers = { Origin: this.base };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    if (this.cookies.has('cowork_csrf')) headers['X-CSRF-Token'] = this.cookies.get('cowork_csrf');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(this.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(240000) });
    for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const i = pair.indexOf('='); this.cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${route}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  async download(route) {
    const response = await fetch(this.base + route, { headers: { Origin: this.base, Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, 'authenticated reduced original download must succeed');
    const contentLength = response.headers.get('content-length');
    assert.ok(Number(contentLength) > 0 && Number(contentLength) <= REDUCED_CAP, 'reduced download declared length must fit cap');
    const chunks = []; let count = 0;
    for await (const chunk of response.body) {
      count += chunk.length;
      assert.ok(count <= REDUCED_CAP, 'reduced download stream must fit cap');
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), contentLength, contentType: response.headers.get('content-type') };
  }

}
async function scenario(front, mode, workerBase, fixtures, root, calls) {
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'));
  const mocks = await startMocks();
  // Relay records real worker calls. Controls alter only OCR; all authentication,
  // front forwarding, native PDF parsing and tenant checks remain real.
  const relay = await listen(async (req, res) => {
    try {
      const parts = []; for await (const part of req) parts.push(part);
      const bytes = Buffer.concat(parts);
      calls.push({ path: req.url, bytes: bytes.length, pages: req.headers['x-ocr-pages'] });
      if (req.url === '/extract' && mode !== 'good') {
        res.writeHead(mode === 'unavailable' ? 503 : 200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(mode === 'unavailable' ? { error: 'synthetic worker outage' } : { pages: [{ number: 1, text: 'REF-9999 TOTAL 00.00', truncated: false }] }));
      }
      const result = await fetch(workerBase + req.url, { method: req.method, headers: { 'Content-Type': req.headers['content-type'], ...(req.headers['x-ocr-pages'] ? { 'X-OCR-Pages': req.headers['x-ocr-pages'] } : {}) }, body: bytes, signal: AbortSignal.timeout(200000) });
      res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(Buffer.from(await result.arrayBuffer()));
    } catch { res.writeHead(502); res.end('{"error":"synthetic relay failure"}'); }
  });
  const nodePort = await port(); const frontPort = front ? await port() : nodePort;
  const base = `http://127.0.0.1:${frontPort}`;
  const env = serverEnv({ port: nodePort, dataDir, origin: base, mocks });
  env.OCR_BASE_URL = `http://127.0.0.1:${relay.address().port}`;
  env.NOEVIA_CORPUS_ALLOWED_PORTS += `,${relay.address().port}`;
  const node = child(process.execPath, ['--require', GUARD, SERVER], env);
  let rust;
  try {
    await ready(`http://127.0.0.1:${nodePort}`, '/api/ready', node);
    if (front) {
      rust = child(front, [], { PATH: process.env.PATH, UI_PORT: String(frontPort), UI_HOST: '127.0.0.1', UI_DATA_DIR: dataDir, PUBLIC_ORIGIN: base, NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH: '0', NOEVIA_RUST_PROJECTS: '0', NOEVIA_LEGACY_UPSTREAM: `http://127.0.0.1:${nodePort}` });
      await ready(base, '/api/ready', rust);
    }
    const admin = new Client(base); const member = new Client(base);
    await admin.call('POST', '/api/setup/complete', { setupCode: fs.readFileSync(path.join(dataDir, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: base, username: 'synthetic-admin', displayName: 'Synthetic Admin', password: 'synthetic-OCR-front-1271-password', diaryEnabled: false }, 201);
    const created = await admin.call('POST', '/api/projects', { name: 'Synthetic OCR contract', goal: 'Synthetic documents only' });
    const id = created.id || created.project?.id; assert.ok(id);
    const route = `/api/projects/${encodeURIComponent(id)}`;
    const upload = async name => admin.call('POST', route + '/upload', { name, organized: true, dataBase64: fs.readFileSync(path.join(fixtures, name)).toString('base64') });
    const scan = await upload('scan.pdf');
    let pages;
    if (scan.document?.state === 'ready') pages = await admin.call('GET', route + '/documents/pages?name=scan.pdf');
    // Negative controls must fail this precise oracle, not a boot/setup failure.
    if (mode !== 'good') {
      assert.throws(() => requireScan(scan, pages || {}), /native OCR must/);
      assert.equal(calls.filter(call => call.path === '/extract').length, 1);
      return { control: mode, detected: true };
    }
    requireScan(scan, pages);
    console.log(`PASS: ${front ? 'Rust front' : 'Node reference'} recovered every scan row via native OCR`);
    const docx = await upload('body.docx');
    assert.equal(docx.attachment.state, 'partial');
    console.log(`PASS: ${front ? 'Rust front' : 'Node reference'} dispatched DOCX extraction`);
    const large = await upload('large.pdf');
    assert.ok(large.bytes <= 25 * 1024 * 1024);
    assert.equal(large.attachment.reduction.originalBytes, fs.statSync(path.join(fixtures, 'large.pdf')).size);
    assert.ok(['pdf', 'text'].includes(large.attachment.reduction.kind));
    const workspace = await admin.call('GET', '/api/workspace');
    const project = workspace.projects.find(item => item.id === id);
    assert.ok(project, 'synthetic project must be present in its tenant workspace');
    const files = project.files; assert.ok(Array.isArray(files));
    assert.ok(files.find(file => file.name === 'body.docx')?.content.includes('SYNTHETIC DOCX REF 1271'));
    assert.ok(files.find(file => file.name === large.path)?.content.includes('SYNTHETIC NATIVE TEXT FOR REDUCTION'));
    const invite = await admin.call('POST', '/api/admin/invitations', { role: 'member' }, 201);
    await member.call('POST', '/api/auth/invitations/accept', { token: invite.token, username: 'synthetic-member', displayName: 'Synthetic Member', password: 'synthetic-member-1271-password', diaryEnabled: false }, 201);
    const before = calls.length;
    const deniedPages = await member.call('GET', route + '/documents/pages?name=scan.pdf', undefined, 404);
    const deniedOriginal = await member.call('GET', route + '/documents/original?name=scan.pdf', undefined, 404);
    const deniedUpload = await member.call('POST', route + '/upload', { name: 'scan.pdf', organized: true, dataBase64: fs.readFileSync(path.join(fixtures, 'scan.pdf')).toString('base64') }, 404);
    assert.equal(calls.length, before, 'tenant refusal must precede worker dispatch');
    assert.deepEqual(calls.map(call => call.path).sort(), ['/extract', '/extract-docx', '/reduce-pdf']);
    assert.equal(calls.find(call => call.path === '/extract').pages, '[1]');
    assert.ok(calls.find(call => call.path === '/reduce-pdf').bytes > 25 * 1024 * 1024);
    // Compare complete upload and page response bodies, plus persisted source
    // content/attachment/document contracts; omit only background index progress.
    // Ghostscript embeds generation metadata, so a reduced PDF's byte
    // fingerprint and length can differ between runs. Validate actual downloads before
    // binding only those derived identities and the five byte counts,
    // preserving their relationships just as the broad replayer binds IDs.
    const reduced = files.find(file => file.name === large.path);
    let comparedLarge = large, comparedReduced = reduced;
    if (large.attachment.reduction.kind === 'pdf') {
      const downloaded = await admin.download(route + '/documents/original?name=' + encodeURIComponent(large.path));
      const saved = path.join(dataDir, 'downloaded-reduced-contract.pdf');
      fs.writeFileSync(saved, downloaded.bytes);
      const text = spawnSync('pdftotext', [saved, '-'], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
      assert.equal(text.status, 0, 'downloaded reduced PDF text extraction must succeed');
      const info = spawnSync('pdfinfo', [saved], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
      assert.equal(info.status, 0, 'downloaded reduced PDF page count must succeed');
      const pages = Number(/^Pages:\s+(\d+)$/m.exec(info.stdout)?.[1]);
      ({ large: comparedLarge, reduced: comparedReduced } = requireReducedPdf(large, reduced, downloaded, { text: text.stdout, pages }));
    }

    if (large.document) assert.equal(large.attachment.id, large.document.byteHash);
    const identities = new Map([[large.attachment.id, '<reduced-bytes>']]);
    if (reduced.document?.version) identities.set(reduced.document.version, '<reduced-version>');
    const stable = value => JSON.parse(JSON.stringify(value), (key, item) => {
      if (key === 'indexing') return undefined;
      if (typeof item !== 'string') return item;
      for (const [identity, replacement] of identities) item = item.replaceAll(identity, replacement);
      return key === 'notice' ? item.replace(/; index: [a-z]+\.$/, '; index: <progress>.') : item;
    });
    return stable({ scan, pages, docx, large: comparedLarge, files: files.map(file => file === reduced ? comparedReduced : file).map(({ name, content, document, attachment }) => ({ name, content, document, attachment })), deniedPages, deniedOriginal, deniedUpload });
  } finally {
    await stop(rust); await stop(node); mocks.close(); relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
async function main() {
  const front = required('NOEVIA_OCR_FRONT_BIN'); const worker = required('NOEVIA_OCR_NATIVE_BIN'); const services = required('NOEVIA_OCR_FIXTURE_SOURCE');
  for (const [engine, option] of [['tesseract', '--version'], ['gs', '--version'], ['pdftoppm', '-v'], ['pdftotext', '-v'], ['pdfinfo', '-v']]) {
    const probe = spawnSync(engine, [option], { encoding: 'utf8' });
    assert.equal(probe.status, 0, `${engine} is required; this gate cannot skip`);
  }
  const features = spawnSync(worker, ['--features'], { encoding: 'utf8' });
  assert.equal(features.status, 0, 'native OCR feature probe must succeed');
  assert.ok(features.stdout.split('\n').includes('native-ocr'), 'native OCR required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-ocr-front-'));
  let native;
  try {
    const fixtures = path.join(root, 'fixtures');
    const generated = spawnSync('python3', [path.join(__dirname, 'fixtures.py'), services, fixtures], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const textLayer = spawnSync('pdftotext', [path.join(fixtures, 'scan.pdf'), '-'], { encoding: 'utf8' });
    assert.equal(textLayer.status, 0, 'Poppler is required');
    assert.equal(textLayer.stdout.trim(), '', 'synthetic scan must have no native text layer');
    const workerPort = await port(); const workerBase = `http://127.0.0.1:${workerPort}`;
    native = child(worker, [], { PATH: process.env.PATH, NOEVIA_OCR_IMPL: 'rust', NOEVIA_OCR_LISTEN: `127.0.0.1:${workerPort}` });
    await ready(workerBase, '/health', native);
    // Run controls first so a later front forwarding gap still records proof
    // that failures are detected; any failed positive keeps the job red.
    for (const mode of ['unavailable', 'incorrect']) {
      await scenario(front, mode, workerBase, fixtures, root, []);
      console.log(`PASS: ${mode} native OCR rejected by the same scan oracle`);
    }
    const reference = await scenario(null, 'good', workerBase, fixtures, root, []);
    const actual = await scenario(front, 'good', workerBase, fixtures, root, []);
    assert.deepEqual(actual, reference, 'Rust front document contracts must have zero diffs');
    console.log('PASS: native OCR/DOCX/reduction through Rust front; zero document contract diffs; tenant isolation');
  } finally { await stop(native); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(async error => { console.error(error); await Promise.all([...children].map(stop)); process.exitCode = 1; });
