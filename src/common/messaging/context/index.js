const DEFAULT_TEXT_LIMIT = 1_200;
const COMPARISON_TEXT_LIMIT = 20_000;
const MAX_FACTS = 24;

function cleanText(value, limit = DEFAULT_TEXT_LIMIT) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeForComparison(value) {
  return cleanText(value, COMPARISON_TEXT_LIMIT).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalize and bound the saved customer case fields used by later turns.
 * @param {*} value - Saved case state to validate; invalid values become empty state.
 * @returns {Object} The normalized case state without mutating the supplied object.
 */
export function normalizeConversationState(value = {}) {
  const state = value && typeof value === 'object' ? value : {};
  const facts = Array.isArray(state.facts) ? state.facts : [];

  return {
    activeRequest: cleanText(state.activeRequest),
    productReference: cleanText(state.productReference, 200),
    pendingQuestion: cleanText(state.pendingQuestion, 800),
    facts: facts
      .filter(fact => fact && typeof fact.key === 'string' && typeof fact.value === 'string' && typeof fact.evidence === 'string')
      .slice(-MAX_FACTS)
      .map(fact => ({
        key: cleanText(fact.key, 64),
        value: cleanText(fact.value, 300),
        evidence: cleanText(fact.evidence, 600),
        messageId: cleanText(fact.messageId, 128)
      }))
  };
}

// Facts must quote the current customer's actual words. Inferences such as
// retailer authorization and policy eligibility never become customer facts.
/**
 * Update saved case context from the current message and validated reply while respecting topic changes.
 * @param {Object} previous - Saved case state from the preceding turn.
 * @param {string} question - Current customer question.
 * @param {Object} plan - Normalized retrieval plan.
 * @param {Object} answer - Validated reply status, text, and pending question.
 * @param {string|null} messageId - Customer message ID attached to retained facts.
 * @returns {Object} The next normalized conversation state.
 */
export function updateConversationState(previous, question, plan = {}, answer = {}, messageId = null) {
  const topicChanged = plan.topicChanged === true;
  const state = normalizeConversationState(topicChanged ? {} : previous);

  if (topicChanged || !state.activeRequest) {
    state.activeRequest = cleanText(question);
  }

  const normalizedQuestion = normalizeForComparison(question);
  const factsByKey = new Map(state.facts.map(fact => [fact.key, fact]));

  for (const fact of Array.isArray(plan.caseFacts) ? plan.caseFacts : []) {
    const key = cleanText(fact?.key, 64)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');
    const value = cleanText(fact?.value, 300);
    const evidence = cleanText(fact?.evidence, 600);
    const normalizedEvidence = normalizeForComparison(evidence);

    const evidenceAppearsInQuestion = normalizedQuestion.includes(normalizedEvidence);
    const valueAppearsInEvidence = normalizedEvidence.includes(normalizeForComparison(value));

    if (!key || !value || !evidence || !evidenceAppearsInQuestion || !valueAppearsInEvidence) {
      continue;
    }

    factsByKey.set(key, { key, value, evidence, messageId });
  }

  state.facts = [...factsByKey.values()].slice(-MAX_FACTS);

  const productReference = cleanText(plan.filters?.productName, 200);
  const customerEvidence = [question, ...state.facts.map(fact => fact.evidence)].join('\n');
  if (productReference && normalizeForComparison(customerEvidence).includes(normalizeForComparison(productReference))) {
    state.productReference = productReference;
  }
  if (topicChanged && !productReference) {
    state.productReference = '';
  }

  state.pendingQuestion =
    answer.status === 'clarify' ? cleanText(answer.pendingQuestion || answer.reply, 800) : cleanText(answer.pendingQuestion, 800);

  return state;
}

/**
 * Resolve a short follow-up from retained case context using the existing conservative rules.
 * @param {string} question - Current customer question.
 * @param {string} history - Earlier conversation text.
 * @param {Object} state - Current conversation or pipeline state.
 * @returns {string} The fallback retrieval question.
 */
export function contextualFallbackQuery(question, history = '', state = {}) {
  const memory = normalizeConversationState(state);
  if (!history && !memory.activeRequest && !memory.pendingQuestion) {
    return String(question).slice(0, 1000);
  }

  const context = [
    memory.activeRequest && `Active customer request: ${memory.activeRequest.slice(0, 250)}`,
    memory.productReference && `Customer product: ${memory.productReference}`,
    memory.pendingQuestion && `Assistant asked: ${memory.pendingQuestion.slice(0, 250)}`,
    !memory.activeRequest && history && `Recent conversation: ${String(history).slice(-450)}`
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 900);

  return `${context}\nLatest customer message: ${String(question).slice(0, 600)}`;
}
