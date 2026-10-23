import { randomUUID } from 'node:crypto';
import { getSupportPolicy } from '../../config/brands/index.js';
import { loadHandoff, saveHandoff } from '../../models/handoff/index.js';
import { createSunshineClient } from '../../api/sunshine/client/index.js';
import { passConversationControl, fetchSunshineConversation } from '../../api/sunshine/conversations/index.js';
import { sendSunshineMessage } from '../messaging/messages/index.js';
import { isWithinBusinessHours } from '../businessHours/index.js';
import { isAgentActive } from '../../common/messaging/ownership/index.js';
import {
  acceptsAgentOffer,
  cancelsAgentRequest,
  confirmsAgentRequest,
  needsFormHelp,
  asksHandoffStatus,
  hasUnsupportedHandoffClaim,
  requestsAgentOffer
} from '../../common/messaging/handoff/index.js';
import { customerMessages } from '../../lib/message/index.js';
import { logStage, measureStage, safeErrorMetadata } from '../../common/utils/timingLogger/index.js';
import { getHandoffCategories, sendHandoffForm, readHandoffForm, deliveredMessageId } from './forms/index.js';
import { wantsHumanSupport } from './intent/index.js';

export * from './forms/index.js';
export * from './intent/index.js';

const TRANSFER_STATES = new Set(['transferring', 'transfer_unknown', 'transferred']);
const RETRY_REQUEST = /^(?:try again|retry|please retry|dobara|phir se)[.!\s]*$/i;
const TRANSFER_SETTLE_MS = 30_000;
const LEGACY_SUPPORT_POLICY = Object.freeze({ mode: 'live', followUpHours: 24 });

/**
 * Keep an active attempt's saved policy; older requests retain their original live flow.
 * @param {Object} event - Customer event and optional persisted handoff state.
 * @returns {Object} Saved support policy, or current widget configuration for a new request.
 */
function supportPolicyFor(event) {
  const state = event._handoff;
  if (state && state.status !== 'cancelled') return state.data.supportPolicy || LEGACY_SUPPORT_POLICY;
  return getSupportPolicy(event.payload.conversation.brandId);
}

/**
 * Select consistent offer wording and buttons for the current support mode.
 * @param {Object} event - Customer event with its saved handoff policy.
 * @returns {Object} Backend-owned offer text and quick-reply labels.
 */
function handoffOffer(event) {
  const followUp = supportPolicyFor(event).mode === 'follow_up';
  return {
    text: followUp ? customerMessages.followUpAgentOffer : customerMessages.agentOffer,
    quickReplies: followUp ? customerMessages.followUpConfirmationButtons : customerMessages.confirmationButtons
  };
}

function eventId(event) {
  const id = event.id || event.payload.message.id;
  if (typeof id !== 'string' || !id) throw new TypeError('A customer event ID is required for handoff actions');
  return id;
}

function ownerId(integration) {
  return typeof integration === 'string' ? integration : integration?.integrationId || integration?.id || null;
}

function messageTime(event) {
  return Date.parse(event.payload.message.received || event.createdAt || '');
}

/**
 * Persist one revision-checked workflow transition and retain it for the current message.
 * @param {Object} event - Authenticated customer event.
 * @param {Object} changes - Fields to replace in the current state.
 * @param {boolean} rememberEvent - False when only reconciling ownership before handling this event.
 * @returns {Promise<Object>} The saved handoff state.
 */
async function transition(event, changes, rememberEvent = true) {
  const previous = event._handoff;
  const next = {
    conversationId: event.payload.conversation.id,
    webUserId: event.payload.message.author.userId,
    ...previous,
    ...changes
  };
  const seenEventIds = [...new Set([...(previous?.data.seenEventIds || []), ...(rememberEvent ? [eventId(event)] : [])])].slice(-64);
  const latestTime = Math.max((rememberEvent && messageTime(event)) || 0, Date.parse(previous?.data.latestEventAt || '') || 0);
  next.data = { ...next.data, seenEventIds, ...(latestTime ? { latestEventAt: new Date(latestTime).toISOString() } : {}) };
  event._handoff = await saveHandoff(previous, next);
  logStage('handoff.transition', { outcome: next.status, conversationId: next.conversationId });
  return event._handoff;
}

