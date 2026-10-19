import { generateClaudeText } from '../../rag/replies/index.js';
import { isClearInformationRequest, mightRequestHumanSupport } from '../../../common/messaging/intent/index.js';
import { logStage, measureStage } from '../../../common/utils/timingLogger/index.js';

const INFORMATION_QUERY_PATTERNS = [
  /^(what|how|when|where|why|who|is|are|does|do|can|could|would|will)\b/i,
  /\b(coverage|policy|policies|pricing|price|cost|fee|fees|international|domestic|eligible|eligib|available|availability|feature|plan|plans|option|options|limit|limits|refund|return|warranty|guarantee)\b/i
];
const TICKET_KEYWORDS = [
  'create ticket',
  'create a ticket',
  'create an issue',
  'file a ticket',
  'file a complaint',
  'file a claim',
  'speak with agent',
  'speak with an agent',
  'speak to agent',
  'talk to agent',
  'talk to an agent',
  'connect to agent',
  'connect to an agent',
  'connect with agent',
  'connect with an agent',
  'connect me with agent',
  'connect me with an agent',
  'connect me with and agent',
  'connect me to agent',
  'connect me to an agent',
  'need help from support',
  'help from support team',
  'need escalation',
  'professional help',
  'professional support',
  'agent assistance',
  'agent help',
  'technical support needed',
  'support ticket',
  'open a ticket',
  'raise a ticket',
  'raise an issue',
  'report issue',
  'report a problem',
  'report problem',
  'submit a ticket'
];

/**
 * Build the existing strict classifier instructions for explicit ticket or human-support requests.
 * @param {string} messageBody - Current customer message.
 * @returns {string} The unchanged intent-classification prompt.
 */
function createIntentDetectionPrompt(messageBody) {
  return `You are a strict support-ticket intent classifier.

Your ONLY job: determine whether the customer is EXPLICITLY requesting to create a support ticket or speak with a human agent/support representative.

Customer message: "${messageBody}"

Answer YES only if the customer clearly wants to:
- Create or submit a support ticket
- Speak with or be connected to a human agent
- Escalate their issue to a support team member

Answer NO for:
- General questions or FAQs (e.g. about coverage, pricing, features, policies)
- Informational queries (e.g. "how does X work?", "what is your policy on Y?")
- Quick-reply button selections about product topics
- Any message that is simply asking for information, not requesting human intervention

Be strict. When in doubt, answer NO.

Respond ONLY with "yes" or "no". Nothing else.`;
}

/**
 * Recognize explicit human-support requests, using the existing classifier only for ambiguous messages.
 * @param {string} messageBody - Current customer message.
 * @returns {Promise<boolean>} Whether the customer explicitly requests an agent; provider errors reject.
 */
export async function wantsHumanSupport(messageBody) {
  try {
    const messageLower = messageBody.toLowerCase().trim();
    const looksLikeInfoQuery = INFORMATION_QUERY_PATTERNS.some(pattern => pattern.test(messageLower));
    const hasTicketKeyword = TICKET_KEYWORDS.some(keyword => messageLower.includes(keyword));

    if (hasTicketKeyword && !/\b(?:not|never|don['’]t|do not|cancel)\b/i.test(messageLower)) {
      logStage('escalation.intent', {
        outcome: 'ticket',
        reason: 'explicit_keyword'
      });

      return true;
    }

    // Plain informational questions do not need the slower model classifier.
    if ((looksLikeInfoQuery && !mightRequestHumanSupport(messageLower)) || isClearInformationRequest(messageLower)) {
      logStage('escalation.intent', {
        outcome: 'not_ticket',
        reason: 'informational_shortcut'
      });

      return false;
    }

    const detectionPrompt = createIntentDetectionPrompt(messageBody);
    const response = await measureStage('escalation.classifier', () => generateClaudeText(detectionPrompt));
    const isYes = response.toLowerCase().trim() === 'yes';
    logStage('escalation.intent', {
      outcome: isYes ? 'ticket' : 'not_ticket',
      reason: 'ai_classifier'
    });

    return isYes;
  } catch (error) {
    logStage('escalation.intent', {
      outcome: 'not_ticket',
      reason: 'classifier_unavailable'
    });
    throw error;
  }
}
