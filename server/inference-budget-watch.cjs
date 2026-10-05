'use strict';
// #697 runtime safety net. The load guard works from an estimate; this measures. On a shared-
// memory GPU (the AMD iGPU on DaServer) model weights and KV live in GTT, which is system RAM the
// engine container's memory limit does not count, so the kernel can stall the whole host before
// any OOM kill. Every interval this reads GPU memory in use (GTT plus the small VRAM carve-out,
// from sysfs) and the main engine container's anonymous memory (through the model manager), and
// when the sum stays above the inference budget by more than the allowed overshoot, it unloads
// the loaded models through the router. Its log line carries numbers and model ids only.
//
// What is measured, and its slack:
//  - GPU memory is device-wide. An idle baseline (sampled whenever no model is loaded, and at
//    startup when nothing is) is subtracted, so the display and other GPU users are not charged
//    to inference (on DaServer ~0.15 GiB: 14 MiB GTT + 144 MiB VRAM). Anything else that grows
//    on the GPU while a model is loaded (a transcode, say) still counts against the budget.
//  - Only the main engine container counts (INFERENCE_ENGINE_CONTAINER, default the compose
//    `llama` service's container). The CPU embed and rerank sidecars share its image but sit
//    outside the budget, like Laya.
//  - Container memory is anonymous memory (cgroup memory.stat anon, or rss on cgroup v1), not
//    usage, which also holds the page cache of the mmapped model file.
const fs = require('node:fs');
const path = require('node:path');

const GIB = 1024 ** 3;
const round2 = n => Math.round(n * 100) / 100;
const off = v => /^(0|false|off|no)$/i.test(String(v ?? '').trim());
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

/**
 * GPU memory files to sum. INFERENCE_GTT_USED_PATH (comma-separated) names the GTT counters of the
 * GPU the engine uses; unset, every DRM card under /sys/class/drm that has one is used. The VRAM
 * counter beside each GTT file (mem_info_vram_used) is added when present.
 */
function gpuMemoryFiles(env = process.env, { drmRoot = '/sys/class/drm', readdir = fs.readdirSync, exists = fs.existsSync } = {}) {
  const explicit = String(env.INFERENCE_GTT_USED_PATH || '').split(',').map(s => s.trim()).filter(Boolean);
  let gtt = explicit;
  if (!gtt.length) {
    try { gtt = readdir(drmRoot).filter(n => /^card\d+$/.test(n)).sort().map(n => path.join(drmRoot, n, 'device', 'mem_info_gtt_used')).filter(f => exists(f)); }
    catch { gtt = []; }
  }
  const vram = gtt.map(f => path.join(path.dirname(f), 'mem_info_vram_used')).filter(f => exists(f));
  return { gtt, vram };
}

/** Bytes used per counter, or null when none of the GTT counters can be read. */
function readGpuMemory(files, readFile = f => fs.readFileSync(f, 'utf8')) {
  const read = list => list.map(f => { try { const n = Number(String(readFile(f)).trim()); return Number.isFinite(n) && n >= 0 ? n : null; } catch { return null; } }).filter(n => n != null);
  const gtt = read(files.gtt);
  if (!gtt.length) return null;
  return { gttGib: gtt.reduce((a, b) => a + b, 0) / GIB, vramGib: read(files.vram).reduce((a, b) => a + b, 0) / GIB };
}

