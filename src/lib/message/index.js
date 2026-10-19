// Customer-visible wording and button labels live here. Factual answers stay
// in the grounded answer pipeline; these are operational messages only.
export const customerMessages = Object.freeze({
  welcome: brand => `Welcome to ${brand} Support. How may I help you today?`,
  brandUnknown: "I couldn't identify the support brand for this conversation. Please ask to connect to an agent.",
  timeout: "I couldn't confirm a reliable answer in time. Please try again, or ask to connect to an agent.",
  answerUnavailable: "I'm having trouble preparing a response. Please try again, or ask to connect to an agent.",
  agentOffer: 'Would you like help from a human agent? If you agree, I will ask for the details needed to request support.',
  formPrompt: 'To request help from an agent, complete and submit the form below. Sending a chat message does not submit the form.',
  formReminder:
    'I have not recorded a completed form for this agent request. Please complete and submit the latest form above. If you cannot see it, say “show the form again”. You can also cancel the request or continue asking product questions.',
  formInvalid:
    'I could not validate that submission. Please use the latest form and complete your name, a valid email address, category, and issue description. Say “show the form again” if you need a new form.',
  formDeliveryUnknown:
    'I could not confirm that the form was delivered. Say “show the form again” to reopen it. I have not confirmed a new agent request.',
  handoff:
    'Your conversation has been transferred to the support team. Please wait for an agent’s reply here; I do not have a wait-time estimate.',
  afterHoursHandoff:
    'Your conversation has been transferred to the support team outside scheduled business hours. An agent’s reply may wait until business hours; I do not have a wait-time estimate.',
  handoffFailed: 'The transfer did not complete. Your submitted details are saved. Say “try again” to retry, or cancel the agent request.',
  handoffUnknown:
    'I cannot confirm the transfer status right now. I have not confirmed that an agent has joined. Please ask for a status update rather than submitting another request.',
  handoffUnavailable:
    'I cannot verify your agent-request status right now. I have not confirmed a new submission or transfer. Please try again shortly.',
  handoffCancelled: 'Your pending agent request is cancelled. What else can I help you with?',
  outsideHours: 'Our live agents are unavailable outside business hours. Please try again during business hours.',
  evidenceGap:
    "I couldn't confirm that detail from the available information. Could you clarify what you'd like to confirm, or ask to connect to an agent?",
  invalidAnswer: "I'm having trouble preparing a reliable response. Please try again, or ask to connect to an agent.",
  knowledgeUnavailable: "I can't access the information needed to confirm that right now. Please try again, or ask to connect to an agent.",
  confirmationButtons: ['✅ Yes, Connect me to Agent', '❌ No, Cancel']
});
