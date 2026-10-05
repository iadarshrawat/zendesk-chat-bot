import {
  CosmosClient,
  VectorEmbeddingDataType,
  VectorEmbeddingDistanceFunction,
  VectorIndexType,
} from "@azure/cosmos";
import { RAG_CONFIG, assertRagConfigured } from "./rag.js";
import { logStage, measureStage } from "../shared/timingLogger.js";

let client;
let container;

const VECTOR_INDEX_TYPES = {
  flat: VectorIndexType.Flat,
  quantizedFlat: VectorIndexType.QuantizedFlat,
  diskANN: VectorIndexType.DiskANN,
};

function getClient() {
  assertRagConfigured();
  if (!client) {
    client = new CosmosClient({
      endpoint: RAG_CONFIG.cosmos.endpoint,
      key: RAG_CONFIG.cosmos.key,
    });
  }
  return client;
}

export async function ensureKnowledgeContainer() {
  if (container) {
    logStage("cosmos.container_cache", { outcome: "hit" });
    return container;
  }
  logStage("cosmos.container_cache", { outcome: "miss" });

  const cosmosClient = getClient();
  const { database } = await measureStage(
    "cosmos.ensure_database",
    () => cosmosClient.databases.createIfNotExists({
      id: RAG_CONFIG.cosmos.databaseId,
    }),
  );

  const vectorIndexType = VECTOR_INDEX_TYPES[RAG_CONFIG.cosmos.vectorIndexType];
  if (!vectorIndexType) {
    throw new Error(
      `Unsupported COSMOS_VECTOR_INDEX_TYPE: ${RAG_CONFIG.cosmos.vectorIndexType}`,
    );
  }

  const { container: knowledgeContainer } = await measureStage(
    "cosmos.ensure_container",
    () => database.containers.createIfNotExists({
      id: RAG_CONFIG.cosmos.containerId,
      partitionKey: { paths: ["/brandKey"] },
      vectorEmbeddingPolicy: {
        vectorEmbeddings: [
          {
            path: "/embedding",
            dataType: VectorEmbeddingDataType.Float32,
            distanceFunction: VectorEmbeddingDistanceFunction.Cosine,
            dimensions: RAG_CONFIG.cosmos.vectorDimensions,
          },
        ],
      },
      indexingPolicy: {
        automatic: true,
        indexingMode: "consistent",
        includedPaths: [{ path: "/*" }],
        excludedPaths: [{ path: "/_etag/?" }, { path: "/embedding/*" }],
        vectorIndexes: [
          {
            path: "/embedding",
            type: vectorIndexType,
          },
        ],
      },
    }),
  );

  container = knowledgeContainer;
  return container;
}

export async function verifyKnowledgeStore() {
  const knowledgeContainer = await ensureKnowledgeContainer();
  await measureStage("cosmos.verify_store", () => knowledgeContainer.read());
  return true;
}
