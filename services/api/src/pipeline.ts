import { generateText } from 'ai';
import { groq } from '@ai-sdk/groq';
import { queryVectorStore, type SearchResult } from './retrieval/vector.js';
import { queryGraphStore, type GraphResult } from './retrieval/graph.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const PRIMARY_MODEL = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';

const SYSTEM_PROMPT = `You are a financial data assistant specializing in tax information analysis.
You answer questions based ONLY on the provided context data. Follow these rules strictly:

1. Use EXACT numbers from the context. Never approximate, round, or fabricate figures.
2. When calculating totals, averages, or comparisons, show your work clearly.
3. If the context doesn't contain enough information, say "I don't have enough data to answer that accurately" rather than guessing.
4. Reference which data source your answer comes from (tax records CSV, PDF documents, or presentations).
5. Keep answers concise and directly address the question asked.

The data includes:
- Tax records with taxpayer types (Individual, Corporation, Partnership, Trust, Non-Profit), US states, income sources, deduction types, and tax amounts
- IRS Form 1040 instructions
- US Tax Code Title 26 excerpts
- Financial presentations`;

function isRateLimitError(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string };
  const msg = String(e?.message ?? err).toLowerCase();
  return (
    e?.statusCode === 429 ||
    msg.includes('rate_limit') ||
    msg.includes('rate limit') ||
    msg.includes('429')
  );
}

async function callLLM(
  modelId: string,
  context: string,
  userQuery: string,
): Promise<string> {
  const { text } = await generateText({
    model: groq(modelId),
    maxRetries: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Context:\n${context}\n\nQuestion: ${userQuery}`,
      },
    ],
  });
  return text;
}

export async function processChat(userQuery: string): Promise<string> {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured');
  }

  let vectorResults: SearchResult[] = [];
  let graphResults: GraphResult = { relationships: [] };

  const [vecRes, graphRes] = await Promise.allSettled([
    queryVectorStore(userQuery, 5),
    queryGraphStore(userQuery),
  ]);

  if (vecRes.status === 'fulfilled') vectorResults = vecRes.value;
  else console.error('Vector search failed:', vecRes.reason);

  if (graphRes.status === 'fulfilled') graphResults = graphRes.value;
  else console.error('Graph search failed:', graphRes.reason);

  const context = buildContext(vectorResults, graphResults);

  // Try primary model with retries, then fall back to smaller model
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callLLM(PRIMARY_MODEL, context, userQuery);
    } catch (err: unknown) {
      if (isRateLimitError(err) && attempt < 2) {
        console.log(`Primary model rate-limited, waiting 10s before retry...`);
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      if (isRateLimitError(err)) {
        console.log(`Primary model rate-limited, falling back to ${FALLBACK_MODEL}`);
        break;
      }
      throw err;
    }
  }

  // Fallback model has 5x higher TPD but lower TPM — trim context to fit
  const trimmedContext = context.length > 16000 ? context.slice(0, 16000) + '\n...(context trimmed)' : context;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callLLM(FALLBACK_MODEL, trimmedContext, userQuery);
    } catch (err: unknown) {
      if (isRateLimitError(err) && attempt < 2) {
        console.log(`Fallback model rate-limited, waiting 10s before retry...`);
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      throw err;
    }
  }

  throw new Error('All models rate-limited. Please try again later.');
}

function buildContext(
  vectorResults: SearchResult[],
  graphResults: GraphResult,
): string {
  const sections: string[] = [];

  if (graphResults.relationships.length > 0) {
    sections.push('## Structured Data (Knowledge Graph):');
    graphResults.relationships.forEach((r) => sections.push(`- ${r}`));
  }

  if (vectorResults.length > 0) {
    sections.push('\n## Relevant Documents (Semantic Search):');
    vectorResults.forEach((r, i) => {
      sections.push(`${i + 1}. [Source: ${r.source}] ${r.content}`);
    });
  }

  if (sections.length === 0) {
    sections.push('No relevant context found for this query.');
  }

  return sections.join('\n');
}
