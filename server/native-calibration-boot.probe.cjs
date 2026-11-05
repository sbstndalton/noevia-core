'use strict';
// Test-only preload for native-calibration-boot-2303.test.cjs (`node --require <this> index.cjs`); production never
// loads it. It records, as JSON lines in CALIBRATION_BOOT_PROBE_OUT, what the real boot does with the calibration
// job: every createCalibrator construction (public: it has a state file; auto-tune's private one has none), the
// options index.cjs hands createModelManager, and every read of the manager's `calibration` (a boot recover()
// reads it, however it is spelled). CALIBRATION_BOOT_PROBE_MUTATE ([{file, from, to}]) rewrites a module's source
// as it is compiled: the fixtures that reintroduce a boot recover() or an ungated public calibrator.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const out = process.env.CALIBRATION_BOOT_PROBE_OUT;
const log = (record) => fs.appendFileSync(out, `${JSON.stringify(record)}\n`);
const mutations = JSON.parse(process.env.CALIBRATION_BOOT_PROBE_MUTATE || '[]');

if (mutations.length) {
  const compile = Module.prototype._compile;
  Module.prototype._compile = function compileMutated(content, filename) {
    let text = content;
    for (const m of mutations) {
      if (filename !== path.join(__dirname, m.file)) continue;
      if (!text.includes(m.from)) { log({ mutationMissed: m.file }); continue; }
      text = text.replace(m.from, m.to);
      log({ mutated: m.file });
    }
    return compile.call(this, text, filename);
  };
}

// The front's project store (the feature runtime's hello/register lease) is not part of this check and is not
// running in the test: its lease alone is answered here (ready, and reads from the same database). Everything
// else boots as in production.
// (Its exports are frozen, so the require itself answers a copy with ready() replaced.)
const RUNTIME = path.join(__dirname, 'feature-runtime.cjs');
let runtimeModule = null;
const load = Module._load;
Module._load = function loadWithReadyRuntime(request, parent, isMain) {
  const loaded = load.call(this, request, parent, isMain);
  let file;
  try { file = Module._resolveFilename(request, parent, isMain); } catch { return loaded; }
  if (file !== RUNTIME) return loaded;
  runtimeModule ||= { ...loaded, createFeatureRuntime: (options) => ({
    ...loaded.createFeatureRuntime(options),
    // As with a live lease: ready, and reads straight from this process's database.
    ready: () => Promise.resolve(true),
    read: (fn) => fn(options.db),
  }) };
  return runtimeModule;
};

// The load decision the front's calibration asks before each load (#2303 generation 2): what index.cjs hands
// the bridge, and what it answers for the boot test's invalid-size model.
const loadRoutes = require('./model-load-refusal.cjs');
const createLoadRefusalRoute = loadRoutes.createLoadRefusalRoute;
loadRoutes.createLoadRefusalRoute = (options = {}) => {
  const decide = options.loadRefusal;
  log({ loadRefusalRoute: typeof decide });
  if (typeof decide === 'function') {
    Promise.resolve().then(() => decide('synth-invalid'))
      .then((r) => log({ loadRefusalAnswer: r?.code ?? null }), () => log({ loadRefusalAnswer: 'threw' }));
  }
  return createLoadRefusalRoute(options);
};

const calibration = require('./llamacpp-calibration.cjs');
const createCalibrator = calibration.createCalibrator;
calibration.createCalibrator = (deps = {}) => {
  log({ createCalibrator: deps.stateFile ? 'public' : 'private' });
  return createCalibrator(deps);
};

const managers = require('./model-manager.cjs');
const createModelManager = managers.createModelManager;
managers.createModelManager = (options = {}) => {
  log({ manager: options.kind ?? null, publicCalibrator: options.publicCalibrator ?? null });
  const manager = createModelManager(options);
  if (!manager || typeof manager !== 'object') return manager;
  return new Proxy(manager, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'calibration') return value;
      log({ calibrationRead: value ? 'object' : String(value), at: String(new Error().stack).split('\n').slice(2, 4).join(' | ') });
      if (value && typeof value.recover === 'function') {
        return { ...value, recover: (...args) => { log({ recover: true }); return value.recover(...args); } };
      }
      return value;
    },
  });
};
