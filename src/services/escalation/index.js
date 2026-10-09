import { createSunshineClient } from '../../api/sunshine/client.js';
import { createZendeskClient } from '../../api/zendesk/client.js';
import { fetchEscalationCategories } from '../../api/zendesk/customObjects.js';
import { passConversationControl } from '../../api/sunshine/conversations.js';
import { getForm, deleteForm, saveForm } from '../../models/conversationForm/index.js';
import { generateClaudeText } from '../rag/replies.js';
import { sendSunshineMessage, sendSunshineForm } from '../messaging/messages.js';
import { customerMessages } from '../../lib/message/index.js';
import { logStage, measureStage } from '../../common/utils/timingLogger.js';
import { isClearInformationRequest, mightRequestHumanSupport } from '../../common/messaging/intent.js';
import { isWithinBusinessHours } from '../businessHours/index.js';

const CATEGORY_OBJECT_KEY = process.env.CATEGORY_OBJECT_NAME;
const CATEGORY_OBJECT_ID_FIELD = 'group_id';
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

function formSelector(webUserId) {
  return webUserId ? { webUserId } : {};
}

function defaultCategoryOptions() {
  return [{ name: 'general', label: 'General support', value: 'general' }];
}

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
 * Map submitted identity and category details into the existing Zendesk data-capture fields.
 * @param {Object} formData - Submitted customer and category details.
 * @returns {Object} Switchboard metadata without changing the handoff payload contract.
 */
