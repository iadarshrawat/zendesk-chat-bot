import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { CLAUDE_CONFIG } from '../../config/claude.js';

/**
 * Create the SDK client used for replies and query planning.
 * @returns {Anthropic} A client authenticated with the existing environment key.
 */
export function createAnthropicClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/**
 * Create the REST client used by the monitoring evaluator.
 * @returns {Object} An Axios client with the existing headers and timeout.
 */
export function createClaudeClient() {
  if (!CLAUDE_CONFIG.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is missing');
  }

  return axios.create({
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 45_000,
    headers: {
      'x-api-key': CLAUDE_CONFIG.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  });
}