/**
 * Send a workflow status and supersede an earlier product question after successful delivery.
 * @param {Object} event - Customer event and saved workflow state.
 * @param {string} text - Backend-owned status message.
 * @returns {Promise<void>} Sends the status and updates question context when needed.
 */
async function sendHandoffMessage(event, text) {
  const response = await sendSunshineMessage(event.payload.conversation.id, text);
  if (event._handoff?.data.productQuestionPending) {
    await transition(event, {
      data: { ...event._handoff.data, productQuestionPending: false, lastQuestionMessageId: deliveredMessageId(response) }
    });
  }
}

/**
 * Start or reopen intake, recording the attempt before sending instructions or a form.
 * @param {Object} event - Customer event requesting intake.
 * @returns {Promise<void>} Resolves after a confirmed form message ID has been saved.
 */
async function startIntake(event) {
  const supportPolicy = supportPolicyFor(event);
  const categories = await getHandoffCategories();
  await transition(event, {
    attemptId: randomUUID(),
    status: 'form_sending',
    offerMessageId: null,
    formMessageId: null,
    data: { categories, supportPolicy, lastEventId: eventId(event) }
  });
  const prompt = supportPolicy.mode === 'follow_up' ? customerMessages.followUpFormPrompt : customerMessages.formPrompt;
  const response = await sendHandoffForm(event.payload.conversation.id, categories, { prompt });
  await transition(event, { status: 'form_pending', formMessageId: deliveredMessageId(response) });
}

/**
 * Build routing metadata from validated form data, never from arbitrary customer-supplied group IDs.
 * @param {Object} data - Persisted and validated customer details.
 * @param {string} supportMode - Saved live or follow_up mode for this handoff attempt.
 * @returns {Object} Zendesk data-capture metadata for the existing passControl contract.
 */
function handoffMetadata(data, supportMode) {
  const categoryTag = data.category.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const tags = ['escalated_to_agent', categoryTag];
  if (['live', 'follow_up'].includes(supportMode)) tags.push(supportMode);
  const metadata = {
    reason: 'user_requested_agent',
    'dataCapture.systemField.tags': [...new Set(tags.filter(Boolean))].join(', '),
    'dataCapture.systemField.requester.email': data.email,
    'dataCapture.systemField.requester.name': data.name
  };
  if (/^\d+$/.test(data.category_id || '')) metadata['dataCapture.systemField.groupId'] = data.category_id;
  return metadata;
}

/**
 * Confirm transfer using the API response or a fresh ownership read; never infer a human has joined.
 * @param {Object} event - Current customer event and durable transfer state.
 * @returns {Promise<boolean>} True when Agent Workspace ownership is verified.
 */
async function confirmTransfer(event) {
  const state = event._handoff;
  const policy = supportPolicyFor(event);
  const tracking = { ...state.data };
  delete tracking.formData;
  delete tracking.categories;
  // Submitted identity details are no longer needed locally after confirmed transfer.
  await transition(event, { status: 'transferred', data: { ...tracking, confirmedAt: new Date().toISOString() } });
  const text =
    policy.mode === 'follow_up'
      ? customerMessages.followUpHandoff(policy.followUpHours)
      : state.data.withinHours === false
        ? customerMessages.afterHoursHandoff
        : customerMessages.handoff;
  await sendHandoffMessage(event, text);
  return true;
}

/**
 * Reconcile a timeout or restored in-flight transfer before allowing a retry or normal bot response.
 * @param {Object} event - Customer event with stored transfer state.
 * @returns {Promise<Object>} Current authoritative state; lookup failures preserve uncertainty.
 */
