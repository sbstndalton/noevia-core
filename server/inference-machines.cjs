'use strict';
// #1638: Settings → Inference machines. The machines noevia's model-backed services may run on, and
// which machine each service is on.
//
// Default: everything on this one machine. "This machine" (id 'local') is built in and cannot be
// removed; a service on it reads exactly what it read before this module existed (the deployment's
// environment, or the setting an administrator saved for that service). So a single-box install with
// nothing saved here behaves as before, and the environment (COWORK_DECISION_URL, EMBEDDING_BASE_URL,
// RERANK_*, ...) only seeds those defaults.
//
// A machine is a name and an address (http(s) and a host, no port: each service on it has its own).
// The address must be on this network: the shared rule of service-endpoint.cjs (#1755), with
// link-local refused, checked when the machine is saved (a name must resolve only to such addresses;
// a name that does not resolve now is kept, marked unresolved) and again at connect time by every
// consumer's own fetch. There is no public-address override: the services that can move (decision,
// embeddings, reranker) are local-only by policy (#1760, #1762), so a public machine could not serve
// any of them (an explicit override is #1842, an owner decision).
//
// What can move, and how:
//   decision   runtime: decision-settings.cjs reads urlFor('decision') before its own saved URL / env.
//   reranker   runtime: rerank-settings.cjs maps its choice to the machine's address (protocol tei or llamacpp).
//   embedding  through the #1636 re-index only (embedding-migration.cjs via POST /api/embedding): its
//              machine is derived from the active embedding target, never saved here, so the stored
//              vectors and the endpoint can never disagree. assign() refuses it with the target to re-index to.
//   chat roles (fast, smart, code, creative) and vision  (#1840): runtime, through chat-machines.cjs. The
//              assignment names the port of the machine's OpenAI-compatible server (llama.cpp) and the
//              model it serves for the role (from its /v1/models; never a file name). A role on a machine
//              is not loaded on this machine's engine and does not count against its memory budget. The
//              role's own pick in Models & routing is kept, and used again when the role moves back here.
//   sensitivity runtime (#1844): the sensitivity check's own decision service. decision-settings.cjs sensitivityBackend()
//              reads urlFor('sensitivity') before COWORK_SENSITIVITY_DECISION_URL; unassigned and with no URL of its own it
//              is shared with 'decision' and follows it. Link-local refused at connect time, and no key of another host.
//   ocr, documents  runtime (#1841): OCR (OCR_BASE_URL) and Docling (DOCLING_BASE_URL) via document-workers.cjs, the
//              environment being the fallback; reached through the on-this-network fetch.
//
// Persistence: the settings store (key inference:machines), every change audited.

const crypto = require('node:crypto');
const { parseServiceUrl, checkServiceEndpoint } = require('./service-endpoint.cjs');

const KEY = 'inference:machines';
const LOCAL_ID = 'local';
const MAX_MACHINES = 16;
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,60}$/;

/** Every part of noevia a machine can be named for, and how it moves. */
const SERVICES = Object.freeze({
  chatFast: { mode: 'chat', role: 'fast' },
  chatSmart: { mode: 'chat', role: 'smart' },
  chatCode: { mode: 'chat', role: 'code' },
  chatCreative: { mode: 'chat', role: 'creative' },
  vision: { mode: 'chat', role: 'vision' },
  decision: { mode: 'runtime' },
  sensitivity: { mode: 'runtime' },
  embedding: { mode: 'reindex' },
  reranker: { mode: 'runtime' },
  ocr: { mode: 'runtime' },
  documents: { mode: 'runtime' },
});
const WORKERS = new Set(['ocr', 'documents']);
const SERVICE_IDS = Object.freeze(Object.keys(SERVICES));
const RERANK_PROTOCOLS = new Set(['tei', 'llamacpp']);
/** #1840: the chat role -> its service id. */
const CHAT_ROLE_SERVICE = Object.freeze(Object.fromEntries(Object.entries(SERVICES).filter(([, d]) => d.mode === 'chat').map(([id, d]) => [d.role, id])));
const MODEL_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
/** A model name as the machine serves it, or null. */
const cleanModel = (raw) => { const m = typeof raw === 'string' ? raw.trim() : ''; return MODEL_RE.test(m) ? m : null; };

const fail = (status, code, message, extra = {}) => Object.assign(Error(message), { status, code, ...extra });

/**
 * A machine address as typed ("192.168.1.20", "http://pi5.lan", "https://box.tailnet.ts.net") ->
 * "http(s)://host". Throws (400) for anything else; the synchronous half of the network rule.
 */