function buildHandoffMetadata(formData) {
  const categoryTag = (formData.category || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const metadata = {
    reason: 'user_requested_agent',
    'dataCapture.systemField.tags': ['escalated_to_agent', categoryTag].filter(Boolean).join(', ')
  };

  if (/^\d+$/.test(String(formData.category_id || ''))) {
    metadata['dataCapture.systemField.groupId'] = String(formData.category_id);
  }
  if (formData.email) {
    metadata['dataCapture.systemField.requester.email'] = formData.email;
  }
  if (formData.name) {
    metadata['dataCapture.systemField.requester.name'] = formData.name;
  }

  return metadata;
}

/**
 * Read category records and convert valid group IDs into customer form options.
 * @returns {Promise<Array<Object>>} Deduplicated category options, or an empty list on API failure.
 */
async function fetchEscalationCategoryOptions() {
  if (!CATEGORY_OBJECT_KEY) {
    return [];
  }

  try {
    const zendeskClient = await createZendeskClient();
    const response = await measureStage('zendesk.escalation_categories', () =>
      fetchEscalationCategories(zendeskClient, CATEGORY_OBJECT_KEY)
    );
    logStage('zendesk.escalation_categories_result', {
      rows: response.data?.custom_object_records?.length || 0
    });

    const records = response.data?.custom_object_records || [];
    const categoriesByKey = new Map();

    for (const record of records) {
      const groupName = record.name?.trim();
      const groupId = record.custom_object_fields?.[CATEGORY_OBJECT_ID_FIELD];

      if (!groupName || !groupId) {
        continue;
      }

      const categoryKey = groupName
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();

      categoriesByKey.set(categoryKey, {
        name: categoryKey,
        label: groupName,
        groupId
      });
    }

    return Array.from(categoriesByKey.values());
  } catch (error) {
    console.error('Failed to fetch escalation category options:', error.response?.data || error.message);

    return [];
  }
}

/**
 * Build and send the existing required identity, category, and issue-description form.
 * @param {string} conversationId - Sunshine conversation ID.
 * @returns {Promise<Object>} The Sunshine form response; rejects on a delivery failure.
 */
async function sendDetailCollectionForm(conversationId) {
  try {
    if (
      !process.env.SUNSHINE_APP_ID ||
      !process.env.ZENDESK_SUBDOMAIN ||
      !process.env.SUNSHINE_KEY_ID ||
      !process.env.SUNSHINE_KEY_SECRET
    ) {
      throw new Error('Missing required config');
    }

    const fetchedOptions = await fetchEscalationCategoryOptions();
    const categoryOptions = fetchedOptions.length > 0 ? fetchedOptions : defaultCategoryOptions();

    const fields = [
      { type: 'text', name: 'name', label: 'Your Name', required: true },
      { type: 'email', name: 'email', label: 'Email Address', required: true },
      {
        type: 'select',
        name: 'category',
        label: 'Issue Category',
        required: true,
        options: categoryOptions
      },
      {
        type: 'text',
        name: 'description',
        label: 'Describe Your Issue',
        required: true
      }
    ];

    return await measureStage('sunshine.form_send', () => sendSunshineForm(conversationId, fields));
  } catch (error) {
    console.error('Failed to send detail collection form:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Pass switchboard control before sending the existing in-hours or after-hours confirmation.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {Object} formData - Submitted customer and category details.
 * @returns {Promise<Object>} The passControl response; propagates handoff or message-delivery failures.
 */
export async function escalateToAgent(conversationId, formData = {}) {
  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error('SUNSHINE_APP_ID not configured in .env');
    }

    const { withinHours } = await measureStage('escalation.business_hours', () => isWithinBusinessHours());
    logStage('escalation.business_hours_result', { withinHours });

    // Explicit passControl is idempotent; perform it before the confirmation.
    // passControl handles Smooch↔Zendesk user linking and ticket association automatically.
    console.log('🔄 Passing control to agent workspace...');
    const sunshineClient = createSunshineClient();
    const metadata = buildHandoffMetadata(formData);
    const response = await measureStage('sunshine.pass_control', () => passConversationControl(sunshineClient, conversationId, metadata), {
      conversationId,
      operation: 'zd-agentWorkspace',
      timeoutMs: 15_000
    });
    logStage('escalation.handoff_result', {
      conversationId,
      httpStatus: response.status
    });

    const confirmationMessage = withinHours
      ? customerMessages.handoff
      : process.env.AFTER_HOURS_TICKET_CREATED_MESSAGE || customerMessages.afterHoursHandoff;
    await sendSunshineMessage(conversationId, confirmationMessage);

    return response.data;
  } catch (error) {
    const status = error.response?.status;
    console.error('Escalation error', { status, message: error.message });
    throw error;
  }
}

/**
 * Detect whether a customer message is requesting ticket creation / agent escalation.
 * Uses fast keyword matching first, then falls back to an AI classifier.
 *
 * @param {string} messageBody
 * @param {Function} generateContent - AI content-generation helper
 * @returns {Promise<boolean>}
 */
async function shouldCreateTicket(messageBody, generateContent) {
  generateContent = generateContent || generateClaudeText;
  try {
    const messageLower = messageBody.toLowerCase().trim();
    const looksLikeInfoQuery = INFORMATION_QUERY_PATTERNS.some(pattern => pattern.test(messageLower));
    const hasTicketKeyword = TICKET_KEYWORDS.some(keyword => messageLower.includes(keyword));

    if (hasTicketKeyword) {
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
    const response = await measureStage('escalation.classifier', () => generateContent(detectionPrompt));
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
    console.error('⚠️ Error detecting ticket request:', error.message);

    return false;
  }
}

/**
 * Handoff a submitted form and clear it only after the existing escalation flow succeeds.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {string} webUserId - Customer ID within the conversation.
 * @returns {Promise<void>} Resolves after the customer response; propagates uncertain-delivery errors.
 */
export async function handleEscalateToAgent(conversationId, webUserId = null) {
  const selector = formSelector(webUserId);
  const form = await getForm(conversationId, selector);

  if (!form?.data || form.status !== 'form_submitted') {
    await sendSunshineMessage(conversationId, customerMessages.formMissing);

    return;
  }
  try {
    await escalateToAgent(conversationId, form.data);
    await deleteForm(conversationId, selector);
  } catch (error) {
    if (error.deliveryUncertain) {
      throw error;
    }

    console.error('Agent handoff failed', {
      status: error.response?.status,
      message: error.message
    });
    await sendSunshineMessage(conversationId, customerMessages.handoffFailed);
  }
}

/**
 * Remove the selected escalation form and send the existing cancellation response.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {string} webUserId - Customer ID within the conversation.
 * @returns {Promise<void>} Resolves after cancellation delivery.
 */
export async function handleCancelEscalation(conversationId, webUserId = null) {
  await deleteForm(conversationId, formSelector(webUserId));
  await sendSunshineMessage(conversationId, customerMessages.cancellation);
}

/**
 * Handle the escalation check for a normal customer message.
 * If the customer wants a ticket, either show the form (first time) or escalate directly.
 *
 * @param {object}   opts
 * @param {string}   opts.conversationId
 * @param {string}   opts.messageBody
 * @param {string}   opts.userName
 * @param {Function} opts.generateContent
 * @returns {Promise<boolean>} true if the escalation path was taken
 */
export async function handleEscalationCheck({ conversationId, messageBody, userName, generateContent, webUserId = null }) {
  const wantsEscalation = await shouldCreateTicket(messageBody, generateContent);

  if (!wantsEscalation) {
    return false;
  }

  const { withinHours, message } = await measureStage('escalation.business_hours', () => isWithinBusinessHours());
  logStage('escalation.business_hours_result', { withinHours });
  if (!withinHours && message) {
    await sendSunshineMessage(conversationId, message);
  }

  const selector = formSelector(webUserId);
  const formDoc = await getForm(conversationId, selector);
  const formStatus = formDoc?.status;

  // The customer has already received a form, so avoid sending a duplicate.
  if (formStatus === 'pending_form') {
    await sendSunshineMessage(conversationId, customerMessages.formReminder);

    return true;
  }

  // A completed form can go straight to the handoff.
  if (formStatus === 'form_submitted' && formDoc?.data) {
    await escalateToAgent(conversationId, formDoc.data);
    await deleteForm(conversationId, selector);

    return true;
  }

  // No recognized state means this is a fresh escalation request.
  await sendDetailCollectionForm(conversationId);

  await saveForm(conversationId, {
    status: 'pending_form',
    initiatedBy: userName,
    data: { webUserId },
    submittedAt: Date.now()
  });

  return true;
}
