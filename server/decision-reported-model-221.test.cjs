"use strict";
// #221: the id the decision service reports for itself lives in one place (decision-models.cjs). The two
// callers that accept it (decision-endpoint.cjs, system-one-router.cjs) read it from there. The literal is
// pinned here, once, so a change to the accepted id is a visible test change, not a silent one.
const test = require("node:test");
const assert = require("node:assert/strict");
const { DECISION_SERVICE_REPORTED_MODEL, PROFILES } = require("./decision-models.cjs");
const { createDecisionEndpoint } = require("./decision-endpoint.cjs");
const { createSystemOneRouter } = require("./system-one-router.cjs");

const env = { COWORK_DECISION_URL: "http://laya:8040" };
const options = [{ id: "a", label: "A" }, { id: "b", label: "B" }];

test("the accepted id is the one deployed before #221, and the Laya profile carries it", () => {
  assert.equal(DECISION_SERVICE_REPORTED_MODEL, "convaiinnovations/laya");
  assert.equal(PROFILES.laya.reportedModel, DECISION_SERVICE_REPORTED_MODEL);
  assert.equal(PROFILES["kev-0.8b"].reportedModel, undefined, "only the Laya wire reports a model id");
});

async function endpointModel(reported) {
  const endpoint = createDecisionEndpoint({ env, fetchImpl: async () => Response.json({
    selected: "b", scores: { a: 0.4, b: 0.6 }, ...(reported === undefined ? {} : { model: reported }) }) });
  return (await endpoint.choice({ state: "synthetic", question: "Pick", options })).metadata.model;
}

test("endpoint: the default id is exposed as reported, every other value is nulled", async () => {
  assert.equal(await endpointModel(DECISION_SERVICE_REPORTED_MODEL), DECISION_SERVICE_REPORTED_MODEL);
  for (const other of ["synthetic/other-model", "https://private.example/key", DECISION_SERVICE_REPORTED_MODEL.toUpperCase(),
    ` ${DECISION_SERVICE_REPORTED_MODEL}`, `${DECISION_SERVICE_REPORTED_MODEL}-2`, "", 7, null, {}, [DECISION_SERVICE_REPORTED_MODEL], undefined]) {
    assert.equal(await endpointModel(other), null, JSON.stringify(other));
  }
});

async function routedModel(reported) {
  const router = createSystemOneRouter({ enabled: () => true, roles: () => ({ fast: "f", smart: "s" }),
    fallback: async () => "smart", log: () => {}, backend: { id: "decision-service", supports: () => true, locality: "local",
      decide: async () => ({ selected: "smart", scores: { fast: 0.2, smart: 0.8 },
        metadata: reported === undefined ? { calibrated: false } : { model: reported, calibrated: false } }) } });
  const { routingDecision } = await router.classifyWithDetails("explain synthetic things in detail please");
  assert.equal(routingDecision.status, "accepted");
  assert.equal(routingDecision.selectedRole, "smart");
  return routingDecision.model;
}

test("router: the default id is shown on an accepted decision, every other value is nulled and routing is unchanged", async () => {
  assert.equal(await routedModel(DECISION_SERVICE_REPORTED_MODEL), DECISION_SERVICE_REPORTED_MODEL);
  for (const other of ["synthetic/other-model", DECISION_SERVICE_REPORTED_MODEL.toUpperCase(), ` ${DECISION_SERVICE_REPORTED_MODEL}`,
    "", 7, null, {}, undefined]) {
    assert.equal(await routedModel(other), null, JSON.stringify(other));
  }
});