function normalizeAddress(raw) {
  let text = String(raw ?? '').trim();
  if (!text) throw fail(400, 'invalidAddress', 'Enter the machine’s address, for example 192.168.1.20 or pi5.lan.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try { url = new URL(text); } catch { throw fail(400, 'invalidAddress', 'That is not a machine address.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail(400, 'invalidAddress', 'A machine address uses http or https.');
  if (url.port) throw fail(400, 'portInAddress', 'Leave the port out of the machine address: each service on it has its own port.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || /[?#]/.test(text)) throw fail(400, 'invalidAddress', 'A machine address is only http(s) and a host name or IP address.');
  const base = `${url.protocol}//${url.hostname}`;
  const parsed = parseServiceUrl(base, { paths: ['/'], linkLocal: false });
  if (parsed.reason) throw fail(400, 'publicAddress', `Machines must be on this network (a LAN or Tailscale address): ${parsed.reason}.`);
  return base;
}

function validPort(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw fail(400, 'invalidPort', 'Enter the service’s port, a number from 1 to 65535.');
  return n;
}

/** `http(s)://host` + port (+ path): where a service on a machine answers. */
const serviceUrl = (address, port, path = '') => `${address}:${port}${path}`;

/** The machine address part of a URL (`http(s)://host`), or null. */
function addressOf(value) {
  try {
    const u = new URL(String(value || '').trim());
    return `${u.protocol}//${u.hostname}`.toLowerCase();
  } catch { return null; }
}
const portOf = (value) => { try { const u = new URL(String(value || '').trim()); return u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80); } catch { return null; } };

function emptyState() { return { version: 1, machines: [], assignments: {} }; }

function readState(store, log) {
  let raw;
  try { raw = store.get(KEY); } catch { return emptyState(); }
  if (!raw) return emptyState();
  try {
    const s = JSON.parse(raw);
    if (!s || s.version !== 1 || !Array.isArray(s.machines) || typeof s.assignments !== 'object' || !s.assignments) throw Error('unknown shape');
    const machines = s.machines.filter((m) => m && typeof m.id === 'string' && m.id !== LOCAL_ID && typeof m.name === 'string' && typeof m.address === 'string')
      .map((m) => ({ id: m.id, name: m.name, address: m.address, ...(m.unresolved ? { unresolved: true } : {}) }));
    const ids = new Set(machines.map((m) => m.id));
    const assignments = {};
    for (const [service, a] of Object.entries(s.assignments)) {
      const mode = SERVICES[service]?.mode;
      if ((mode !== 'runtime' && mode !== 'chat') || !a || !ids.has(a.machine) || !Number.isInteger(a.port)) continue;
      // A chat role without a model it can name stays on this machine.
      if (mode === 'chat' && !cleanModel(a.model)) continue;
      assignments[service] = { machine: a.machine, port: a.port, ...(service === 'reranker' ? { protocol: RERANK_PROTOCOLS.has(a.protocol) ? a.protocol : 'tei' } : {}),
        ...(mode === 'chat' ? { model: cleanModel(a.model) } : {}), ...(mode === 'chat' && a.needsConfirm === true ? { needsConfirm: true } : {}) };
    }
    return { version: 1, machines, assignments };
  } catch (err) {
    // A damaged value must not move a service anywhere: every service stays on this machine.
    log(`[machines] the saved inference machines cannot be read (${err.message}); every service stays on this machine until they are saved again.`);
    return emptyState();
  }
}

/**
 * @param {object} o
 * @param {{get:Function,set:Function}} o.store       the settings store (features.cjs settingsStore)
 * @param {(action:string, actor:string|null, detail:object) => void} [o.audit]
 * @param {Function} [o.lookup]                       DNS lookup for the save-time check (tests stub it)
 * @param {() => ({baseUrl?:string|null, model:string, profile:string}|null)} [o.embeddingActive]  the active embedding target
 * @param {() => string|null} [o.localEmbeddingUrl]   where embeddings run on this machine (the deployment's address), or null
 * @param {(service:string) => boolean} [o.workerEnabled]  whether the OCR / Docling worker is switched on by the deployment (its env URL is set)
 * @param {(address:string, port:number) => Promise<string[]>} [o.modelsAt]  #1851: the models the server at an address serves (/v1/models); used to re-check chat assignments when a machine's address changes
 * @param {(service:string) => void} [o.onChange]     called after a change that moves `service` (or every service on a machine)
 */
function createInferenceMachines({ store, audit = () => {}, lookup, embeddingActive = () => null, localEmbeddingUrl = () => null, workerEnabled = (service) => !!String(process.env[service === 'ocr' ? 'OCR_BASE_URL' : 'DOCLING_BASE_URL'] || '').trim(), onChange = () => {}, modelsAt = null, log = (line) => console.warn(line) } = {}) {
  let state = readState(store, log);
  const machineById = (id) => state.machines.find((m) => m.id === id) || null;

  function save(next) {
    store.set(KEY, JSON.stringify(next));
    state = next;
  }

  /** The machine embeddings run on now, derived from the active target: 'local', a machine id, or 'other'. */
  function embeddingMachine() {
    let active = null;
    try { active = embeddingActive(); } catch { active = null; }
    const url = active?.baseUrl || null;
    if (!url) return { machine: LOCAL_ID, port: null, url: null };
    // #1979: a registered machine wins over everything else, so a remote machine whose address the deployment
    // also names (EMBEDDING_SERVICE_URL) is shown as that machine, not as this one.
    const host = addressOf(url);
    const hit = state.machines.find((m) => m.address.toLowerCase() === host);
    if (hit) return { machine: hit.id, port: portOf(url), url };
    // A Docker service name or loopback with no machine for it is this machine's own sidecar.
    try {
      const h = new URL(url).hostname;
      if (!h.includes('.') || h === 'localhost' || /^127\./.test(h) || h === '[::1]') return { machine: LOCAL_ID, port: null, url };
    } catch { /* fall through */ }
    // Last: an unregistered host the deployment itself names as where embeddings run on this machine.
    const local = localEmbeddingUrl();
    if (local && addressOf(local) === host && portOf(local) === portOf(url)) return { machine: LOCAL_ID, port: null, url };
    return { machine: 'other', port: portOf(url), url };
  }

  const workerOn = (id) => { try { return !!workerEnabled(id); } catch { return false; } };

  /** Where `service` is now: { machine, port?, protocol? }. */
  function assignmentOf(service) {
    if (service === 'embedding') { const e = embeddingMachine(); return { machine: e.machine, ...(e.port && e.machine !== LOCAL_ID ? { port: e.port } : {}) }; }
    const a = state.assignments[service];
    return a ? { ...a } : { machine: LOCAL_ID };
  }

  /** The base URL a runtime service must use instead of its own configuration, or null (this machine: unchanged). */
  function urlFor(service) {
    const a = SERVICES[service]?.mode === 'runtime' ? state.assignments[service] : null;
    const m = a ? machineById(a.machine) : null;
    return m ? serviceUrl(m.address, a.port) : null;
  }

  /**
   * #1840: where a chat role runs when it is on another machine, or null (this machine: unchanged).
   * @param {string} role  'fast' | 'smart' | 'code' | 'creative' | 'vision'
   * @returns {{ role:string, service:string, machine:{id:string,name:string,address:string}, port:number, model:string, baseUrl:string }|null}
   */
  function chatTarget(role) {
    const service = CHAT_ROLE_SERVICE[role];
    const a = service ? state.assignments[service] : null;
    const m = a ? machineById(a.machine) : null;
    return m && a.model ? { role, service, machine: { id: m.id, name: m.name, address: m.address }, port: a.port, model: a.model, baseUrl: serviceUrl(m.address, a.port), ...(a.needsConfirm ? { needsConfirm: true } : {}) } : null;
  }

  /** #1665: the wire protocol of a reranker assigned to a machine ('tei' | 'llamacpp'), or null. */
  const rerankProtocol = () => (state.assignments.reranker && machineById(state.assignments.reranker.machine) ? state.assignments.reranker.protocol || 'tei' : null);

  function servicesOn(id) {
    return SERVICE_IDS.filter((s) => assignmentOf(s).machine === id);
  }

  function view() {
    return {
      machines: [
        { id: LOCAL_ID, builtIn: true, name: null, address: null, services: servicesOn(LOCAL_ID) },
        ...state.machines.map((m) => ({ id: m.id, name: m.name, address: m.address, ...(m.unresolved ? { unresolved: true } : {}), services: servicesOn(m.id) })),
      ],
      // #1847: OCR and Docling are switched on by the deployment only; `enabled: false` tells the page there is nothing to move.
      services: SERVICE_IDS.map((id) => ({ id, mode: SERVICES[id].mode, ...assignmentOf(id), ...(WORKERS.has(id) ? { enabled: workerOn(id) } : {}) })),
    };
  }

  async function checkAddress(address) {
    const r = await checkServiceEndpoint(address, { paths: ['/'], linkLocal: false, ...(lookup ? { lookup } : {}) });
    if (!r.ok && !r.transient) throw fail(400, 'publicAddress', `Machines must be on this network (a LAN or Tailscale address): ${r.reason}.`);
    return !r.ok; // true: the name does not resolve now (kept, checked again at connect time)
  }

  function cleanName(raw) {
    const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(name)) throw fail(400, 'invalidName', 'Give the machine a name of up to 60 characters.');
    return name;
  }

  async function add(body, actor) {
    const name = cleanName(body?.name);
    const address = normalizeAddress(body?.address);
    const unresolved = await checkAddress(address);
    if (state.machines.length >= MAX_MACHINES) throw fail(409, 'tooMany', `At most ${MAX_MACHINES} machines can be added.`);
    if (state.machines.some((m) => m.name.toLowerCase() === name.toLowerCase())) throw fail(409, 'duplicateName', 'Another machine already has that name.');
    if (state.machines.some((m) => m.address.toLowerCase() === address.toLowerCase())) throw fail(409, 'duplicateAddress', 'Another machine already has that address.');
    const machine = { id: `m_${crypto.randomBytes(6).toString('hex')}`, name, address, ...(unresolved ? { unresolved: true } : {}) };
    save({ ...state, machines: [...state.machines, machine] });
    audit('machines.add', actor, { id: machine.id, name, address, unresolved });
    return { machine, ...view() };
  }

  async function update(body, actor) {
    const current = machineById(String(body?.id || ''));
    if (!current) throw fail(404, 'unknownMachine', 'That machine is not on the list.');
    const name = body.name === undefined ? current.name : cleanName(body.name);
    const address = body.address === undefined ? current.address : normalizeAddress(body.address);
    const moved = address.toLowerCase() !== current.address.toLowerCase();
    const unresolved = moved ? await checkAddress(address) : !!current.unresolved;
    // #1851: a chat role keeps the model it was saved with, but the server now at the new address may serve another. Ask it
    // (the on-this-network fetch, bounded) for each chat assignment here; a model it no longer lists marks the assignment
    // `needsConfirm`. The mark changes nothing by itself: the turn check (chat-machines.cjs ready) already fails a turn
    // whose model is not served; the mark is what Settings shows ("confirm the model"), and saving the assignment again clears it.
    const recheck = new Set();
    if (moved && typeof modelsAt === 'function') {
      const chatHere = Object.entries(state.assignments).filter(([s, a]) => a.machine === current.id && SERVICES[s]?.mode === 'chat');
      await Promise.all(chatHere.map(async ([service, a]) => {
        try { if (!(await modelsAt(address, a.port)).includes(a.model)) recheck.add(service); } catch { /* not answering now: the turn check says so; nothing to confirm yet */ }
      }));
    }
    // Re-read after the lookup: another request may have changed the list meanwhile.
    const again = machineById(current.id);
    if (!again) throw fail(404, 'unknownMachine', 'That machine is not on the list.');
    if (state.machines.some((m) => m.id !== current.id && m.name.toLowerCase() === name.toLowerCase())) throw fail(409, 'duplicateName', 'Another machine already has that name.');
    if (moved && state.machines.some((m) => m.id !== current.id && m.address.toLowerCase() === address.toLowerCase())) throw fail(409, 'duplicateAddress', 'Another machine already has that address.');
    // Embeddings follow their address only through a re-index; a new address under them would orphan it.
    if (moved && embeddingMachine().machine === current.id) throw fail(409, 'embeddingOnMachine', 'Embeddings run on this machine. Move them to another machine first, then change its address.');
    const machine = { id: current.id, name, address, ...(unresolved ? { unresolved: true } : {}) };
    const assignments = { ...state.assignments };
    for (const service of Object.keys(assignments)) {
      if (assignments[service].machine !== current.id || SERVICES[service]?.mode !== 'chat') continue;
      if (moved) { const { needsConfirm: _old, ...rest } = assignments[service]; assignments[service] = recheck.has(service) ? { ...rest, needsConfirm: true } : rest; }
    }
    save({ ...state, machines: state.machines.map((m) => (m.id === current.id ? machine : m)), assignments });
    audit('machines.update', actor, { id: machine.id, name, address, moved, unresolved, ...(recheck.size ? { needsConfirm: [...recheck] } : {}) });
    if (moved) for (const s of Object.keys(state.assignments)) if (state.assignments[s].machine === current.id) onChange(s);
    return { machine, ...view() };
  }

  function remove(body, actor) {
    const current = machineById(String(body?.id || ''));
    if (!current) throw fail(404, 'unknownMachine', 'That machine is not on the list.');
    const using = servicesOn(current.id);
    if (using.length) throw fail(409, 'inUse', 'Move the services on this machine to another machine before removing it.', { services: using });
    save({ ...state, machines: state.machines.filter((m) => m.id !== current.id) });
    audit('machines.remove', actor, { id: current.id, name: current.name });
    return view();
  }

  /** Moves `service` to `machine` ('local' or an id) on `port`. Embeddings answer 409 reindexRequired with the target. */
  function assign(body, actor) {
    const service = String(body?.service || '');
    const def = SERVICES[service];
    if (!def) throw fail(400, 'unknownService', 'That is not a part of noevia that can be assigned.');
    const machineId = String(body?.machine || '');
    const machine = machineId === LOCAL_ID ? null : machineById(machineId);
    if (machineId !== LOCAL_ID && !machine) throw fail(404, 'unknownMachine', 'That machine is not on the list.');
    // #1847: assigning a machine must never switch a worker on: that changes the extractor version and re-reads every document.
    if (WORKERS.has(service) && machine && !workerOn(service)) throw fail(409, 'workerNotEnabled', 'Turn this service on in the deployment first; assigning a machine does not switch it on.');
    if (def.mode === 'deployment' && machine) throw fail(409, 'setByDeployment', 'This service’s address is set by the deployment.');
    if (def.mode === 'deployment') return view(); // already on this machine: nothing to do
    if (def.mode === 'reindex') {
      let active = null;
      try { active = embeddingActive(); } catch { active = null; }
      if (!active || !active.model) throw fail(409, 'embeddingOff', 'Embeddings are not set up, so there is nothing to move.');
      const now = embeddingMachine();
      if (now.machine === (machine ? machine.id : LOCAL_ID) && (!machine || now.port === validPort(body.port))) return view(); // already there
      const baseUrl = machine ? serviceUrl(machine.address, validPort(body.port), '/v1') : localEmbeddingUrl();
      // #1979: a deployment address that is a registered machine is that machine, not this one: moving "back" would re-index onto it.
      const localIsRegistered = !machine && !!baseUrl && state.machines.some((m) => m.address.toLowerCase() === addressOf(baseUrl));
      if (!machine && (!baseUrl || localIsRegistered)) throw fail(409, 'noLocalEmbedding', 'This deployment names no embeddings server on this machine, so embeddings cannot move back here from Settings.');
      // Not saved here: the re-index (POST /api/embedding set-next, switch, finish) is the one path that moves them.
      throw fail(409, 'reindexRequired', 'Moving embeddings re-indexes projects and the Diary first.', { target: { baseUrl, model: active.model, profile: active.profile } });
    }
    const port = machine ? validPort(body.port) : null;
    let protocol;
    if (service === 'reranker' && machine) {
      protocol = body.protocol === undefined ? (state.assignments.reranker?.protocol || 'tei') : String(body.protocol);
      if (!RERANK_PROTOCOLS.has(protocol)) throw fail(400, 'invalidProtocol', 'Choose how the reranker answers: tei or llamacpp.');
    }
    let model;
    if (def.mode === 'chat' && machine) {
      model = cleanModel(body.model);
      if (!model) throw fail(400, 'invalidModel', 'Choose the model this machine serves for the role.');
    }
    const assignments = { ...state.assignments };
    const before = assignments[service] || null;
    if (machine) assignments[service] = { machine: machine.id, port, ...(protocol ? { protocol } : {}), ...(model ? { model } : {}) };
    else delete assignments[service];
    save({ ...state, assignments });
    audit('machines.assign', actor, { service, machine: machine ? machine.id : LOCAL_ID, ...(port ? { port } : {}), ...(protocol ? { protocol } : {}), ...(model ? { model } : {}), from: before ? before.machine : LOCAL_ID });
    onChange(service);
    return view();
  }

  return { view, add, update, remove, assign, urlFor, chatTarget, assignmentOf, rerankProtocol, embeddingMachine, machine: machineById };
}

module.exports = { createInferenceMachines, normalizeAddress, serviceUrl, addressOf, cleanModel, SERVICES, SERVICE_IDS, CHAT_ROLE_SERVICE, LOCAL_ID, KEY };
