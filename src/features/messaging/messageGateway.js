import { createSunshineClient } from "../../config/sunshine.js";
import { RAG_CONFIG } from "../../config/rag.js";
import {
  checkResponseBudget,
  getResponseBudget,
  runBudgetedIO,
  runWithDeadline,
} from "../../shared/responseBudget.js";
import { startStage } from "../../shared/timingLogger.js";
import { getSupportBrandByWidgetId } from "../../config/brands.js";
import { customerMessages } from "./customerMessages.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const IGNORED_HISTORY_MESSAGE = "What would you like to know next?";

function requestOptions(signal, timeoutMs) {
  return signal ? [{ signal, timeout: timeoutMs }] : [];
}

function buildTextMessage(message) {
  const text = typeof message === "string" ? message : message.text;
  const quickReplies = typeof message === "object" ? message.quickReplies : null;
  const hasQuickReplies = quickReplies && quickReplies.length > 0;
  const actions = hasQuickReplies
    ? quickReplies.map((quickReply) => ({
      type: "reply",
      text: quickReply,
      payload: quickReply.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    }))
    : null;

  return {
    author: { type: "business" },
    content: {
      type: "text",
      markdownText: text,
      ...(hasQuickReplies && { actions }),
    },
  };
}

/** Send a text message, with optional quick replies, to a conversation. */
export async function sendSunshineMessage(conversationId, message, options = {}) {
  const span = startStage("sunshine.message_send", {
    conversationId,
    replyChars: typeof message === "string" ? message.length : message?.text?.length || 0,
    timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });

  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error("SUNSHINE_APP_ID not configured in .env");
    }

    const sunshineClient = createSunshineClient();
    const payload = buildTextMessage(message);
    const path = `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`;

    const response = await runWithDeadline(
      ({ signal, timeoutMs }) => sunshineClient.post(
        path,
        payload,
        ...requestOptions(signal, timeoutMs),
      ),
      options,
    );

    span.end({ httpStatus: response.status });
    return response.data;
  } catch (error) {
    span.fail(error);
    // A POST without a definitive response may already have been delivered.
    // The inbox must quarantine it instead of automatically posting twice.
    error.deliveryUncertain = !error.response || error.response.status >= 500;
    console.error("Failed to send Sunshine message", {
      status: error.response?.status,
      message: error.message,
    });
    throw error;
  }
}

export async function sendWelcomeMessage(event) {
  const conversationId = event.payload?.conversation?.id;
  const brand = getSupportBrandByWidgetId(event.payload?.conversation?.brandId);

  return sendSunshineMessage(conversationId, customerMessages.welcome(brand.displayName));
}

export async function sendSunshineForm(conversationId, fields, options = {}) {
  const client = createSunshineClient();

  try {
    const response = await client.post(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`,
      {
        author: { type: "business" },
        content: {
          type: "form",
          text: customerMessages.formPrompt,
          fields,
        },
      },
      { timeout: options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS },
    );

    return response.data;
  } catch (error) {
    error.deliveryUncertain = !error.response || error.response.status >= 500;
    throw error;
  }
}

/** Send a start/stop typing activity. Boolean states are accepted for compatibility. */
export async function sendTypingIndicator(
  conversationId,
  state = "start",
  _userId = null,
  options = {},
) {
  const isStarting = state === true || state === "start";
  const span = startStage(
    isStarting ? "sunshine.typing_start" : "sunshine.typing_stop",
    { conversationId, timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
  );

  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error("SUNSHINE_APP_ID not configured in .env");
    }

    const sunshineClient = createSunshineClient();
    const activityType = isStarting ? "typing:start" : "typing:stop";
    const path = `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/activity`;
    const payload = {
      author: { type: "business" },
      type: activityType,
    };

    const response = await runWithDeadline(
      ({ signal, timeoutMs }) => sunshineClient.post(
        path,
        payload,
        ...requestOptions(signal, timeoutMs),
      ),
      options,
    );

    span.end({ httpStatus: response.status });
    return response.data;
  } catch (error) {
    span.fail(error);
    console.warn("Failed to send typing indicator:", error.response?.status, error.message);
    return null;
  }
}

/** Get the recent conversation text that is safe to use as model context. */
export async function getConversationHistory(conversationId, { beforeMessageId = null } = {}) {
  const span = startStage("sunshine.history", {
    conversationId,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  });

  try {
    const client = createSunshineClient();
    const timeoutMs = getResponseBudget()
      ? RAG_CONFIG.conversation?.historyTimeoutMs ?? 1500
      : DEFAULT_REQUEST_TIMEOUT_MS;
    const response = await runBudgetedIO(
      ({ signal, timeoutMs: boundedTimeoutMs }) => client.get(
        `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`,
        ...requestOptions(signal, boundedTimeoutMs),
      ),
      timeoutMs,
    );

    let messages = Array.isArray(response.data.messages) ? response.data.messages : [];
    const currentIndex = beforeMessageId
      ? messages.findIndex((message) => message.id === beforeMessageId)
      : -1;

    if (beforeMessageId && currentIndex < 0) {
      // Old queued messages may be outside the API's most recent page. Saved
      // case state is safer than mixing later messages into this earlier turn.
      console.warn(
        "Current message absent from history page; using saved case state",
        beforeMessageId,
      );
      span.end({ outcome: "current_message_not_in_page", historyChars: 0 });
      return "";
    }

    if (currentIndex >= 0) {
      messages = messages.slice(0, currentIndex);
    }

    const history = messages
      .filter((message) => {
        const text = message.content?.text || message.content?.markdownText;
        if (typeof text !== "string" || !text.trim()) {
          return false;
        }

        return !(
          message.author?.type === "business"
          && text === IGNORED_HISTORY_MESSAGE
        );
      })
      .slice(-RAG_CONFIG.conversation.historyMessages)
      .map((message) => {
        const role = message.author?.type === "business" ? "Bot" : "User";
        return `${role}: ${message.content.text || message.content.markdownText}`;
      })
      .join("\n")
      .slice(-16_000);

    span.end({ httpStatus: response.status, historyChars: history.length });
    return history;
  } catch (error) {
    span.fail(error);
    checkResponseBudget();
    console.error("History fetch failed:", error.message);
    return "";
  }
}
