import axios from "axios";

export const CLAUDE_CONFIG = {
  apiKey: process.env.ANTHROPIC_API_KEY || "",
  model: process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-5",
  plannerModel: process.env.CLAUDE_PLANNER_MODEL?.trim() || "claude-haiku-4-5-20251001",
  classifierModel: process.env.CLAUDE_CLASSIFIER_MODEL?.trim() || "claude-haiku-4-5-20251001",
};

export function createClaudeClient() {
  if (!CLAUDE_CONFIG.apiKey) throw new Error("ANTHROPIC_API_KEY is missing");

  return axios.create({
    baseURL: "https://api.anthropic.com/v1",
    timeout: 45_000,
    headers: {
      "x-api-key": CLAUDE_CONFIG.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
  });
}
