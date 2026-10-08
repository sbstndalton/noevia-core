'use strict';
// Low- and high-context profiles per model (#1079). A Long auto-tune writes a second models.ini
// section, `<model>-long`, that loads the same weights with its own context, KV cache and batch
// values; Fast keeps writing the model's own section. The llama.cpp router serves each section as
// its own model id and keeps one chat model resident (models_max 1), so a switch reloads.
//
// The decisions are Rust's (crates/long-profile in dav-parse.wasm, always on): which rows pair,
// the section a Long tune starts from, and which entry serves a chat with Context High. This file
// only gathers their inputs from the router's rows and models.ini, and fails closed: when the
// module cannot answer there are no pairs (no High choice, chat serves the model it named) and no
// new section is made.

const { modelPathFromArgs } = require('./model-system.cjs');

const SUFFIX = '-long';
const PROFILES = new Set(['low', 'high']);

function defaultDecide() {
  const wasm = require('./dav-parse-wasm.cjs');
  return { pairs: (rows) => wasm.longProfilePairs(rows), section: (req) => wasm.longProfileSection(req), pick: (req) => wasm.longProfilePick(req) };
}

/** The flag that follows `names` in a router process's argv, if any. */
function argOf(args, names) {
  if (!Array.isArray(args)) return '';
  const i = args.findIndex((a) => names.includes(a));
  return i >= 0 && typeof args[i + 1] === 'string' ? args[i + 1] : '';
}

/** The model file a router row loads: its --model argument, else its own models.ini line. */
function fileOf(row, presets) {
  const fromArgs = modelPathFromArgs(row?.status?.args);
  if (fromArgs) return fromArgs;
  try { return presets?.files(row.id)?.model || null; } catch { return null; }
}

function createLongProfiles({ decide = defaultDecide(), log: write = (m) => console.warn(m) } = {}) {
  // Listings poll often: each distinct failure is logged once.
  const logged = new Set();
  const log = (m) => { if (logged.has(m)) return; if (logged.size > 32) logged.clear(); logged.add(m); write(m); };
  /** [{ base, long }] for the router's raw rows, or [] when the decision is unavailable. */
  function pairsOf(rows, presets) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => typeof r?.id === 'string' && r.id);
    const seen = new Set(), input = [];
    // Inside the module's limits (512 rows, ids of 512 bytes, paths of 4096), so one odd row cannot
    // make the whole request refused: such a row simply never pairs.
    for (const row of list) {
      if (seen.has(row.id) || Buffer.byteLength(row.id) > 512 || input.length >= 512) continue;
      seen.add(row.id);
      const model = fileOf(row, presets);
      input.push({ id: row.id, model: typeof model === 'string' && Buffer.byteLength(model) <= 4096 ? model : null });
    }
    try { return decide.pairs(input); } catch (e) { log(`[long-profile] pairing unavailable: ${e?.reason || e?.message || e}`); return []; }
  }
  /** models.ini text with `[<base>-long]` appended for `row` (the base model's router row):
   *  { ok: true, id, text } or { ok: false, reason } ('unavailable' when the module cannot answer). */
  function sectionFor(text, row, presets) {
    const model = fileOf(row, presets);
    const mmproj = argOf(row?.status?.args, ['--mmproj', '-mm']) || (() => { try { return presets?.files(row.id)?.mmproj || null; } catch { return null; } })();
    try { return decide.section({ text, base: row.id, model: model || null, mmproj: mmproj || null }); }
    catch (e) { log(`[long-profile] section unavailable: ${e?.reason || e?.message || e}`); return { ok: false, reason: 'unavailable' }; }
  }
  /** The entry that serves `model` for `profile`, or `model` itself with reason 'unavailable'. */
  function pick(model, profile, pairs) {
    if (!PROFILES.has(profile)) profile = 'low';
    try { return decide.pick({ model, profile, pairs: Array.isArray(pairs) ? pairs : [] }); }
    catch (e) { log(`[long-profile] pick unavailable: ${e?.reason || e?.message || e}`); return { model, long: false, reason: 'unavailable' }; }
  }
  return { pairsOf, sectionFor, pick };
}

/** A chat's stored context profile: 'high', or null (Low, the default). */
const normalizeProfile = (value) => (value === 'high' ? 'high' : null);

module.exports = { createLongProfiles, fileOf, normalizeProfile, SUFFIX, PROFILES };
