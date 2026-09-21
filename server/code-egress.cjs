'use strict';
// Egress proxy for coding tasks (D15: allowlists are enforced at the proxy, not in the tool).
//
// A sandboxed task has no network at all unless it was granted one. When it was, its container
// reaches the internet only through this proxy, and the proxy is what decides — not the harness,
// not the model, not a tool description. The harness cannot talk itself past a rule it never
// sees, and an agent that ignores ACP and opens its own socket still lands here.
//
// Three properties do the work:
//   * Deny by default. No grant, no token, no match — no connection, and the refusal is logged
//     against the task.
//   * The allowlist is checked against the host the task asked for AND the address it actually
//     resolves to, and the connection is then made to that same address. A name that resolves
//     to something private, or re-resolves between check and connect (DNS rebinding), does not
//     get through.
//   * Credentials never cross. The proxy's own `Proxy-Authorization` is stripped before
//     forwarding, and the task holds a token scoped to itself that dies with the job.
const http = require('node:http'), net = require('node:net'), dns = require('node:dns'), crypto = require('node:crypto');
const { isPrivateIp } = require('./ssrf.cjs');

// Only the web ports. A task that needs a package registry needs 80/443; anything else
// (SSH, a database, a mail relay) is a different conversation with the user.
const ALLOWED_PORTS = Object.freeze([80, 443]);
const STATUS_TEXT = Object.freeze({ 400: 'Bad Request', 403: 'Forbidden', 407: 'Proxy Authentication Required', 502: 'Bad Gateway' });

/** Exact host or a subdomain of a granted domain; a lookalike suffix (`notexample.com`) is not. */
function hostAllowed(host, domains) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  return (domains || []).some((d) => {
    const domain = String(d || '').toLowerCase().replace(/^\.|\.$/g, '');
    return domain && (name === domain || name.endsWith('.' + domain));
  });
}

