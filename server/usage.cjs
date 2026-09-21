'use strict';
// Usage accounting: what a day's replies and tool calls cost, per tenant.
//
// Lifted out of index.cjs unchanged (2026-09-21). It was never entangled with the request
// handler — it reads and writes one file per workspace — and the routes that report it live in
// routes/usage.cjs, the way every other area of the server is arranged.
const fs = require('node:fs');
const { atomicJson } = require('./workspace.cjs');

// ── Usage accounting ──────────────────────────────────────────────────────
// Daily rollup buckets rather than a per-reply log: the dashboard only ever
// asks day-level questions (totals, a heat map, active days, per-model split),
// and a bucket file is bounded — one small record per day, capped at a year —
// where an append-only log on a self-hosted box grows until someone notices.
// Per-message detail is not lost; it already lives in each chat's history.
const USAGE_RETENTION_DAYS = 365;

// Local civil date, not UTC: "today" on the dashboard should mean the
// operator's today, and an evening request must not land in tomorrow's bucket.
function usageDayKey(at = new Date()) {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function readUsage(workspace) {
  try {
    const parsed = JSON.parse(fs.readFileSync(workspace.usagePath(), 'utf8'));
    return parsed && typeof parsed.days === 'object' && parsed.days ? parsed : { days: {} };
  } catch {
    return { days: {} };
  }
}

// Called once per completed reply, from the point the provider reports its
// usage chunk. Recording here rather than from the browser means the numbers
// survive a client that navigated away mid-reply, and cannot be shaped by
// anything the client sends.
function recordUsage(workspace, model, usage) {
  if (!workspace || !usage) return;
  const input = Number(usage.promptTokens) || 0;
  const output = Number(usage.completionTokens) || 0;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input<0 || output<0 || (!input && !output)) return;
  try {
    const store = readUsage(workspace);
    const key = usageDayKey();
    const day = store.days[key] || { input: 0, output: 0, replies: 0, models: {} };
    day.input += input;
    day.output += output;
    day.replies += 1;
    const name = String(model || 'unknown');
    day.models=Object.assign(Object.create(null),day.models||{});
    const perModel = day.models[name] || { input: 0, output: 0, replies: 0 };
    perModel.input += input;
    perModel.output += output;
    perModel.replies += 1;
    day.models[name] = perModel;
    // Replies by hour of the same local clock the day keys use, so "peak hour"
    // means the hour the user saw, not UTC.
    day.hours = Object.assign(Object.create(null), day.hours || {});
    const hour = new Date().getHours();
    day.hours[hour] = (Number(day.hours[hour]) || 0) + 1;
    store.days[key] = day;
    // Drop anything past the window on write, so the file cannot creep upward
    // even on a deployment that runs for years.
    const cutoff = usageDayKey(new Date(Date.now() - USAGE_RETENTION_DAYS * 86400000));
    for (const k of Object.keys(store.days)) if (k < cutoff) delete store.days[k];
    atomicJson(workspace.usagePath(), store);
  } catch (err) {
    // Accounting must never break a reply that already succeeded.
    console.warn('[usage] could not record:', err?.message || err);
  }
}

// One line per tool the model actually ran, counted where the call is made so
// the total cannot be shaped by the client. Failures count too: a tool that
// keeps erroring is exactly what this number should show.
function recordToolUse(workspace, name) {
  if (!workspace || !name) return;
  try {
    const store = readUsage(workspace);
    const key = usageDayKey();
    const day = store.days[key] || { input: 0, output: 0, replies: 0, models: {} };
    day.tools = Object.assign(Object.create(null), day.tools || {});
    const tool = String(name).slice(0, 80);
    day.tools[tool] = (Number(day.tools[tool]) || 0) + 1;
    store.days[key] = day;
    atomicJson(workspace.usagePath(), store);
  } catch (err) {
    console.warn('[usage] could not record a tool call:', err?.message || err);
  }
}

module.exports = { USAGE_RETENTION_DAYS, usageDayKey, readUsage, recordUsage, recordToolUse };
