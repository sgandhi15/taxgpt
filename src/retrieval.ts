import { extractSectionRefs } from './sections';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, type ChunkMetadata } from './shared';

export interface Excerpt {
  id: string;
  score: number;
  meta: ChunkMetadata;
}

const GENERAL_TOP_K = 8;
const SECTION_TOP_K = 4;
const MAX_EXCERPTS = 10;
const MAX_SECTION_REFS = 2;

async function embed(env: Env, text: string): Promise<number[]> {
  const result = (await env.AI.run(EMBEDDING_MODEL, { text: [text] })) as { data?: number[][] };
  const vector = result.data?.[0];
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding model returned ${vector?.length ?? 'no'} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
  }
  return vector;
}

function toExcerpt(match: VectorizeMatch): Excerpt | null {
  const m = match.metadata;
  if (!m || typeof m.text !== 'string' || typeof m.url !== 'string') return null;
  return {
    id: match.id,
    score: match.score,
    meta: {
      text: m.text,
      source: m.source === 'cra' ? 'cra' : 'ita',
      title: String(m.title ?? ''),
      ref: String(m.ref ?? ''),
      section: String(m.section ?? ''),
      url: m.url,
      asOf: String(m.asOf ?? ''),
    },
  };
}

/**
 * Returns the excerpts most relevant to a question. When the question names a
 * section, that section's best chunks come first, since meaning-based search
 * alone does not reliably match a bare number.
 */
export async function retrieve(env: Env, question: string): Promise<Excerpt[]> {
  const vector = await embed(env, question);
  const refs = extractSectionRefs(question).slice(0, MAX_SECTION_REFS);

  const [general, ...bySection] = await Promise.all([
    env.VECTORIZE.query(vector, { topK: GENERAL_TOP_K, returnMetadata: 'all' }),
    ...refs.map((section) =>
      env.VECTORIZE.query(vector, { topK: SECTION_TOP_K, returnMetadata: 'all', filter: { section } }),
    ),
  ]);

  const seen = new Set<string>();
  const excerpts: Excerpt[] = [];
  for (const match of [...bySection.flatMap((r) => r.matches), ...general.matches]) {
    if (seen.has(match.id)) continue;
    seen.add(match.id);
    const excerpt = toExcerpt(match);
    if (excerpt) excerpts.push(excerpt);
    if (excerpts.length >= MAX_EXCERPTS) break;
  }
  return excerpts;
}
