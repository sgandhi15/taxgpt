import { ChromaClient } from 'chromadb';
import type { Chunk } from './chunker.js';

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
const COLLECTION_NAME = 'financial_data';
const BATCH_SIZE = 100;

export async function pushToVectorStore(chunks: Chunk[]): Promise<void> {
  if (chunks.length === 0) return;

  const client = new ChromaClient({ path: CHROMA_URL });
  const collection = await client.getOrCreateCollection({
    name: COLLECTION_NAME,
  });

  const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    await collection.add({
      ids: batch.map((c) => c.id),
      documents: batch.map((c) => c.content),
      metadatas: batch.map((c) => ({ source: c.source })),
    });

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`  Added batch ${batchNum}/${totalBatches}`);
  }
}

export async function checkIfIngested(): Promise<boolean> {
  try {
    const client = new ChromaClient({ path: CHROMA_URL });
    const collection = await client.getOrCreateCollection({
      name: COLLECTION_NAME,
    });
    return (await collection.count()) > 0;
  } catch {
    return false;
  }
}
