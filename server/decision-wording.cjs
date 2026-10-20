'use strict';
// #2093: the decision wordings are named for their role, not for the service they were measured with.
//   standard: the wording every release before #1639 sent, kept byte-identical for the default service profile
//             and for any unknown model.
//   compact:  the wording for a compact (small) decision model, tuned and measured in #1639 (tools/decision-eval).
// 'laya' and 'kev' were the first names of these two values. They are still accepted wherever a wording is
// read from outside this code (the tool gate's `wording`, the router backend's `wording`, the eval harness's
// --wording flag, createDecisionEndpoint's `wording`) and mean standard and compact. Nothing here emits them.
const STANDARD = 'standard';
const COMPACT = 'compact';
const DEPRECATED_ALIASES = Object.freeze({ laya: STANDARD, kev: COMPACT });

/** The role name for a wording value: 'standard' or 'compact' as given, 'laya' or 'kev' mapped to them, and
 *  null for anything else (other strings, another case, non-strings), so a caller applies its own default. */
function normalizeWording(value) {
  if (value === STANDARD || value === COMPACT) return value;
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DEPRECATED_ALIASES, value) ? DEPRECATED_ALIASES[value] : null;
}

module.exports = { STANDARD, COMPACT, DEPRECATED_ALIASES, normalizeWording };