async function reconcileTransfer(event) {
  const state = event._handoff;
  let conversation;
  try {
    const response = await measureStage('sunshine.handoff_owner', () =>
      fetchSunshineConversation(createSunshineClient(), state.conversationId)
    );
    conversation = response.data?.conversation;
    if (!conversation || conversation.id !== state.conversationId || !Object.hasOwn(conversation, 'activeSwitchboardIntegration')) {
      throw new Error('Invalid conversation ownership response');
    }
  } catch (error) {
    logStage('handoff.reconcile_failed', safeErrorMetadata(error));
    return state;
  }
  const integration = conversation.activeSwitchboardIntegration;
  if (isAgentActive(integration)) {
    if (state.status !== 'transferred') await confirmTransfer(event);
    return event._handoff;
  }
  const stillOwnedByBot = ownerId(integration) === state.data.previousOwnerId;
  const settled = Date.now() - Date.parse(state.data.transferStartedAt || '') >= TRANSFER_SETTLE_MS;
  if (stillOwnedByBot && (state.status === 'transferred' || settled)) {
    await transition(event, { status: state.status === 'transferred' ? 'cancelled' : 'failed' }, false);
  }
  return event._handoff;
}

/**
 * Transfer a validated request once, persisting progress before the external side effect.
 * @param {Object} event - Customer event with form_submitted or safely retryable failed state.
 * @returns {Promise<void>} Completes transfer or retains accurate failed/uncertain state.
 */
async function transferToAgent(event) {
  const formData = event._handoff.data.formData;
  if (!formData) throw new Error('Validated form details are required for transfer');
  const supportPolicy = supportPolicyFor(event);
  const hours = supportPolicy.mode === 'live' ? await isWithinBusinessHours(new Date(), { includeMessage: false }) : null;
  const state = await transition(event, {
    status: 'transferring',
    data: {
      ...event._handoff.data,
      supportPolicy,
      lastEventId: eventId(event),
      transferMessageId: event.payload.message.id,
      transferStartedAt: new Date().toISOString(),
      previousOwnerId: ownerId(event.payload.conversation.activeSwitchboardIntegration),
      withinHours: hours?.verified ? hours.withinHours : null
    }
  });
  try {
    await measureStage('sunshine.pass_control', () =>
      passConversationControl(createSunshineClient(), state.conversationId, handoffMetadata(formData, supportPolicy.mode))
    );
  } catch (error) {
    const definitelyRejected = error.response?.status >= 400 && error.response.status < 500 && error.response.status !== 408;
    await transition(event, { status: definitelyRejected ? 'failed' : 'transfer_unknown' });
    logStage('handoff.transfer_failed', safeErrorMetadata(error));
    if (!definitelyRejected) await reconcileTransfer(event);
    if (event._handoff.status !== 'transferred') {
      await sendHandoffMessage(
        event,
        event._handoff.status === 'failed' ? customerMessages.handoffFailed : customerMessages.handoffUnknown
      );
    }
    return;
  }
  // A failed confirmation delivery must never cause passControl to run again.
  await confirmTransfer(event);
}

/**
 * Validate the actual formResponse and transfer directly without asking for confirmation again.
 * @param {Object} event - Customer formResponse event.
 * @returns {Promise<void>} Saves validated details before transferring, or explains an invalid submission.
 */
async function submitForm(event) {
  const state = event._handoff;
  const formData = readHandoffForm(event.payload.message, state);
  if (state?.status !== 'form_pending' || !formData) {
    await sendHandoffMessage(event, customerMessages.formInvalid);
    return;
  }
  await transition(event, {
    status: 'form_submitted',
    data: { ...state.data, formData, lastEventId: eventId(event), productQuestionPending: false }
  });
  await transferToAgent(event);
}

/**
 * Route saved handoff state before any general escalation classifier or knowledge answer.
 * @param {Object} event - Authenticated customer event; receives its loaded state for later RAG use.
 * @returns {Promise<boolean>} True when handled; false permits a normal product response.
 */
