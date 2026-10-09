import { RAG_CONFIG } from '../../../config/rag/index.js';
import { embedQuery } from '../../../api/voyage/embeddings/index.js';
import { getCatalogSummary, searchKnowledgeChunks, searchStructuredProducts } from '../../../models/knowledge/store/index.js';
import { createQueryPlan } from '../queryPlanner/index.js';
import { createRetrievalPipeline } from '../retrievalPipeline/index.js';

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
