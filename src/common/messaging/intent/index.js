// These recognize request forms, not product-name aliases or business facts.
// Catalog filters still come only from the current brand's stored labels.
const PROCEDURAL_RECOMMENDATION =
  /\b(?:suggest|recommend)\b.{0,60}\b(?:how to|steps?|instructions?|procedures?|repair|cleaning methods?)\b/i;
const DIRECT_PRODUCT_RECOMMENDATION = /^(?:(?:please|kindly)\s+)?(?:suggest|recommend)\b/i;
const PRODUCT_SELECTION_LANGUAGE =
  /\b(?:suggest|recommend|recommendations?|help me (?:choose|pick|select)|looking for|which .{0,100}(?:buy|choose|pick)|best .{0,100}(?:options?|products?|models?))\b/i;
const HUMAN_SUPPORT_LANGUAGE =
  /\b(?:agents?|human|person|staff|specialist|representatives?|tickets?|complaints?|claims?|escalat\w*|speak|talk|support team|customer service|someone|somebody)\b/i;
const DIRECT_INFORMATION_REQUEST = /^(?:(?:please|kindly)\s+)?(?:find|compare|show|list|describe|explain|tell me about|give me)\b/i;
const SIMPLE_GREETING = /^(?:hi|hello|hey|thanks|thank you|good (?:morning|afternoon|evening))[!.?\s]*$/i;

/**
 * Recognize a clear product-selection request from the existing question patterns.
 * @param {*} value - Input value being inspected or normalized.
 * @returns {boolean} Whether the message asks for product selection.
 */
export function isProductSelectionRequest(value) {
  const text = String(value || '').trim();
  if (PROCEDURAL_RECOMMENDATION.test(text)) {
    return false;
  }

  return DIRECT_PRODUCT_RECOMMENDATION.test(text) || PRODUCT_SELECTION_LANGUAGE.test(text);
}

export function mightRequestHumanSupport(value) {
  return HUMAN_SUPPORT_LANGUAGE.test(String(value || ''));
}

/**
 * Recognize an informational question that does not need the escalation classifier.
 * @param {*} value - Input value being inspected or normalized.
 * @returns {boolean} Whether the existing informational shortcut applies.
 */
export function isClearInformationRequest(value) {
  const text = String(value || '').trim();
  if (!text || mightRequestHumanSupport(text)) {
    return false;
  }

  return isProductSelectionRequest(text) || DIRECT_INFORMATION_REQUEST.test(text) || SIMPLE_GREETING.test(text);
}
