import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHeuristicQueryPlan,
  buildPlannerMessages,
  normalizeQueryPlan,
  uniqueQueries,
} from "./queryPlan.js";

const PLAN_FIELDS = [
  "alternativeQueries",
  "caseFacts",
  "filters",
  "intent",
  "mustReturnAll",
  "requestedConstraints",
  "requiresProductIdentity",
  "searchMode",
  "semanticQuery",
  "supportGoal",
  "topicChanged",
  "turnType",
];

test("normalizeQueryPlan returns the stable plan shape and normalizes supported values", () => {
  const plan = normalizeQueryPlan({
    intent: "not-an-intent",
    supportGoal: "not-a-goal",
    turnType: "not-a-turn",
    semanticQuery: "  Find a quiet fan  ",
    alternativeQueries: ["find a quiet fan", "  QUIET FAN  ", "quiet fan", "third query"],
    requestedConstraints: ["  quiet  ", null, "under budget"],
    filters: {
      productName: "  Model 123  ",
      material: "Aluminum",
      ingredient: "",
      minConcentrationPercentage: "20",
      maxPrice: "12.50",
    },
  }, "fallback question");

  assert.deepEqual(Object.keys(plan).sort(), PLAN_FIELDS);
  assert.equal(plan.intent, "product_search");
  assert.equal(plan.supportGoal, "selection");
  assert.equal(plan.turnType, "new_question");
  assert.equal(plan.searchMode, "hybrid");
  assert.equal(plan.semanticQuery, "Find a quiet fan");
  assert.deepEqual(plan.alternativeQueries, ["QUIET FAN", "third query"]);
  assert.deepEqual(plan.requestedConstraints, ["quiet", "under budget"]);
  assert.equal(plan.filters.productName, "model 123");
  assert.equal(plan.filters.material, "aluminium");
  assert.equal(plan.filters.minConcentrationPercentage, null);
  assert.equal(plan.filters.maxPrice, 12.5);
});

test("normalizeQueryPlan rejects non-object planner output", () => {
  assert.throws(() => normalizeQueryPlan(null, "question"), /Invalid retrieval plan/);
  assert.throws(() => normalizeQueryPlan([], "question"), /Invalid retrieval plan/);
});

test("uniqueQueries keeps first spelling while deduplicating normalized text", () => {
  assert.deepEqual(
    uniqueQueries(["  First query  ", "FIRST   QUERY", "", null, "Second query"]),
    ["First query", "Second query"],
  );
});

test("heuristic planning recognizes catalog, selection, and support fallbacks", () => {
  const catalog = buildHeuristicQueryPlan("Show all products");
  assert.equal(catalog.intent, "catalog");
  assert.equal(catalog.supportGoal, "catalog");
  assert.equal(catalog.mustReturnAll, true);
  assert.equal(catalog.topicChanged, true);
  assert.equal(catalog.plannerSource, "heuristic");

  const selection = buildHeuristicQueryPlan("Show all fans", {
    catalogCategories: ["fan"],
  });
  assert.equal(selection.intent, "product_search");
  assert.equal(selection.supportGoal, "selection");
  assert.equal(selection.filters.category, "fan");

  const troubleshooting = buildHeuristicQueryPlan("My unit is not working", {
    history: "Earlier context",
  });
  assert.equal(troubleshooting.intent, "knowledge");
  assert.equal(troubleshooting.supportGoal, "troubleshooting");
  assert.equal(troubleshooting.requiresProductIdentity, true);
  assert.equal(troubleshooting.turnType, "follow_up");
});

test("buildPlannerMessages separates trusted instructions from serialized input", () => {
  const result = buildPlannerMessages("Current question", {
    brand: "Example Brand",
    history: "Recent context",
    catalogCategories: ["Fans", 42],
    catalogManufacturers: ["Maker", null],
  });
  const payload = JSON.parse(result.messages[0].content);

  assert.equal(result.messages[0].role, "user");
  assert.equal(payload.brand, "Example Brand");
  assert.equal(payload.currentQuestion, "Current question");
  assert.deepEqual(payload.catalogCategories, ["Fans"]);
  assert.deepEqual(payload.catalogManufacturers, ["Maker"]);
  assert.match(result.system, /never answer the customer/i);
});
