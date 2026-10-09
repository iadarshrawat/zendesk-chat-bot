import { connectDB } from './sql.js';
import { verifyKnowledgeStore } from './cosmos.js';

/**
 * Connect SQL and verify the knowledge store in the original startup order.
 * @returns {Promise<void>} Resolves when both stores are ready; propagates a startup failure.
 */
export async function databaseLoader() {
  await connectDB();
  await verifyKnowledgeStore();
}
