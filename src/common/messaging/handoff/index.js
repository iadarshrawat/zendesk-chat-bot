const ACCEPTANCE =
  /^(?:(?:yes|yeah|yep|sure|okay|ok|haan|han|ha|ji|bilkul|हाँ|हां|जी)(?:[,\s]+(?:please|thanks|thank you|go ahead|connect me))?|please do|go ahead)[.!\s]*$/i;
const CANCELLATION =
  /^(?:no(?: thanks| thank you)?|(?:no[,\s]+)?cancel(?: (?:it|the request|agent request|escalation|handoff))?|never mind|nevermind|not now|nahi|nahin|नहीं)[.!\s]*$/i;
const FORM_HELP =
  /(?:\b(?:form|button|link|option)\b.{0,70}\b(?:see|find|visible|show|open|again|where|missing|nahi|nahin)\b|\b(?:see|find|show|open|resend|where|missing)\b.{0,70}\b(?:form|button|link|option)\b)/i;
const WAITING =
  /^(?:(?:i(?:'m| am)|we(?:'re| are))\s+)?(?:still\s+)?waiting[.!?\s]*$|\b(?:any (?:update|news)|anyone (?:there|working)|is (?:someone|anyone) (?:there|working)|where is (?:the|my) agent|request status|connect hua|abhi tak)\b/i;
const OFFER_QUESTION =
  /(?:would you like|shall i|do you want|want me to|should i|kya (?:aap|main)).{0,100}\b(?:agent|human|representative|support team)\b/i;
const UNSUPPORTED_CLAIMS = [
  /\b(?:i(?:'ve| have| am|'m)|we(?:'ve| have| are|'re))\s+(?:(?:already|now|successfully)\s+)?(?:connect\w*|transfer\w*|escalat\w*|submitt\w*|complet\w*|creat\w*|forward\w*|notif\w*|rout\w*|sent|sending)\b.{0,90}\b(?:agent|support|team|ticket|request|case|form)\b/i,
  /\b(?:your|the|this)\s+(?:agent\s+)?(?:form|request|ticket|case|details)\s+(?:(?:has|have)\s+(?:already\s+)?been\s+|(?:is|are|was|were)\s+)?(?:(?:already|successfully|now)\s+)?(?:submitted|received|created|forwarded|escalated|transferred|sent|routed|completed|logged|saved)\b/i,
  /\byou(?:'re| are| have been)\s+(?:now\s+)?(?:connected|transferred|queued)\b/i,
  /\b(?:thank you|thanks)\s+for\s+(?:filling|submitting|completing)\b/i,
  /\b(?:agent|team|representative)\b.{0,50}\b(?:will (?:join|contact|call|be with)|has joined|is connected|shortly)\b/i,
  /\b(?:aapka|aapki|maine|humne)\b.{0,70}\b(?:submit|transfer|connect|forward|create)\b.{0,30}\b(?:diya|di|gaya|gayi|ho gaya|kar raha)\b/i
];

export function acceptsAgentOffer(text) {
  return ACCEPTANCE.test(String(text || '').trim());
}

export function cancelsAgentRequest(text, payload) {
  return (
    CANCELLATION.test(String(text || '').trim()) ||
    [text, payload].some(value => ['CANCEL_ESCALATION', '_NO_CANCEL', '❌ No, Cancel'].includes(value))
  );
}

export function needsFormHelp(text) {
  return FORM_HELP.test(String(text || ''));
}

export function asksHandoffStatus(text) {
  return WAITING.test(String(text || ''));
}

export function confirmsAgentRequest(text, payload) {
  return [text, payload].some(value =>
    [
      'ESCALATE_TO_AGENT',
      '_YES_CONNECT_ME_TO_AGENT',
      '_YES_REQUEST_AGENT_FOLLOW_UP',
      '✅ Yes, Connect me to Agent',
      '✅ Yes, Request agent follow-up',
      'CONNECT_TO_AGENT'
    ].includes(value)
  );
}

/**
 * Reject generated operational confirmations; only backend templates may announce handoff actions.
 * @param {string} text - Untrusted model reply.
 * @returns {boolean} Whether the reply contains a known unsupported handoff claim.
 */
export function hasUnsupportedHandoffClaim(text) {
  return UNSUPPORTED_CLAIMS.some(pattern => pattern.test(String(text || '')));
}

/**
 * Detect a requested backend agent offer, including older model replies without the control field.
 * @param {Object} answer - Validated model answer and optional offerAgent boolean.
 * @returns {boolean} Whether the backend should render its own agent offer.
 */
export function requestsAgentOffer(answer) {
  return answer?.offerAgent === true || OFFER_QUESTION.test(String(answer?.reply || ''));
}
