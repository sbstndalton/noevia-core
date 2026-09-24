'use strict';
// Attributable model evidence import (#266): alongside a model download, fetch permitted
// public model-card metadata (license, task, benchmark claims as published by the source)
// for the exact repository the artifact came from, and record it as external evidence —
// separate from the local benchmark/calibration evidence in evidence.cjs. This never blocks
// or gates the download itself: every caller here is best-effort and swallows its own errors.
//
// Trust boundary: the source host is a fixed allow-list entry (Hugging Face), never a
// user-supplied URL. The repository name is validated before it is interpolated into the
// URL. The response is treated as untrusted text: every field is stripped of markup/control
// characters and capped in length before it is stored or rendered. Requests use the shared
// fetchJson helper (timeout + response-size cap) and never follow a redirect.

const evidenceLib = require('./evidence.cjs');

const ALLOWED_HOSTS = new Set(['huggingface.co']);
const CHECKPOINT_RE = /^[\w.-]+\/[\w.-]+(?::[\w.-]+)?$/;
const DOT_ONLY = /^\.+$/;
const MAX_FIELD = 2000;
const MAX_LIST = 8;

// Strip HTML/markup and control characters, collapse whitespace, and cap length. Model-card
// text is untrusted third-party content; it is stored and later rendered as plain text, so it
// must never carry tags or unbounded size into the evidence log or the UI.
function sanitizeText(value, maxLen = MAX_FIELD) {
  if (value == null) return null;
  const text = String(value)
    .replace(/<[^>]*>/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

// The download checkpoint is `org/repo` or `org/repo:quant`; the model card lives at the
// repo, not the quantization tag. A dot-only segment ("..", ".") is syntactically allowed by
// the character class but is a path-traversal segment once interpolated into the card URL
// (`acme/..` → `/api/models/acme/..` → the models listing; `../datasets` → `/api/datasets`),
// so both segments are rejected outright rather than just escaped.
function repoFromCheckpoint(checkpoint) {
  if (!CHECKPOINT_RE.test(String(checkpoint || ''))) return null;
  const repo = String(checkpoint).split(':')[0];
  if (repo.split('/').some((segment) => DOT_ONLY.test(segment))) return null;
  return repo;
}

function cardUrl(repo) {
  return `https://huggingface.co/api/models/${repo.split('/').map(encodeURIComponent).join('/')}`;
}

// Confirms both the host and that the path still lands under the model-info endpoint this
// module is meant to call — a second, independent check on top of repoFromCheckpoint's
// segment validation, in case a future caller ever builds the URL another way.
function hostAllowed(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname.toLowerCase()) && u.pathname.startsWith('/api/models/');
  } catch {
    return false;
  }
}

// Public model-card fields worth recording, matched against the standard HF card schema
// (huggingface.co/docs/hub/model-cards). Every string is sanitised and capped; the eval
// section is capped to a handful of entries to keep one card bounded.
function normalizeCard(repo, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const cardData = body.cardData && typeof body.cardData === 'object' ? body.cardData : {};
  const revision = /^[a-f0-9]{6,64}$/i.test(String(body.sha || '')) ? body.sha : null;
  const license = sanitizeText(cardData.license || body.license, 100);
  const tags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string').slice(0, MAX_LIST).map((t) => sanitizeText(t, 60)) : [];
  const modelIndex = Array.isArray(cardData['model-index']) ? cardData['model-index'] : [];
  const evaluationClaims = [];
  for (const entry of modelIndex.slice(0, 3)) {
    for (const result of (Array.isArray(entry?.results) ? entry.results : []).slice(0, MAX_LIST)) {
      if (evaluationClaims.length >= MAX_LIST) break;
      const metrics = Array.isArray(result?.metrics) ? result.metrics : [];
      for (const metric of metrics.slice(0, 3)) {
        evaluationClaims.push({
          task: sanitizeText(result?.task?.type || result?.task?.name, 120),
          dataset: sanitizeText(result?.dataset?.name, 120),
          metric: sanitizeText(metric?.type || metric?.name, 60),
          value: typeof metric?.value === 'number' || typeof metric?.value === 'string' ? sanitizeText(metric.value, 40) : null,
        });
      }
    }
  }
  return {
    repo,
    revision,
    license,
    pipelineTag: sanitizeText(body.pipeline_tag, 80),
    libraryName: sanitizeText(body.library_name, 80),
    tags,
    evaluationClaims,
    cardExcerpt: sanitizeText(cardData.model_summary || cardData.summary || body.description, 1200),
  };
}

// identityHash scoped to the artifact only (spec-agent-execution keys evidence to full
// runtime identity for benchmark evidence; a public model card describes the weights, not
// the serving configuration, so it must stay attributed to the same record across a preset
// or context-window change and only change when the artifact itself does).
function artifactIdentityHash(artifact) {
  return evidenceLib.identityHash({ artifact });
}

