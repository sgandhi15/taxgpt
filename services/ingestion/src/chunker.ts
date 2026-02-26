export interface Chunk {
  id: string;
  content: string;
  source: string;
}

export function chunkText(
  text: string,
  source: string,
  options: { chunkSize?: number; overlap?: number } = {},
): Chunk[] {
  const { chunkSize = 500, overlap = 50 } = options;

  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  let idx = 0;

  while (start < tokens.length) {
    const end = Math.min(start + chunkSize, tokens.length);
    chunks.push({
      id: `${source}-chunk-${idx}`,
      content: tokens.slice(start, end).join(' '),
      source,
    });

    start += chunkSize - overlap;
    idx++;
    if (start >= tokens.length) break;
  }

  return chunks;
}
