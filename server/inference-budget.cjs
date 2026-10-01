'use strict';
// #697: one inference memory budget for the native engine. Every model the router loads is
// estimated first (llamacpp-autoconfig.cjs estimateFootprint) and refused when the estimate is
// above this budget; autoconfig never suggests past it; a watchdog unloads the model when the
// measured usage runs well over it (inference-budget-watch.cjs).
//
// The budget is an administrator setting stored like the other admin settings. The deployment
// variable INFERENCE_MEMORY_BUDGET_GIB only supplies its initial value, and DEFAULT_BUDGET_GIB
// applies only when that variable is unset too: the figure is meant to change with the host.
const fs = require('node:fs');

const KEY = 'inference:memory-budget';
const DEFAULT_BUDGET_GIB = 16;
const MIN_BUDGET_GIB = 2;
// Left to the OS and the other services when the host's RAM bounds the setting.
const HOST_HEADROOM_GIB = 4;
// Upper bound used only when /proc/meminfo cannot be read.
const FALLBACK_MAX_GIB = 1024;
// Prompt-cache (--cache-ram, MiB) limits for every preset write path.
const CACHE_RAM_CAP_DEFAULT_MIB = 1024;
const CACHE_RAM_HARD_MAX_DEFAULT_MIB = 2048;

const positive = (value, fallback) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; };
const round1 = n => Math.round(n * 10) / 10;

/** Host RAM in GiB from /proc/meminfo, or null where it is not readable (not Linux, sandbox). */
function hostRamGib(readMeminfo = () => fs.readFileSync('/proc/meminfo', 'utf8')) {
  try {
    const kib = Number(/^MemTotal:\s+(\d+)\s*kB/m.exec(String(readMeminfo()))?.[1]);
    return kib > 0 ? round1(kib / 1048576) : null;
  } catch { return null; }
}

/** The prompt-cache cap written by autoconfig and new presets, and the hard maximum any write keeps. */
function cacheRamLimits(env = process.env) {
  const hardMaxMib = Math.round(positive(env.LLAMACPP_CACHE_RAM_HARD_MAX_MIB, CACHE_RAM_HARD_MAX_DEFAULT_MIB));
  const capMib = Math.min(hardMaxMib, Math.round(positive(env.LLAMACPP_AUTOCONFIG_CACHE_RAM_MAX_MIB, CACHE_RAM_CAP_DEFAULT_MIB)));
  return { capMib, hardMaxMib };
}

/**
 * A cache-ram value as it may be written: integers above the hard maximum (and -1, which means
 * unbounded to llama-server) become the hard maximum. Anything else is returned unchanged so the
 * preset validator can still reject it.
 */
function clampCacheRam(value, { hardMaxMib } = cacheRamLimits()) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+$/.test(text)) return text;
  const n = Number(text);
  return n < 0 || n > hardMaxMib ? String(hardMaxMib) : String(n);
}

function createInferenceBudget({ store, env = process.env, readMeminfo, audit = () => {} } = {}) {
  let saved = null;
  try { const v = Number(JSON.parse(store?.get(KEY) || 'null')?.budgetGib); saved = v > 0 ? v : null; } catch { saved = null; }
  function range() {
    const host = hostRamGib(readMeminfo);
    const maxGib = host ? Math.max(MIN_BUDGET_GIB, Math.floor(host - HOST_HEADROOM_GIB)) : FALLBACK_MAX_GIB;
    return { minGib: MIN_BUDGET_GIB, maxGib, hostRamGib: host };
  }
  const defaultGib = () => positive(env.INFERENCE_MEMORY_BUDGET_GIB, DEFAULT_BUDGET_GIB);
  function get() {
    const r = range();
    const raw = saved ?? defaultGib();
    // A host with less RAM than when the figure was saved still gets a budget it can hold.
    const budgetGib = Math.min(r.maxGib, Math.max(r.minGib, raw));
    return { budgetGib, source: saved != null ? 'admin' : 'deployment', defaultGib: defaultGib(), ...r, limited: budgetGib !== raw };
  }
  function save(value, actor) {
    const r = range();
    const n = typeof value?.budgetGib === 'number' ? value.budgetGib : Number.NaN;
    if (!Number.isFinite(n) || round1(n) !== n || n < r.minGib || n > r.maxGib) {
      throw Object.assign(Error(`Enter a budget from ${r.minGib} to ${r.maxGib} GiB, in steps of 0.1.`), { status: 400, messageId: 'invalidBudget', minGib: r.minGib, maxGib: r.maxGib });
    }
    store.set(KEY, JSON.stringify({ budgetGib: n }));
    saved = n;
    audit('inference.budget', actor, { budgetGib: n });
    return get();
  }
  return { get, save, budgetGib: () => get().budgetGib, range };
}

module.exports = { createInferenceBudget, hostRamGib, cacheRamLimits, clampCacheRam, DEFAULT_BUDGET_GIB, MIN_BUDGET_GIB, HOST_HEADROOM_GIB };