export async function handleHandoffEvent(event) {
  const { conversation, message } = event.payload;
  event._handoff = await loadHandoff(conversation.id, message.author.userId);
  let state = event._handoff;
  const text = message.content?.text || message.content?.markdownText || '';
  const explicitAcceptance = confirmsAgentRequest(text, message.content?.payload);
  if (TRANSFER_STATES.has(state?.status)) {
    state = await reconcileTransfer(event);
    if (TRANSFER_STATES.has(state.status)) {
      if (state.status !== 'transferred') await sendHandoffMessage(event, customerMessages.handoffUnknown);
      return true;
    }
  }
  const currentForm =
    state?.status === 'form_pending' &&
    message.content?.type === 'formResponse' &&
    message.quotedMessage?.message?.id === state.formMessageId;
  if (!currentForm && messageTime(event) < Date.parse(state?.data.latestEventAt || '')) return true;
  if (state?.status !== 'form_submitted' && state?.data.seenEventIds?.includes(eventId(event))) return true;
  const shortProductAnswer = acceptsAgentOffer(text) || /^(?:no(?: thanks| thank you)?|nahi|nahin|नहीं)[.!\s]*$/i.test(text.trim());
  const cancellationButton = cancelsAgentRequest('', message.content?.payload) || text === customerMessages.confirmationButtons[1];
  if (state?.data.productQuestionPending && shortProductAnswer && !explicitAcceptance && !cancellationButton) return false;
  if (cancelsAgentRequest(text, message.content?.payload) && state && state.status !== 'cancelled') {
    await transition(event, { status: 'cancelled', data: { lastEventId: eventId(event) }, formMessageId: null, offerMessageId: null });
    await sendHandoffMessage(event, customerMessages.handoffCancelled);
    return true;
  }
  if (state?.status === 'form_submitted') {
    await transferToAgent(event);
    return true;
  }
  if (state?.data.lastEventId && state.data.lastEventId === eventId(event)) return true;
  if (message.content?.type === 'formResponse') {
    await submitForm(event);
    return true;
  }
  if (!text && !explicitAcceptance) return true;
  if (state?.status === 'offer_pending' && (explicitAcceptance || acceptsAgentOffer(text))) {
    await startIntake(event);
    return true;
  }
  if (state?.status === 'failed' && state.data.formData) {
    if (explicitAcceptance || RETRY_REQUEST.test(text)) {
      await transferToAgent(event);
      return true;
    }
    if (asksHandoffStatus(text) || acceptsAgentOffer(text)) {
      await sendHandoffMessage(event, customerMessages.handoffFailed);
      return true;
    }
  }
  if (['form_pending', 'form_sending'].includes(state?.status)) {
    if (needsFormHelp(text) || (state.status === 'form_sending' && RETRY_REQUEST.test(text))) {
      await startIntake(event);
      return true;
    }
    if (asksHandoffStatus(text) || explicitAcceptance || acceptsAgentOffer(text)) {
      await sendHandoffMessage(
        event,
        state.status === 'form_pending' ? customerMessages.formReminder : customerMessages.formDeliveryUnknown
      );
      return true;
    }
  }
  if (state?.status === 'offer_sending' && (acceptsAgentOffer(text) || asksHandoffStatus(text))) {
    await sendBackendOffer(event);
    return true;
  }
  if (explicitAcceptance) {
    await startIntake(event);
    return true;
  }
  if ((asksHandoffStatus(text) || needsFormHelp(text)) && (!state || state.status === 'cancelled')) {
    await sendBackendOffer(event);
    return true;
  }
  if (acceptsAgentOffer(text) || cancelsAgentRequest(text)) return false;
  let requested;
  try {
    requested = await wantsHumanSupport(text);
  } catch (error) {
    logStage('handoff.classifier_unavailable', safeErrorMetadata(error));
    return false;
  }
  if (!requested) return false;
  if (state?.status === 'failed' && state.data.formData) await sendHandoffMessage(event, customerMessages.handoffFailed);
  else if (['form_pending', 'form_sending'].includes(state?.status))
    await sendHandoffMessage(event, state.status === 'form_pending' ? customerMessages.formReminder : customerMessages.formDeliveryUnknown);
  else {
    // Classification is not consent: confirm a free-text request before opening intake.
    await sendBackendOffer(event);
  }
  return true;
}

