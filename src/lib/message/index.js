// Customer-visible wording and button labels live here. Factual answers stay
// in the grounded answer pipeline; these are operational messages only.
export const customerMessages = Object.freeze({
  welcome: brand => `Welcome to ${brand} Support. How may I help you today?`,
  brandUnknown: "I couldn't identify the support brand for this conversation. Please ask to connect to an agent.",
  timeout: "I couldn't confirm a reliable answer in time. Please try again, or ask to connect to an agent.",
  answerUnavailable: "I'm having trouble preparing a response. Please try again, or ask to connect to an agent.",
  formPrompt: 'Please fill out this form so we can help you.',
  formReminder: 'Please fill out the form above so we can connect you with an agent.',
  formMissing: "I couldn't find your form details. Please fill out the form again.",
  formSubmitted: (name, category) => `Thank you ${name}. Would you like to connect with an agent about your ${category} issue?`,
  handoff: "Connecting you to a human agent. They'll be with you shortly.",
  afterHoursHandoff: 'We received your request outside working hours. Our team will contact you when agents return.',
  handoffFailed: "I couldn't connect you to an agent just now. Please try again.",
  cancellation: 'No problem. What else can I help you with?',
  outsideHours: 'Our live agents are unavailable outside business hours. Please try again during business hours.',
  evidenceGap:
    "I couldn't confirm that detail from the available information. Could you clarify what you'd like to confirm, or ask to connect to an agent?",
  invalidAnswer: "I'm having trouble preparing a reliable response. Please try again, or ask to connect to an agent.",
  knowledgeUnavailable: "I can't access the information needed to confirm that right now. Please try again, or ask to connect to an agent.",
  confirmationButtons: ['✅ Yes, Connect me to Agent', '❌ No, Cancel']
});
