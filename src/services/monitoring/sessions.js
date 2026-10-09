const CONVERSATION_EVENT_TYPES = ['Messaging::ConversationMessage', 'Comment'];
const CUSTOMER_AUTHOR_TYPES = ['end-user', 'user', 'customer'];
const BOT_AUTHOR_SUBTYPES = ['ai', 'bot'];
const DUPLICATE_MESSAGE_WINDOW_MS = 10_000;
const DUPLICATE_MESSAGE_LOOKBACK = 3;

/**
 * Extract readable text from the supported Zendesk conversation content shapes.
 * @param {Object} event - Sunshine webhook event.
 * @returns {string} Message text used for session evidence.
 */
function messageText(event) {
  const content = event.content || {};
  const attachmentPlaceholder = content.media_url || event.attachments?.length ? '[attachment shared]' : '';
  const rawText = content.text || content.body || content.markdownText || content.alt_text || attachmentPlaceholder;

  return String(rawText)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve customer, bot, or agent authors using the existing event and requester rules.
 * @param {Object} event - Sunshine webhook event.
 * @param {string|number} requesterId - Zendesk customer requester ID.
 * @returns {string|null} The normalized speaker, or null for unsupported events.
 */
function speakerFor(event, requesterId) {
  const author = event.author || {};
  const authorType = String(author.type || '').toLowerCase();
  const authorSubtypes = author.subtypes || [];
  const sourceType = String(event.source?.type || '').toLowerCase();
  const isBotAuthor =
    authorType === 'bot' ||
    authorSubtypes.some(value => BOT_AUTHOR_SUBTYPES.includes(String(value).toLowerCase())) ||
    sourceType.includes('bot');

  if (isBotAuthor) {
    return 'Bot';
  }

  // Our Sunshine client posts replies as author.type="business".
  if (authorType === 'business') {
    return 'Bot';
  }

  const isSunshineSystemMessage =
    authorType === 'system' &&
    process.env.SUNSHINE_INTEGRATION_ID &&
    String(event.source?.integration_id) === process.env.SUNSHINE_INTEGRATION_ID;
  // Zendesk's conversation log records messages sent through the Conversations
  // API as system authors and does not always include the integration ID.
  const isConversationsApiMessage = authorType === 'system' && sourceType === 'api:conversations';
  if (isSunshineSystemMessage || isConversationsApiMessage) {
    return 'Bot';
  }

  if (CUSTOMER_AUTHOR_TYPES.includes(authorType)) {
    return 'Customer';
  }

  if (authorType === 'agent') {
    return 'Agent';
  }

  const supportId = author['zen:support:user_id'] ?? author.zen?.support?.user_id ?? author.user_id;
  if (supportId != null && String(supportId) === String(requesterId)) {
    return 'Customer';
  }

  return null;
}

/**
 * Detect a recent repeated message from the same speaker.
 * @param {Array<Object>} messages - Previously normalized messages.
 * @param {Object} message - Message to compare by speaker, text, and timestamp.
 * @param {number} index - Position limiting the lookback to earlier messages.
 * @returns {boolean} Whether a matching message falls within the duplicate window.
 */
function isDuplicateMessage(messages, message, index) {
  const earlierMessages = messages.slice(Math.max(0, index - DUPLICATE_MESSAGE_LOOKBACK), index);

  return earlierMessages.some(
    previous =>
      previous.speaker === message.speaker &&
      previous.text === message.text &&
      Math.abs(previous.at - message.at) <= DUPLICATE_MESSAGE_WINDOW_MS
  );
}

/**
 * Filter, deduplicate, and order readable conversation events for session detection.
 * @param {Array<Object>} events - Conversation or webhook events.
 * @param {string|number} requesterId - Zendesk customer requester ID.
 * @returns {Array<Object>} Normalized timestamped messages with their existing speaker labels.
 */
export function normalizeConversationEvents(events, requesterId) {
  const seenIds = new Set();
  const messages = [];

  for (const event of events || []) {
    if (!CONVERSATION_EVENT_TYPES.includes(event.type)) {
      continue;
    }

    if (event.metadata?.public === false || event.metadata?.is_public === false) {
      continue;
    }

    const at = Date.parse(event.created_at || event.received_at);
    const speaker = speakerFor(event, requesterId);
    const text = messageText(event);

    if (!Number.isFinite(at) || !speaker || !text) {
      continue;
    }

    const isAutomatedNotification = /^(conversation with web user|this is an automated|ticket #\d+|notification)$/i.test(text);
    if (isAutomatedNotification) {
      continue;
    }

    const id = String(event.reference || event.id || `${at}:${speaker}:${text}`);
    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    messages.push({ id, at, speaker, text });
  }

  messages.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  // A ticket Comment can mirror a Messaging event. Keep just the first copy.
  return messages.filter((message, index) => !isDuplicateMessage(messages, message, index));
}

/**
 * Group customer-led messages by the existing idle gap while retaining their bot or agent replies.
 * @param {Array<Object>} messages - Normalized conversation messages.
 * @param {number} idleMs - Idle gap defining a new session.
 * @returns {Array<Object>} Detected sessions with their timeline and message metadata.
 */
export function detectMonitoringSessions(messages, idleMs) {
  if (!Number.isFinite(idleMs) || idleMs <= 0) {
    throw new Error('Invalid monitoring idle period');
  }

  const sessions = [];
  let currentMessages = [];
  let lastCustomerAt = null;

  const finishCurrentSession = () => {
    const firstCustomerIndex = currentMessages.findIndex(message => message.speaker === 'Customer');
    if (firstCustomerIndex < 0) {
      return;
    }

    const sessionMessages = currentMessages.slice(firstCustomerIndex);
    const customerMessages = sessionMessages.filter(message => message.speaker === 'Customer');

    sessions.push({
      number: sessions.length + 1,
      startedAt: sessionMessages[0].at,
      lastMessageAt: sessionMessages.at(-1).at,
      lastCustomerAt: customerMessages.at(-1).at,
      firstMessageId: sessionMessages[0].id,
      messages: sessionMessages
    });
  };

  for (const message of messages) {
    // A new customer message after the idle window starts another assessment,
    // even if the bot posted a message between those customer messages.
    const startsNewSession = message.speaker === 'Customer' && lastCustomerAt !== null && message.at - lastCustomerAt >= idleMs;

    if (startsNewSession) {
      finishCurrentSession();
      currentMessages = [];
    }

    currentMessages.push(message);
    if (message.speaker === 'Customer') {
      lastCustomerAt = message.at;
    }
  }

  if (currentMessages.length) {
    finishCurrentSession();
  }

  return sessions;
}

export function monitoringSessionId(ticketId, session) {
  // Stable across repeated polls; a ticket can have multiple monitoring sessions.
  return `ai-monitor:v2:${ticketId}:${session.firstMessageId}`.slice(0, 255);
}

/**
 * Detect a human handoff using the session events and existing ticket-tag rules.
 * @param {Object} session - The target detected session.
 * @param {Array<string>} ticketTags - Existing tags on the ticket.
 * @returns {boolean} Whether automated scoring should be skipped for this session.
 */
export function isEscalatedMonitoringSession(session, ticketTags = []) {
  return session.messages.some(message => {
    if (message.speaker === 'Agent') {
      return true;
    }

    if (!ticketTags.includes('escalated_to_agent')) {
      return false;
    }

    const botAnnouncedHandoff =
      message.speaker === 'Bot' &&
      (/connecting you to a human agent/i.test(message.text) || /our team will connect with you/i.test(message.text));

    return botAnnouncedHandoff;
  });
}
