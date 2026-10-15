'use strict';
// #1841: where the private document workers are. OCR (services/ocr: scanned pages, DOCX text, PDF
// reduction) and Docling (services/docling: whole-document extraction) are two sidecars whose address
// used to be the deployment's environment only (OCR_BASE_URL, DOCLING_BASE_URL). Settings → Inference
// machines can now put either on a machine on this network (inference-machines.cjs urlFor('ocr') /
// urlFor('documents')).
//
// Precedence, as everywhere on that page: the machine, then the environment. Nothing assigned: the
// environment value and the plain global fetch, exactly as before this module existed.
//
// An address that comes from a machine is connected to through the on-this-network fetch
// (service-endpoint.cjs serviceFetch): a name is resolved at connect time and refused unless every answer
// is on this network, link-local included, and a redirect is never followed. Neither worker is sent a
// token: the requests carry only the document and its content type, so no local credential can reach
// another host (document-workers-1841.test.cjs pins the headers).
const { serviceFetch } = require('./service-endpoint.cjs');

// The machine state below is module-level, set once by index.cjs: a worker thread or child process loads its own
// copy of this module with no machines, so it would silently read the environment only. Pass the resolved url in.
const ENV = Object.freeze({ ocr: 'OCR_BASE_URL', documents: 'DOCLING_BASE_URL' });
let machineUrl = () => null;

/** index.cjs hands over inferenceMachines.urlFor; tests set their own and restore with no argument. */
function useMachines(urlFor) { machineUrl = typeof urlFor === 'function' ? urlFor : () => null; }

/**
 * @param {'ocr'|'documents'} kind
 * @returns {{ url: string|undefined, fetch: Function, machine: boolean }}
 */
function resolve(kind) {
  let assigned = null;
  try { assigned = machineUrl(kind); } catch { assigned = null; }
  if (typeof assigned === 'string' && assigned) return { url: assigned, fetch: serviceFetch, machine: true };
  return { url: process.env[ENV[kind]], fetch: globalThis.fetch, machine: false };
}

/** The machine address the worker is assigned to, or null (nothing assigned: the environment applies). */
function assigned(kind) {
  try { const u = machineUrl(kind); return typeof u === 'string' && u ? u : null; } catch { return null; }
}

/** Whether the worker is configured at all (a machine or the environment). */
const configured = (kind) => !!resolve(kind).url;

module.exports = { resolve, configured, assigned, useMachines };
