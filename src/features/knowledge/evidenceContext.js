const PRODUCT_FIELDS = [
  "productId",
  "alternateProductIds",
  "modelIds",
  "productName",
  "manufacturerBrand",
  "distributor",
  "category",
  "productUse",
  "useCases",
  "materials",
  "colors",
  "price",
  "physicalForm",
  "flammability",
  "ingredients",
  "features",
  "description",
  "ragSummary",
  "specifications",
  "attributes",
  "warrantyMonths",
  "availability",
  "manualPaths",
];

const IDENTITY_FIELDS = new Set([
  "productId",
  "productName",
  "modelIds",
  "alternateProductIds",
  "manufacturerBrand",
]);

// General discovery needs identities and practical selection facts. Detailed
// or constrained requests keep the full evidence so qualifiers are not lost.
const DISCOVERY_FIELDS = new Set([
  ...IDENTITY_FIELDS,
  "category",
  "productUse",
  "useCases",
  "features",
  "price",
]);
const DISCOVERY_FILTERS = new Set([
  "productName", "manufacturerBrand", "category", "productUse",
]);

function useDiscoveryFields(plan) {
  return plan
    && ["catalog", "product_search"].includes(plan.intent)
    && ["catalog", "selection"].includes(plan.supportGoal)
    && !plan.requiresProductIdentity
    && !(plan.requestedConstraints?.length)
    && !Object.entries(plan.filters || {}).some(([field, value]) => (
      hasEvidenceValue(value) && !DISCOVERY_FILTERS.has(field)
    ));
}

const SELECTION_GUIDANCE = "Give 3–5 supported options at most, fewer if appropriate; one short practical reason per option. Do not assume suitability, price, noise level, stock, or any unstated requirement. Respect the requested number and comparisons; ask one useful question if needed. State that this is a shortlist, not all matching products.";
const COMPLETE_ANSWER_GUIDANCE = "Answer the requested scope concisely. Preserve requested comparisons, complete-list requests, exact specifications, prerequisites, exceptions and applicable manual steps. Never shorten by omitting a necessary condition or instruction.";

function hasEvidenceValue(value) {
  return value != null
    && value !== ""
    && (typeof value !== "object" || Object.keys(value).length > 0);
}

function renderProducts(products) {
  return products
    .map((product, index) => `[PRODUCT ${index + 1}] ${JSON.stringify(product)}`)
    .join("\n");
}

function findSharedValues(products) {
  const valueCounts = new Map();

  function countValue(value) {
    const serialized = JSON.stringify(value);
    if (serialized?.length >= 100) {
      const entry = valueCounts.get(serialized) || { value, count: 0 };
      entry.count += 1;
      valueCounts.set(serialized, entry);
    }

    if (Array.isArray(value)) {
      value.forEach(countValue);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(countValue);
    }
  }

  for (const product of products) {
    for (const [field, value] of Object.entries(product)) {
      if (!IDENTITY_FIELDS.has(field)) countValue(value);
    }
  }

  return [...valueCounts.entries()]
    .filter(([serialized, entry]) => (
      entry.count > 1
      && (entry.count - 1) * serialized.length > entry.count * 40 + 30
    ))
    .sort((left, right) => right[0].length - left[0].length);
}

function compactProducts(products, sharedValueLookup, usedReferences) {
  function compactValue(value) {
    const sharedValue = sharedValueLookup.get(JSON.stringify(value));
    if (sharedValue) {
      usedReferences.add(sharedValue.key);
      return { $evidenceRef: sharedValue.key };
    }

    if (Array.isArray(value)) return value.map(compactValue);

    if (value && typeof value === "object") {
      // These property names are reserved by the compact representation. Wrap
      // source data that already uses either name so it cannot be misread.
      if (Object.hasOwn(value, "$evidenceRef") || Object.hasOwn(value, "$evidenceLiteral")) {
        return { $evidenceLiteral: value };
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, compactValue(child)]),
      );
    }

    return value;
  }

  return products.map((product) => Object.fromEntries(
    Object.entries(product).map(([field, value]) => [
      field,
      IDENTITY_FIELDS.has(field) ? value : compactValue(value),
    ]),
  ));
}

export function productEvidence(product, { plan } = {}) {
  let fields = PRODUCT_FIELDS;
  if (useDiscoveryFields(plan)) {
    fields = PRODUCT_FIELDS.filter((field) => DISCOVERY_FIELDS.has(field));
    // A catalog may describe its use only in prose. Keep one complete prose
    // field as a fallback rather than truncating a sentence or its conditions.
    if (!hasEvidenceValue(product.features)) {
      const fallback = hasEvidenceValue(product.description) ? "description" : "ragSummary";
      fields = [...fields, fallback];
    }
  }
  return Object.fromEntries(
    fields
      .filter((field) => hasEvidenceValue(product[field]))
      .map((field) => [field, product[field]]),
  );
}

export function renderProductEvidence(products, { compact = true, plan } = {}) {
  const beforeChars = renderProducts(products.map((product) => productEvidence(product))).length;
  const originalProducts = products.map((product) => productEvidence(product, { plan }));
  const fullText = renderProducts(originalProducts);
  const fieldsSavedChars = beforeChars - fullText.length;

  if (!compact) {
    return {
      text: fullText,
      beforeChars,
      savedChars: fieldsSavedChars,
      fieldsSavedChars,
      sharedValues: 0,
    };
  }

  const sharedValueLookup = new Map(
    findSharedValues(originalProducts).map(([serialized, entry], index) => [
      serialized,
      { key: `V${index + 1}`, value: entry.value },
    ]),
  );
  const usedReferences = new Set();
  const compactedProducts = compactProducts(
    originalProducts,
    sharedValueLookup,
    usedReferences,
  );
  const sharedValues = Object.fromEntries(
    [...sharedValueLookup.values()]
      .filter((entry) => usedReferences.has(entry.key))
      .map((entry) => [entry.key, entry.value]),
  );
  const compactedText = usedReferences.size
    ? `SHARED EVIDENCE VALUES (exact original values; {"$evidenceRef":"Vn"} means the value stored under Vn; {"$evidenceLiteral":value} means literal original data, not a reference):\n${JSON.stringify(sharedValues)}\n${renderProducts(compactedProducts)}`
    : fullText;

  // Some data shapes cost more to describe than they save. In that case keep
  // the original representation.
  if (compactedText.length >= fullText.length) {
    return {
      text: fullText,
      beforeChars,
      savedChars: fieldsSavedChars,
      fieldsSavedChars,
      sharedValues: 0,
    };
  }

  return {
    text: compactedText,
    beforeChars,
    savedChars: beforeChars - compactedText.length,
    fieldsSavedChars,
    sharedValues: usedReferences.size,
  };
}

export function responseGuidance(rag, question = "", history = "") {
  const customerText = `${question} ${history}`;
  const asksForAll = rag.plan?.mustReturnAll === true
    || /\b(all|every|complete|exhaustive)\b|\bsaare\b|\bsabhi\b|सभी|सारे/i.test(customerText);
  // Be conservative: even a number referring to room size disables the soft
  // shortlist preference. Never accidentally cap an explicitly requested list.
  const explicitQuantity = /\b\d+\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b/i
    .test(customerText);
  const isOpenEndedSelection = rag.plan?.intent === "product_search"
    && rag.plan?.supportGoal === "selection"
    && !rag.plan?.requiresProductIdentity
    && !asksForAll
    && !explicitQuantity;

  return isOpenEndedSelection ? SELECTION_GUIDANCE : COMPLETE_ANSWER_GUIDANCE;
}
