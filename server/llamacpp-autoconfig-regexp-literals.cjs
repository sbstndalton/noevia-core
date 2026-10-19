'use strict';
// Generated mechanical literal materializers; Rust selects every use and applies every operation.
// Frozen source SHA-256 66b436f5e2fda9719470fbc18bd92d7b1b52eb6e881885167cdbbebd02eaa040
// Rust program SHA-256 d7fd2370bb3ea66902518b126d2948b4c02bfd4cb855def2a226a849b263cd52
// Three unique literals at four Rust-selected sites. No business functions or decisions.
const catalog = {
  __proto__: null,
  ["bert"]: { __proto__: null,
    ["i"]: () => /bert/i,
  },
  ["embed|rerank"]: { __proto__: null,
    ["i"]: () => /embed|rerank/i,
  },
  ["^\\s*(\\d+(?:\\.\\d+)?)\\s*([kmgt]?)i?b?\\s*$"]: { __proto__: null,
    ["i"]: () => /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i,
  },
};
function create(pattern, flags) {
  if (typeof pattern !== 'string' || typeof flags !== 'string') return undefined;
  const variants = catalog[pattern];
  const factory = variants === undefined ? undefined : variants[flags];
  return factory === undefined ? undefined : factory();
}
module.exports = { create };
