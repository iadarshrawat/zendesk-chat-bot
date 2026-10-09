function normalizeIdentity(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function compactIdentity(value) {
  return normalizeIdentity(value).replace(/ /g, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function productIdentityValues(product) {
  return [product.productId, ...(product.alternateProductIds || []), ...(product.modelIds || []), product.productName];
}

/**
 * Match a product identifier using the existing boundary rules.
 * @param {Object} product - Normalized catalog product.
 * @param {string} normalizedReference - Normalized customer product reference.
 * @returns {boolean} Whether the identifier appears as a valid product reference.
 */
function hasIdentifierInText(product, normalizedReference) {
  return [product.productId, ...(product.alternateProductIds || []), ...(product.modelIds || [])].some(identifier => {
    const normalizedIdentifier = normalizeIdentity(identifier);
    if (!normalizedIdentifier) {
      return false;
    }

    const pattern = new RegExp(`(^| )${escapeRegExp(normalizedIdentifier)}( |$)`, 'u');

    return pattern.test(normalizedReference);
  });
}

/**
 * Classify product matches while accounting for incomplete catalog results.
 * @param {Array<Object>} products - Matching catalog products.
 * @param {Object} options - Result truncation, customer reference, and embedded-ID flag.
 * @returns {Object} The resolved, unresolved, or ambiguous status with its products.
 */
function identityResult(products, { truncated, reference, embedded = false }) {
  if (products.length > 1) {
    return { status: 'ambiguous', products };
  }

  const productId = normalizeIdentity(products[0].productId);
  const referenceMatchesId = embedded
    ? new RegExp(`(^| )${escapeRegExp(productId)}( |$)`, 'u').test(normalizeIdentity(reference))
    : productId === normalizeIdentity(reference);
  const status = truncated && !referenceMatchesId ? 'unresolved' : 'resolved';

  return { status, products };
}

/**
 * Resolve the customer's product reference using the existing alias and ambiguity checks.
 * @param {string} reference - Customer product name, model, or alias.
 * @param {Array<Object>} products - Catalog or retrieved products.
 * @param {Object} options - Options: truncated.
 * @returns {Object} The existing resolved, ambiguous, or missing product-reference result.
 */
export function resolveProductReference(reference, products = [], { truncated = false } = {}) {
  if (!reference) {
    return { status: 'none', products: [] };
  }

  const referenceKey = compactIdentity(reference);
  const distinctProducts = [
    ...new Map(products.filter(product => product.productId).map(product => [normalizeIdentity(product.productId), product])).values()
  ];

  const exactMatches = distinctProducts.filter(product =>
    productIdentityValues(product).some(value => compactIdentity(value) === referenceKey)
  );
  if (exactMatches.length) {
    // An exact canonical SKU can resolve a product in a partial catalog. A name
    // may have unseen duplicates, so it must not establish uniqueness there.
    return identityResult(exactMatches, { truncated, reference });
  }

  const normalizedReference = normalizeIdentity(reference);
  const embeddedMatches = distinctProducts.filter(product => hasIdentifierInText(product, normalizedReference));
  if (embeddedMatches.length) {
    return identityResult(embeddedMatches, {
      truncated,
      reference,
      embedded: true
    });
  }

  const referenceTerms = new Set(normalizedReference.split(' ').filter(Boolean));
  if (referenceTerms.size < 3) {
    return { status: 'unresolved', products: [] };
  }

  const rankedProducts = distinctProducts
    .map(product => {
      const nameTerms = new Set(normalizeIdentity(product.productName).split(' ').filter(Boolean));
      const overlap = [...referenceTerms].filter(term => nameTerms.has(term)).length;
      const score = (2 * overlap) / (referenceTerms.size + nameTerms.size);

      return { product, overlap, score };
    })
    .filter(({ overlap, score }) => overlap >= 3 && score >= 0.72)
    .sort((left, right) => right.score - left.score);

  if (!rankedProducts.length) {
    return { status: 'unresolved', products: [] };
  }

  const bestMatches = rankedProducts.slice(0, 4).map(({ product }) => product);
  if (truncated) {
    return { status: 'unresolved', products: bestMatches };
  }

  const topScoresAreClose = rankedProducts[1] && rankedProducts[0].score - rankedProducts[1].score < 0.12;
  if (topScoresAreClose) {
    return { status: 'ambiguous', products: bestMatches };
  }

  return { status: 'resolved', products: [rankedProducts[0].product] };
}

/**
 * Collect a product's canonical ID and existing alternate and model identifiers.
 * @param {Object} identity - Resolved or ambiguous product reference.
 * @returns {Array<string>} Unique product identity values.
 */
export function productIdentifiers(identity) {
  return identity?.status === 'resolved'
    ? [
        ...new Set(
          identity.products
            .flatMap(product => [product.productId, ...(product.alternateProductIds || [])])
            .filter(Boolean)
            .map(value => String(value).toLowerCase())
        )
      ]
    : [];
}

/**
 * Reject chunk evidence explicitly scoped to a different resolved product.
 * @param {Object} chunk - Knowledge chunk with product identity metadata.
 * @param {Object} identity - Resolved or ambiguous product reference.
 * @returns {boolean} Whether the chunk conflicts with the selected product.
 */
export function isConflictingProductChunk(chunk, identity) {
  const ids = productIdentifiers(identity);
  if (!ids.length || chunk.documentScope === 'brand') {
    return false;
  }
  const scoped = chunk.documentScope === 'product';
  const chunkIds = [
    ...new Set(
      [...(chunk.productIds || []), chunk.productId, ...(chunk.alternateProductIds || [])]
        .filter(Boolean)
        .map(value => String(value).toLowerCase())
    )
  ];
  if (!scoped || !chunkIds.length) {
    return false;
  }

  return !chunkIds.some(id => ids.includes(id));
}
