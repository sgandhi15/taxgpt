import { ChromaClient } from 'chromadb';

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
const COLLECTION_NAME = 'financial_data';

export interface SearchResult {
  id: string;
  content: string;
  source: string;
  score: number;
}

export async function queryVectorStore(
  query: string,
  topK = 5,
): Promise<SearchResult[]> {
  const client = new ChromaClient({ path: CHROMA_URL });
  const collection = await client.getOrCreateCollection({
    name: COLLECTION_NAME,
  });

  const results = await collection.query({
    queryTexts: [query],
    nResults: topK,
  });

  return (
    results.documents[0]?.map((content, i) => ({
      id: results.ids[0][i],
      content: content ?? '',
      source: (results.metadatas[0]?.[i]?.source as string) ?? 'unknown',
      score: results.distances?.[0]?.[i] ?? 1,
    })) ?? []
  );
}
