import { createZendeskClient } from '../../../api/zendesk/client/index.js';
import { fetchEscalationCategories } from '../../../api/zendesk/customObjects/index.js';
import { sendSunshineMessage, sendSunshineForm } from '../../messaging/messages/index.js';
import { customerMessages } from '../../../lib/message/index.js';
import { measureStage, safeErrorMetadata } from '../../../common/utils/timingLogger/index.js';

/**
 * Read trusted routing choices; group IDs stay on the backend rather than in customer form fields.
 * @returns {Promise<Array<Object>>} Category names, labels and trusted group IDs, or the general-support fallback.
 */
export async function getHandoffCategories() {
  const fallback = [{ name: 'general', label: 'General support', groupId: null }];
  if (!process.env.CATEGORY_OBJECT_NAME) return fallback;
  try {
    const client = await createZendeskClient();
    const response = await measureStage('zendesk.escalation_categories', () =>
      fetchEscalationCategories(client, process.env.CATEGORY_OBJECT_NAME)
    );
    const categories = new Map();
    for (const record of response.data?.custom_object_records || []) {
      const label = record.name?.trim();
      const groupId = String(record.custom_object_fields?.group_id || '');
      const name = label
        ?.replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
      if (name && /^\d+$/.test(groupId)) categories.set(name, { name, label, groupId });
    }
    return categories.size ? [...categories.values()] : fallback;
  } catch (error) {
    console.error('Escalation categories unavailable', safeErrorMetadata(error));
    return fallback;
  }
}

/**
 * Send visible instructions followed by the required customer-details form.
 * @param {string} conversationId - Sunshine conversation ID.
 * @param {Array<Object>} categories - Backend-approved category choices.
 * @returns {Promise<Object>} The delivered form response, including its message ID.
 */
export async function sendHandoffForm(conversationId, categories) {
  await sendSunshineMessage(conversationId, customerMessages.formPrompt);
  return measureStage('sunshine.form_send', () =>
    sendSunshineForm(conversationId, [
      { type: 'text', name: 'name', label: 'Your Name', required: true },
      { type: 'email', name: 'email', label: 'Email Address', required: true },
      {
        type: 'select',
        name: 'category',
        label: 'Issue Category',
        required: true,
        options: categories.map(({ name, label }) => ({ name, label }))
      },
      { type: 'text', name: 'description', label: 'Describe Your Issue', required: true }
    ])
  );
}

/**
 * Validate the submitted form against its saved message ID and trusted routing choices.
 * @param {Object} message - Customer formResponse message from the authenticated webhook.
 * @param {Object} state - This customer's persisted form state.
 * @returns {Object|null} Validated form data, or null for an incomplete, stale or unrelated form.
 */
export function readHandoffForm(message, state) {
  const fields = message.content?.fields;
  if (
    message.content?.type !== 'formResponse' ||
    !Array.isArray(fields) ||
    !state?.formMessageId ||
    message.quotedMessage?.message?.id !== state.formMessageId
  )
    return null;
  const value = name => {
    const matching = fields.filter(item => item.name === name);
    if (matching.length !== 1) return '';
    const field = matching[0];
    const selected = field?.select?.[0];
    const result = field?.text || field?.email || selected?.name || field?.value;
    return typeof result === 'string' ? result.trim() : '';
  };
  const name = value('name');
  const email = value('email');
  const description = value('description');
  const category = state.data.categories?.find(item => item.name === value('category'));
  if (
    !name ||
    name.length > 200 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !description ||
    description.length > 4000 ||
    !category
  )
    return null;
  return { name, email, description, category: category.label, category_id: category.groupId };
}

/**
 * Require a confirmed message ID before marking a form or offer as delivered.
 * @param {Object} response - Sunshine message response data.
 * @returns {string} The message ID; unknown response shapes raise an uncertain-delivery error.
 */
export function deliveredMessageId(response) {
  const id = response?.messages?.[0]?.id || response?.message?.id;
  if (typeof id !== 'string' || !id || id.length > 128) {
    throw Object.assign(new Error('Message delivery could not be confirmed'), { deliveryUncertain: true });
  }
  return id;
}