// Fetches and normalizes one model's external evidence. Never throws itself: every failure
// mode (bad checkpoint, disallowed host, offline, oversized/invalid response) resolves to
// { ok:false, reason }, so a caller wiring this into "download finished" cannot let a
// metadata failure block or fail the download. (importModelEvidence below, which also
// writes the record, can still throw — see its own comment.)
async function fetchModelCardEvidence({ checkpoint, artifact, fetchJson, now = () => Date.now() }) {
  const repo = repoFromCheckpoint(checkpoint);
  if (!repo) return { ok: false, reason: 'invalid checkpoint' };
  if (!artifact) return { ok: false, reason: 'artifact not available' };
  const url = cardUrl(repo);
  if (!hostAllowed(url)) return { ok: false, reason: 'source host not allowed' };
  let response;
  try {
    response = await fetchJson(url, { redirect: 'error' }, 15000, 1024 * 1024);
  } catch {
    return { ok: false, reason: 'fetch failed' };
  }
  if (!response || !response.ok) return { ok: false, reason: `source responded ${response?.status ?? 'error'}` };
  if (response.body?.private) return { ok: false, reason: 'source repository is private' };
  const value = normalizeCard(repo, response.body);
  if (!value) return { ok: false, reason: 'unrecognized source response' };
  return {
    ok: true,
    record: {
      category: 'external_model_card',
      result: 'reported',
      identityHash: artifactIdentityHash(artifact),
      value,
      suite: { name: 'huggingface-model-card', version: 1 },
      source: 'external',
      provenance: { sourceUrl: url, retrievedAt: now() },
      // Surfaced verbatim next to the record: this is a source's own claim, never a local
      // measurement, and must never be presented as verified.
      limitations: ['unverified, from source: published by the model repository, not measured locally'],
    },
  };
}

// A caller (the explicit "fetch evidence" route) may pass an admin-supplied checkpoint
// override. That override must describe the same repository the model itself already names,
// or an admin could attribute an unrelated repo's license/eval claims to this model. When no
// override is given, the model name is used as the checkpoint (true for a pulled llama.cpp
// model, whose id is the HF repo it was pulled from).
function resolveCheckpoint(model, checkpoint) {
  if (checkpoint == null) return model;
  const modelRepo = repoFromCheckpoint(model);
  if (!modelRepo || repoFromCheckpoint(checkpoint) !== modelRepo) return null;
  return checkpoint;
}

// Records the evidence via the shared append-only store (evidence.cjs), deduped by the
// artifact-scoped identity. Deliberately compares only the fields that describe the card's
// content, not `revision`: a repository that re-pushes the same card under a new commit (or
// a moving `main` ref) must not append a new record every time it is refetched — only an
// actual change to the recorded fields does. `revision` is still stored on every record for
// provenance, just excluded from the "did anything change" comparison.
//
// Uses store.append (not store.appendIfChanged, whose generic whole-value comparison would
// re-include revision) directly, so this can throw the same way any other evidence write can
// — store.append rejects credential-shaped text. Every caller here (the download-completed
// hook and the explicit import route) already catches and swallows that.
function cardContentKey(value) {
  if (!value) return null;
  const { revision, ...rest } = value;
  return JSON.stringify(rest);
}
async function importModelEvidence({ model, checkpoint, artifact, fetchJson, store, now }) {
  const resolvedCheckpoint = resolveCheckpoint(model, checkpoint);
  if (checkpoint != null && resolvedCheckpoint == null) return { ok: false, reason: 'checkpoint does not match this model' };
  const fetched = await fetchModelCardEvidence({ checkpoint: resolvedCheckpoint, artifact, fetchJson, now });
  if (!fetched.ok || !store) return fetched;
  const entry = { model, ...fetched.record };
  const newest = store.list().filter((r) => r.model === model && r.category === entry.category && r.identityHash === entry.identityHash).at(-1);
  if (newest && cardContentKey(newest.value) === cardContentKey(entry.value)) return { ok: true, record: newest };
  return { ok: true, record: store.append(entry) };
}

// State for one model's external evidence against its current artifact. Unlike
// evidence.cjs's derive() (scoped to the full runtime identity: build, preset, context),
// external evidence is scoped to the artifact alone, so a preset or context-window change
// must not turn a reported card 'stale'.
function deriveExternal(records, { model, artifactHash }) {
  const mine = (records || []).filter((r) => r.model === model && r.category === 'external_model_card');
  if (!artifactHash) return { state: 'unavailable', record: mine.at(-1) || null };
  const matching = mine.filter((r) => r.identityHash === artifactHash);
  const newest = matching.at(-1);
  if (newest) return { state: 'reported', record: newest };
  const older = mine.at(-1);
  if (older) return { state: 'stale', record: older };
  return { state: 'unverified', record: null };
}

module.exports = {
  sanitizeText,
  repoFromCheckpoint,
  cardUrl,
  hostAllowed,
  normalizeCard,
  artifactIdentityHash,
  fetchModelCardEvidence,
  resolveCheckpoint,
  importModelEvidence,
  deriveExternal,
  ALLOWED_HOSTS,
};