function createInferenceBudgetWatch({
  budgetGib, readGpu, readEngine = async () => null, listLoaded, unload, onUnloaded = () => {}, log = line => console.warn(line),
  // False while something outside the engine may hold GPU memory (a calibration, auto-tune or a
  // llama-bench sweep holds the maintenance gate): no idle baseline is taken then.
  baselineAllowed = () => true,
  env = process.env, intervalMs, overshootPct, strikesNeeded = 2, cooldownMs = 60000, now = Date.now,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  const enabled = !off(env.INFERENCE_BUDGET_WATCH);
  const every = Math.max(2000, num(intervalMs ?? env.INFERENCE_BUDGET_WATCH_INTERVAL_MS, 15000));
  const overshoot = Math.min(100, num(overshootPct ?? env.INFERENCE_BUDGET_OVERSHOOT_PCT, 10)) / 100;
  let strikes = 0, cooldownUntil = 0, timer = null, running = false, last = null, baselineGib = null;

  async function tick() {
    if (running) return last;
    running = true;
    try {
      const budget = Number(budgetGib());
      if (!(budget > 0)) return (last = { state: 'no-budget' });
      const [gpu, engine, loaded] = await Promise.all([Promise.resolve().then(readGpu).catch(() => null), Promise.resolve().then(readEngine).catch(() => null), Promise.resolve().then(listLoaded).catch(() => null)]);
      // Neither source readable: nothing measured, nothing to act on.
      if (!gpu && !engine) { strikes = 0; return (last = { state: 'unavailable' }); }
      // #874: an unknown model list (engine error, unreachable) is not "idle": taking this reading
      // as the idle baseline would subtract the loaded model's memory and blind the watchdog.
      // Skip the tick; strikes carry over to the next readable one.
      if (!Array.isArray(loaded)) return (last = { state: 'models-unknown', strikes });
      const gttGib = gpu?.gttGib ?? engine?.gttGib ?? 0;
      const vramGib = gpu?.vramGib ?? engine?.vramGib ?? 0;
      // The idle baseline: every reading with no model loaded, and the first reading otherwise
      // only if nothing is loaded then. Unknown (a model was already loaded) counts as zero.
      let mayBaseline = true; try { mayBaseline = baselineAllowed() !== false; } catch { mayBaseline = false; }
      if (Array.isArray(loaded) && loaded.length === 0 && mayBaseline) baselineGib = gttGib + vramGib;
      const gpuGib = Math.max(0, gttGib + vramGib - (baselineGib ?? 0));
      const containerGib = engine?.containerGib ?? 0;
      const usedGib = gpuGib + containerGib;
      const limitGib = budget * (1 + overshoot);
      const sample = { usedGib: round2(usedGib), gttGib: round2(gttGib), vramGib: round2(vramGib), baselineGib: round2(baselineGib ?? 0), containerGib: round2(containerGib), budgetGib: budget, limitGib: round2(limitGib) };
      if (usedGib <= limitGib || (Array.isArray(loaded) && loaded.length === 0)) { strikes = 0; return (last = { state: 'ok', ...sample }); }
      strikes += 1;
      if (strikes < strikesNeeded || now() < cooldownUntil) return (last = { state: 'over', strikes, ...sample });
      const models = loaded;
      const unloaded = [];
      for (const model of models) {
        const r = await Promise.resolve().then(() => unload(model)).catch(() => null);
        if (r?.ok !== false) unloaded.push(model);
      }
      strikes = 0;
      cooldownUntil = now() + cooldownMs;
      // Remembered with its preset revision and the budget, so the same overload is refused on the
      // next load until one of them changes (llamacpp-manager.cjs quarantine).
      for (const model of unloaded) { try { onUnloaded(model, budget); } catch { /* best-effort */ } }
      log('[inference-budget] ' + JSON.stringify({ event: models.length ? 'unload' : 'over-budget-nothing-loaded', ...sample, models: unloaded, failed: models.filter(m => !unloaded.includes(m)) }));
      return (last = { state: 'unloaded', models: unloaded, ...sample });
    } finally { running = false; }
  }
  return {
    enabled, intervalMs: every, overshoot,
    tick,
    status: () => last,
    start() { if (!enabled || timer) return false; timer = setIntervalFn(() => { tick().catch(() => {}); }, every); timer?.unref?.(); return true; },
    stop() { if (timer) clearIntervalFn(timer); timer = null; },
  };
}

/**
 * Engine container memory (and the manager's own GPU reading, used when sysfs is not visible
 * to web) from the model manager's backend telemetry: GET /api/v1/backends.
 */
/** Whether a model-manager backend (a container name) is the main inference engine. */
function isEngineContainer(name, env = process.env) {
  const n = String(name || '');
  const configured = String(env.INFERENCE_ENGINE_CONTAINER || '').split(',').map(s => s.trim()).filter(Boolean);
  if (configured.length) return configured.includes(n);
  // The compose `llama` service: `llama`, `<project>-llama-1`, `<project>_llama_1`. Not embed/rerank.
  return /(^|[-_])llama([-_]\d+)?$/.test(n);
}

/** #874: the loaded model ids from a manager listing, or null when the listing failed (unknown). */
function loadedFromListing(r) {
  if (!r?.ok || !Array.isArray(r.body?.data)) return null;
  return r.body.data.filter(m => ['loaded', 'loading'].includes(m?.status?.value)).map(m => m.id);
}

function engineReaderFromModelLoader({ env = process.env, fetchJson }) {
  return async () => {
    if (!env.MODEL_LOADER_URL) return null;
    const r = await fetchJson(`${env.MODEL_LOADER_URL.replace(/\/+$/, '')}/api/v1/backends`, { method: 'GET', headers: { 'Content-Type': 'application/json', ...(env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': env.MODEL_LOADER_TOKEN } : {}) } }, 4000).catch(() => null);
    const backends = r?.ok && Array.isArray(r.body?.backends) ? r.body.backends.filter(b => b?.stats?.ok && isEngineContainer(b.name, env)) : [];
    if (!backends.length) return null;
    const sum = pick => backends.reduce((a, b) => a + (Number(pick(b.stats)) || 0), 0);
    // Anonymous memory where the model manager reports it; older images only report usage less
    // the page cache, which is the closest available figure.
    return { containerGib: sum(s => s.container?.mem_anon_gb ?? s.container?.mem_used_gb), gttGib: sum(s => s.gpu?.shared_used_gb), vramGib: sum(s => s.gpu?.vram_used_gb) };
  };
}

module.exports = { createInferenceBudgetWatch, gpuMemoryFiles, readGpuMemory, engineReaderFromModelLoader, isEngineContainer, loadedFromListing };
