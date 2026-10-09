export const CLAUDE_CONFIG = {
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.CLAUDE_MODEL?.trim() || 'claude-sonnet-5',
  plannerModel: process.env.CLAUDE_PLANNER_MODEL?.trim() || 'claude-haiku-4-5-20251001',
  classifierModel: process.env.CLAUDE_CLASSIFIER_MODEL?.trim() || 'claude-haiku-4-5-20251001'
};
