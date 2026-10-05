import { RAG_CONFIG } from "../../config/rag.js";
import { embedQuery } from "./voyageEmbeddingService.js";
import {
  getCatalogSummary,
  searchKnowledgeChunks,
  searchStructuredProducts,
} from "./knowledgeStoreService.js";
import { createQueryPlan } from "./queryPlanningService.js";
import { createRetrievalPipeline } from "./retrievalPipeline.js";

const knowledgePipeline = createRetrievalPipeline({
  config: RAG_CONFIG.retrieval,
  createQueryPlan,
  embedQuery,
  searchKnowledgeChunks,
  searchStructuredProducts,
  getCatalogSummary,
});

export const retrieveKnowledge = knowledgePipeline.retrieveKnowledge;
export const recoverKnowledge = knowledgePipeline.recoverKnowledge;
