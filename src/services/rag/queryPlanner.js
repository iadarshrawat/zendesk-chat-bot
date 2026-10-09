import { createAnthropicClient } from '../../api/anthropic/client.js';
import { createClaudeMessage } from '../../api/anthropic/messages.js';
import { CLAUDE_CONFIG } from '../../config/claude.js';
import { RAG_CONFIG } from '../../config/rag.js';
import { parseJsonObject } from '../../common/utils/index.js';
import { buildHeuristicQueryPlan, buildPlannerMessages, normalizeQueryPlan } from '../../common/rag/queryPlan.js';
import { logStage, measureStage, measureSyncStage, logModelUsage } from '../../common/utils/timingLogger.js';
import { runBudgetedIO, getResponseBudget, checkResponseBudget } from '../../common/utils/responseBudget.js';
import { claudeOutputOptions } from '../../api/anthropic/outputOptions.js';

let client;

function plannerTimeoutMs() {
  if (!getResponseBudget()) {
    return RAG_CONFIG.retrieval.plannerTimeoutMs;
  }

  return Math.min(RAG_CONFIG.retrieval.plannerTimeoutMs, RAG_CONFIG.conversation?.plannerStageTimeoutMs ?? 6000);
}

function responseText(response) {
  return response.content
    ?.filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

/**
 * Use the existing model planner when enabled and preserve the conservative heuristic fallback.
 * @param {string} question - Current customer question.
 * @param {Object} options - Brand, history, catalog categories/manufacturers, and retained case state.
 * @returns {Promise<Object>} The normalized query plan and existing planner-source metadata.
 */
export async function createQueryPlan(question, options = {}) {
  const fallback = measureSyncStage('planner.heuristic', () => buildHeuristicQueryPlan(question, options));

  if (!RAG_CONFIG.retrieval.queryPlanningEnabled || !process.env.ANTHROPIC_API_KEY) {
    const reason = !RAG_CONFIG.retrieval.queryPlanningEnabled ? 'disabled' : 'api_key_not_configured';
    logStage('planner.skipped', { reason, plannerSource: 'heuristic' });

    return fallback;
  }

  try {
    client ||= createAnthropicClient();
    const model = CLAUDE_CONFIG.plannerModel || CLAUDE_CONFIG.model;
    const messages = buildPlannerMessages(question, options);
    const timeoutMs = plannerTimeoutMs();
    const response = await measureStage(
      'claude.planner',
      () =>
        runBudgetedIO(
          ({ signal, timeoutMs: requestTimeoutMs }) =>
            createClaudeMessage(
              client,
              {
                model,
                max_tokens: 1600,
                ...(getResponseBudget()
                  ? claudeOutputOptions(model, {
                      effort: RAG_CONFIG.conversation?.plannerEffort ?? 'low'
                    })
                  : {}),
                // Some configured models reject temperature. Omitting it avoids a
                // guaranteed failed request and heuristic fallback on every turn.
                ...messages
              },
              {
                timeoutMs: requestTimeoutMs,
                maxRetries: 0,
                ...(signal ? { signal } : {})
              }
            ),
          timeoutMs,
          'claude.planner'
        ),
      {
        model,
        maxTokens: 1600,
        maxRetries: 0,
        timeoutMs,
        systemChars: messages.system.length,
        remainingMs: getResponseBudget()?.remaining(),
        targetRemainingMs: getResponseBudget()?.targetRemaining()
      }
    );
    logModelUsage('claude.planner_usage', response, { model });

    if (response.stop_reason === 'max_tokens') {
      throw new Error('Query plan was truncated');
    }

    return measureSyncStage('planner.parse', () => ({
      ...normalizeQueryPlan(parseJsonObject(responseText(response)), question),
      plannerSource: 'llm'
    }));
  } catch (error) {
    checkResponseBudget();
    const rateLimited = error?.status === 429;
    logStage('planner.fallback', {
      reason: rateLimited ? 'rate_limited' : 'unavailable_or_invalid',
      timeoutStage: error.timeoutStage,
      plannerSource: 'heuristic'
    });
    console.warn('Query planning failed; using conservative fallback:', error.message);

    return {
      ...fallback,
      plannerError: rateLimited ? 'rate_limited' : 'planner_unavailable_or_invalid'
    };
  }
}
