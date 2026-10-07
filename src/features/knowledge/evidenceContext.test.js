import test from "node:test";
import assert from "node:assert/strict";
import { productEvidence, renderProductEvidence } from "./evidenceContext.js";
import { createRetrievalPipeline } from "./retrievalPipeline.js";

const selectionPlan = {
  intent: "product_search",
  supportGoal: "selection",
  requiresProductIdentity: false,
  requestedConstraints: [],
  filters: { category: "fan" },
  semanticQuery: "Show fans",
  turnType: "new_question",
};

function product(index = 1) {
  return {
    productId: `fan-${index}`,
    modelIds: [`F${index}`],
    productName: `Fan ${index}`,
    manufacturerBrand: "Example",
    category: "fan",
    productUse: "indoor",
    features: ["Three speeds; indoor use only"],
    price: 0,
    description: `Complete description ${index}. `.repeat(40),
    ragSummary: `Detailed summary ${index}. `.repeat(40),
    specifications: { voltage: "120 V", noise: "No tested noise rating" },
    attributes: { marketingCopy: `Product-specific copy ${index}. `.repeat(40) },
    warrantyMonths: 0,
    manualPaths: [`manual-${index}.pdf`],
  };
}

test("general selection keeps 20 identities and exact selection facts with less context", () => {
  const products = Array.from({ length: 20 }, (_, index) => product(index + 1));
  const rendered = renderProductEvidence(products, { plan: selectionPlan, compact: false });

  assert.equal(rendered.text.split("\n").length, 20);
  assert.match(rendered.text, /\[PRODUCT 20\]/);
  assert.ok(rendered.text.length < rendered.beforeChars / 2);
  assert.equal(rendered.fieldsSavedChars, rendered.beforeChars - rendered.text.length);
  const evidence = productEvidence(products[0], { plan: selectionPlan });
  assert.equal(evidence.productId, "fan-1");
  assert.equal(evidence.price, 0);
  assert.deepEqual(evidence.features, products[0].features);
  assert.equal(evidence.description, undefined);
  assert.equal(evidence.ragSummary, undefined);
  assert.equal(evidence.attributes, undefined);
  assert.equal(evidence.specifications, undefined);
});

test("specific support and constrained selection retain full evidence and qualifiers", () => {
  const original = product();
  const full = productEvidence(original);
  const plans = [
    { ...selectionPlan, intent: "knowledge", supportGoal: "specification" },
    { ...selectionPlan, supportGoal: "troubleshooting", requiresProductIdentity: true },
    { ...selectionPlan, requestedConstraints: ["quiet", "for a 400 square foot room"] },
    { ...selectionPlan, filters: { category: "fan", maxPrice: 0 } },
    { ...selectionPlan, filters: { material: "aluminium" } },
  ];

  for (const plan of plans) {
    assert.deepEqual(productEvidence(original, { plan }), full);
  }
  assert.equal(full.specifications.noise, "No tested noise rating");
  assert.equal(full.warrantyMonths, 0);
});

test("a prose-only candidate keeps one complete description, including exceptions", () => {
  const original = {
    ...product(),
    features: [],
    description: "Portable unit. Use indoors only; unsuitable for damp locations.",
  };
  const evidence = productEvidence(original, { plan: selectionPlan });
  assert.equal(evidence.description, original.description);
  assert.equal(evidence.ragSummary, undefined);

  original.features = {};
  assert.equal(productEvidence(original, { plan: selectionPlan }).description, original.description);

  delete original.description;
  assert.equal(productEvidence(original, { plan: selectionPlan }).ragSummary, original.ragSummary);
});

test("retrieval uses the reduced fields while keeping 20 products and five knowledge chunks", async () => {
  const products = Array.from({ length: 20 }, (_, index) => product(index + 1));
  const pipeline = createRetrievalPipeline({
    config: { finalChunkCount: 5, compactContext: true },
    createQueryPlan: async () => selectionPlan,
    embedQuery: async () => [1, 0],
    searchStructuredProducts: async () => ({ products, hasMore: true }),
    getCatalogSummary: async () => ({ categories: [], manufacturers: [] }),
    searchKnowledgeChunks: async () => Array.from({ length: 8 }, (_, index) => ({
      id: `chunk-${index}`,
      documentId: `document-${index}`,
      distance: index / 100,
      content: "Applicable documented facts.",
    })),
  });

  const result = await pipeline.retrieveKnowledge("Example", "Show fans");

  assert.equal(result.products.length, 20);
  assert.equal(result.chunks.length, 5);
  assert.equal(result.sources.length, 25);
  assert.equal(result.productsTruncated, true);
  assert.match(result.context, /CATALOG LIMIT/);
  assert.doesNotMatch(result.productEvidenceText, /marketingCopy|Detailed summary|Complete description/);
});
