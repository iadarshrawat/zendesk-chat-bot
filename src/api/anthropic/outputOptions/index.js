// One static, non-customer-specific schema: no per-question grammar compilation
// or private values in schema enums. Membership still gets checked locally.
const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['answered', 'clarify', 'insufficient', 'out_of_scope', 'conversation']
    },
    reply: { type: 'string' },
    sourceLabels: {
      type: 'array',
      items: {
        type: 'string',
        pattern: '^((PRODUCT|SOURCE) [1-9][0-9]*|CATALOG SUMMARY)$'
      }
    },
    pendingQuestion: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  },
  required: ['status', 'reply', 'sourceLabels', 'pendingQuestion']
};

/**
 * Choose supported effort and structured-output options for the configured model.
 * @param {string} model - Configured Claude model name.
 * @param {Object} options - Options: effort, structured.
 * @returns {Object} Provider output options, or an empty object for unsupported models.
 */
export function claudeOutputOptions(model, { effort = 'medium', structured = false } = {}) {
  const outputConfig = {};
  const supportsEffort = /^(claude-sonnet-(5|4-6)|claude-opus-(5|4-5|4-6|4-7|4-8)|claude-(fable|mythos)-5)(-|$)/.test(model || '');
  const supportsStructuredOutput = supportsEffort || /^claude-(sonnet|haiku)-4-5(-|$)/.test(model || '');

  if (supportsEffort && ['low', 'medium', 'high'].includes(effort)) {
    outputConfig.effort = effort;
  }
  if (structured && supportsStructuredOutput) {
    outputConfig.format = { type: 'json_schema', schema: ANSWER_SCHEMA };
  }

  return Object.keys(outputConfig).length ? { output_config: outputConfig } : {};
}