function parseTarget(raw, defaultPort) {
  const text = String(raw || '');
  const match = text.startsWith('[')
    ? text.match(/^\[([^\]]+)\](?::(\d+))?$/)        // [::1]:443
    : text.match(/^([^:/?#]+)(?::(\d+))?$/);
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : defaultPort;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: match[1].toLowerCase(), port };
}

/**
 * @param {{now?: () => number, log?: (entry: object) => void,
 *          lookup?: (host: string) => Promise<string[]>,
 *          isPublicAddress?: (ip: string) => boolean,
 *          connect?: (opts: {address: string, port: number, host: string}) => import('node:net').Socket}} deps
 */
function createEgressProxy({ now = Date.now, log = () => {}, lookup = defaultLookup,
  isPublicAddress = (ip) => !isPrivateIp(ip), connect = defaultConnect, allowedPorts = ALLOWED_PORTS } = {}) {
  const ports = new Set(allowedPorts);
  const grants = new Map(); // token -> { taskId, domains, grantedAt }

  /** Capability sets are fixed at creation (§4): a grant is written once and never widened. */
  function grant({ taskId, domains = [] }) {
    if (!taskId) throw Object.assign(Error('taskId required'), { status: 400 });
    for (const [token, g] of grants) if (g.taskId === taskId) grants.delete(token);
    const token = crypto.randomBytes(32).toString('base64url');
    grants.set(token, { taskId, domains: [...domains], grantedAt: now() });
    return { token, taskId, domains: [...domains] };
  }
  function revoke(taskId) {
    let removed = 0;
    for (const [token, g] of grants) if (g.taskId === taskId) { grants.delete(token); removed++; }
    return removed;
  }
  /** Constant-time token compare, so a wrong token leaks nothing by how long it took. */
  function authorize(header) {
    const raw = /^Basic\s+(\S+)$/i.exec(String(header || ''))?.[1];
    if (!raw) return null;
    let decoded; try { decoded = Buffer.from(raw, 'base64').toString('utf8'); } catch { return null; }
    const token = decoded.slice(decoded.indexOf(':') + 1);
    const wanted = Buffer.from(token);
    for (const [known, g] of grants) {
      const candidate = Buffer.from(known);
      if (candidate.length === wanted.length && crypto.timingSafeEqual(candidate, wanted)) return g;
    }
    return null;
  }

  /** Decide, and say why. Returns the address to connect to, so nothing re-resolves later. */
  async function check({ header, target, defaultPort }) {
    const g = authorize(header);
    if (!g) return { ok: false, status: 407, reason: 'no valid task token' };
    const parsed = parseTarget(target, defaultPort);
    if (!parsed) return { ok: false, status: 400, reason: 'unreadable target', taskId: g.taskId };
    const { host, port } = parsed;
    if (!ports.has(port)) return { ok: false, status: 403, reason: `port ${port} is not allowed`, taskId: g.taskId, host };
    if (!hostAllowed(host, g.domains)) return { ok: false, status: 403, reason: 'host is not on this task’s list', taskId: g.taskId, host };
    // An IP literal is judged directly; a name is resolved, and every answer must be public.
    let addresses;
    if (net.isIP(host)) addresses = [host];
    else { try { addresses = await lookup(host); } catch { addresses = []; } }
    if (!addresses.length) return { ok: false, status: 502, reason: 'host does not resolve', taskId: g.taskId, host };
    if (!addresses.every(isPublicAddress)) return { ok: false, status: 403, reason: 'host resolves to a private address', taskId: g.taskId, host };
    return { ok: true, taskId: g.taskId, host, port, address: addresses[0] };
  }

  function record(entry) { log({ at: now(), ...entry }); }

  const server = http.createServer();

  // Plain HTTP: the client sends an absolute URL. Forwarded to the address we checked.
  server.on('request', async (req, res) => {
    // Attached before anything can await: deciding a verdict involves a DNS lookup, and a task's
    // container being killed mid-request resets the connection. An 'error' with no listener is
    // an uncaught exception, and this proxy runs inside the web process — so that is the whole
    // server, taken down by a cancelled coding task.
    req.on('error', () => {});
    res.on('error', () => {});
    const url = (() => { try { return new URL(req.url); } catch { return null; } })();
    const verdict = await check({ header: req.headers['proxy-authorization'],
      target: url ? url.host : null, defaultPort: 80 });
    if (!verdict.ok) return refuse(res, verdict, record);
    record({ event: 'egress.allowed', taskId: verdict.taskId, host: verdict.host, port: verdict.port, method: req.method });

    const headers = { ...req.headers };
    delete headers['proxy-authorization'];       // never travels onward
    delete headers['proxy-connection'];
    headers.host = url.host;
    const upstream = http.request({ host: verdict.address, port: verdict.port, method: req.method,
      path: url.pathname + url.search, headers, setHost: false }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Upstream failed\n'); });
    req.pipe(upstream);
  });

  // HTTPS: CONNECT tunnel. The proxy never sees the plaintext; it only decides where the
  // tunnel may go, which is the whole point of enforcing here rather than in a tool.
  server.on('connect', async (req, clientSocket, head) => {
    // Same reason as above, and more so: a CONNECT socket is detached from the HTTP server's own
    // error handling, so nothing else is watching it.
    clientSocket.on('error', () => {});
    const verdict = await check({ header: req.headers['proxy-authorization'], target: req.url, defaultPort: 443 });
    if (clientSocket.destroyed) return;
    if (!verdict.ok) {
      record({ event: 'egress.refused', ...verdict, ok: undefined });
      // A refused CONNECT is answered as a normal HTTP response on the same socket, which is
      // what curl, npm and pip expect, and then closed. (Node's own HTTP client does not
      // surface a non-2xx CONNECT reply at all, so the test reads these bytes directly.)
      const lines = [`HTTP/1.1 ${verdict.status} ${STATUS_TEXT[verdict.status] || 'Forbidden'}`];
      if (verdict.status === 407) lines.push('Proxy-Authenticate: Basic realm="noevia task"');
      lines.push('Content-Length: 0', 'Connection: close', '', '');
      clientSocket.end(lines.join('\r\n'));
      return;
    }
    record({ event: 'egress.allowed', taskId: verdict.taskId, host: verdict.host, port: verdict.port, method: 'CONNECT' });
    const upstream = connect({ address: verdict.address, port: verdict.port, host: verdict.host });
    upstream.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const drop = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('error', drop);
    clientSocket.on('error', drop);
    clientSocket.on('close', () => upstream.destroy());
  });

  return { server, grant, revoke, check, hostAllowed,
    /** Drop every live connection too: a tunnel outlives the listener otherwise. */
    closeAll: () => { server.closeAllConnections?.(); },
    listen: (port = 0, host = '127.0.0.1') => new Promise((r) => server.listen(port, host, () => r(server.address()))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

function refuse(res, verdict, record) {
  record({ event: 'egress.refused', ...verdict, ok: undefined });
  const headers = { 'content-type': 'text/plain' };
  if (verdict.status === 407) headers['proxy-authenticate'] = 'Basic realm="noevia task"';
  res.writeHead(verdict.status, headers);
  res.end(`Refused: ${verdict.reason}\n`);
}

async function defaultLookup(host) {
  const answers = await dns.promises.lookup(host, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}
function defaultConnect({ address, port }) { return net.connect(port, address); }

/**
 * The proxy as a deployment runs it: on `CODE_EGRESS_PORT` inside the web process, reached by the
 * sandbox as `CODE_EGRESS_HOST` (a network alias on the internal code network). Unset, there is
 * no proxy, and Code mode keeps network and installs unavailable rather than pretending.
 */
function startEgressFromEnv(env = process.env, { log = () => {}, create = createEgressProxy } = {}) {
  const port = Number(env.CODE_EGRESS_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const host = String(env.CODE_EGRESS_HOST || 'egress').trim();
  if (!/^[a-z0-9.-]+$/i.test(host)) throw Error(`CODE_EGRESS_HOST should be a host name, not "${host}"`);
  const proxy = create({ log });
  proxy.server.listen(port, env.CODE_EGRESS_BIND || '0.0.0.0');
  return Object.assign(proxy, { endpoint: `${host}:${port}` });
}

module.exports = { createEgressProxy, hostAllowed, parseTarget, startEgressFromEnv };