/**
 * Prepare an application-controlled agent offer and save intent before its message is posted.
 * @param {Object} event - Customer event and current handoff state.
 * @returns {Promise<void>} Marks the outgoing reply as an offer awaiting confirmed delivery.
 */
async function prepareOffer(event) {
  const supportPolicy = supportPolicyFor(event);
  await transition(event, {
    attemptId: randomUUID(),
    status: 'offer_sending',
    offerMessageId: null,
    formMessageId: null,
    data: { supportPolicy, lastEventId: eventId(event) }
  });
  event._outgoingAgentOffer = true;
}

/**
 * Recover an offer whose earlier delivery could not be confirmed.
 * @param {Object} event - Current customer event.
 * @returns {Promise<void>} Sends a fresh explicit offer without starting intake on an ambiguous Yes.
 */
async function sendBackendOffer(event) {
  await prepareOffer(event);
  const response = await sendSunshineMessage(event.payload.conversation.id, handoffOffer(event));
  await confirmHandoffReply(event, response);
}

/**
 * Replace generated handoff claims and render agent offers using backend-owned wording.
 * @param {Object} event - Customer event, including its authoritative loaded handoff state.
 * @param {Object} result - Grounded model answer to update before sending.
 * @returns {Promise<Object>} The safe outgoing message, with quick replies only for a stored offer.
 */
export async function prepareHandoffReply(event, result) {
  const state = event._handoff;
  const hasClaim = hasUnsupportedHandoffClaim(result.reply);
  // Resolve the customer's missing detail before appending a competing handoff question.
  const offer = hasClaim || (result.status !== 'clarify' && requestsAgentOffer(result));
  if (state && ['form_pending', 'form_sending', 'failed'].includes(state.status)) {
    if (offer) {
      result.reply =
        state.status === 'failed' && state.data.formData
          ? customerMessages.handoffFailed
          : state.status === 'form_pending'
            ? customerMessages.formReminder
            : customerMessages.formDeliveryUnknown;
      result.pendingQuestion = null;
    }
    event._productQuestionPending = Boolean(result.pendingQuestion) || /[?？]\s*$/.test(result.reply);
    return { text: result.reply };
  }
  if (offer) {
    await prepareOffer(event);
    const offerMessage = handoffOffer(event);
    // Old providers may put an offer in prose. Replace that wording so the final question is authoritative.
    result.reply = hasClaim || requestsAgentOffer({ reply: result.reply }) ? offerMessage.text : `${result.reply}\n\n${offerMessage.text}`;
    result.pendingQuestion = offerMessage.text;
    return { text: result.reply, quickReplies: offerMessage.quickReplies };
  }
  // A product answer supersedes an earlier agent offer; a later Yes must answer the newest question.
  if (state?.status === 'offer_pending' || state?.status === 'offer_sending') {
    await transition(event, { status: 'cancelled', data: { lastEventId: eventId(event) } });
  }
  return { text: result.reply };
}

/**
 * Save a delivered offer or a changed product-question context after Sunshine confirms delivery.
 * @param {Object} event - Event whose outgoing reply was prepared by the handoff workflow.
 * @param {Object} response - Successful Sunshine message response data.
 * @returns {Promise<void>} Saves confirmed offer identity or changed question context; unchanged replies need no write.
 */
export async function confirmHandoffReply(event, response) {
  if (event._outgoingAgentOffer) {
    await transition(event, { status: 'offer_pending', offerMessageId: deliveredMessageId(response) });
  } else if (
    event._handoff &&
    typeof event._productQuestionPending === 'boolean' &&
    Boolean(event._handoff.data.productQuestionPending) !== event._productQuestionPending
  ) {
    await transition(event, {
      data: {
        ...event._handoff.data,
        productQuestionPending: event._productQuestionPending,
        lastQuestionMessageId: deliveredMessageId(response)
      }
    });
  }
}
