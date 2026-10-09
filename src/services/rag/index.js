import { RAG_CONFIG } from '../../config/rag.js';
import { embedQuery } from '../../api/voyage/embeddings.js';
import { getCatalogSummary, searchKnowledgeChunks, searchStructuredProducts } from '../../models/knowledge/index.js';
import { createQueryPlan } from './queryPlanner.js';
import { createRetrievalPipeline } from './retrievalPipeline.js';

const knowledgePipeline = createRetrievalPipeline({
  config: RAG_CONFIG.retrieval,
  createQueryPlan,
  embedQuery,
  searchKnowledgeChunks,
  searchStructuredProducts,
  getCatalogSummary
});

export const retrieveKnowledge = knowledgePipeline.retrieveKnowledge;
export const recoverKnowledge = knowledgePipeline.recoverKnowledge;
