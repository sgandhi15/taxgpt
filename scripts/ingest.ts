// Builds the search index: downloads the Income Tax Act and the CRA pages, splits
// them into chunks, embeds each chunk with Workers AI and stores it in Vectorize.
//
//   npm run ingest:dry        parse and chunk only; prints counts, calls nothing on Cloudflare
//   npm run ingest            the full run (needs `wrangler login` and `npm run setup` first)
//   npm run ingest -- --refresh   re-download the sources instead of using .ingest/
//   npm run ingest -- --start=N   resume a run that stopped after N chunks
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, INDEX_NAME, type ChunkMetadata } from '../src/shared.js';
import { type Chunk, countWords } from './lib/chunk.js';
import { extractLinks, parseCraPage } from './lib/cra.js';
import { ITA_XML_URL, parseIta } from './lib/ita.js';
import { CRA_INDEXES, CRA_PAGES } from './sources.js';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const REFRESH = args.has('--refresh');
const ALLOW_PAID = args.has('--allow-over-free-plan');
const START = Number([...args].find((a) => a.startsWith('--start='))?.split('=')[1] ?? 0);

const CACHE_DIR = '.ingest';
const MAX_WORDS = 450; // per chunk, excluding the short header
const EMBED_BATCH = 50;
// Vectorize's free plan stores 5 million vector dimensions.
const FREE_PLAN_VECTORS = Math.floor(5_000_000 / EMBEDDING_DIMENSIONS);
// Vectorize rejects metadata over 10 KiB per vector.
const MAX_METADATA_BYTES = 9_500;

interface IngestEnv {
  AI: { run(model: string, input: { text: string[] }): Promise<{ data?: number[][] }> };
  VECTORIZE: {
    describe(): Promise<{ dimensions?: number; vectorCount?: number; vectorsCount?: number }>;
    upsert(vectors: { id: string; values: number[]; metadata: Record<string, string> }[]): Promise<unknown>;
    deleteByIds(ids: string[]): Promise<unknown>;
  };
}

/** Fetches a source, keeping a copy in .ingest/ so later runs don't download it again. */
async function download(url: string): Promise<string> {
  const ext = url.endsWith('.xml') ? 'xml' : 'html';
  const cached = path.join(CACHE_DIR, `${createHash('sha1').update(url).digest('hex').slice(0, 12)}.${ext}`);
  if (!REFRESH && existsSync(cached)) return readFile(cached, 'utf8');
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tax-index-builder)' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const text = await res.text();
  await writeFile(cached, text);
  await new Promise((r) => setTimeout(r, 150)); // be gentle with the source site
  return text;
}

// The embedding model caps the size of a whole request, not just of each text.
const isRequestTooLarge = (err: unknown) => /max context|8007/i.test((err as Error).message ?? '');

async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 4 || isRequestTooLarge(err)) throw err;
      const wait = 2000 * 2 ** (attempt - 1);
      console.warn(`  ${what} failed (${(err as Error).message}); retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Embeds a batch, halving it whenever the request is too large for the model. */
async function embedBatch(AI: IngestEnv['AI'], batch: Chunk[]): Promise<number[][]> {
  try {
    const { data } = await withRetry('embedding', () => AI.run(EMBEDDING_MODEL, { text: batch.map((c) => c.text) }));
    if (!data || data.length !== batch.length || data.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(`Unexpected embedding response for batch starting at ${batch[0].id}`);
    }
    return data;
  } catch (err) {
    if (!isRequestTooLarge(err) || batch.length === 1) throw err;
    const mid = batch.length >> 1;
    return [...(await embedBatch(AI, batch.slice(0, mid))), ...(await embedBatch(AI, batch.slice(mid)))];
  }
}

let stored = 0; // chunks safely in the index, for the resume hint if a run fails

function toMetadata(chunk: Chunk): Record<string, string> {
  const meta: ChunkMetadata = {
    text: chunk.text,
    source: chunk.source,
    title: chunk.title,
    ref: chunk.ref,
    section: chunk.section,
    url: chunk.url,
    asOf: chunk.asOf,
  };
  return { ...meta };
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });

  console.log('Income Tax Act');
  const ita = parseIta(await download(ITA_XML_URL), MAX_WORDS);
  console.log(
    `  current to ${ita.currentTo}, last amended ${ita.lastAmended}: ` +
      `${ita.sections} sections (${ita.repealedSkipped} repealed, skipped) → ${ita.chunks.length} chunks`,
  );

  const chunks: Chunk[] = [...ita.chunks];
  const seenUrls = new Set<string>();
  const addPages = async (urls: string[], verbose: boolean): Promise<number> => {
    let added = 0;
    for (const url of urls) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const page = parseCraPage(await download(url), url, MAX_WORDS);
      if (page.chunks.length === 0) throw new Error(`No text found in ${url}; the page layout may have changed`);
      if (verbose) console.log(`  ${page.title} (modified ${page.asOf || 'unknown'}) → ${page.chunks.length} chunks`);
      chunks.push(...page.chunks);
      added += page.chunks.length;
    }
    return added;
  };

  console.log('CRA pages');
  await addPages(CRA_PAGES, true);
  for (const index of CRA_INDEXES) {
    const links = extractLinks(await download(index.url), index.url, index.follow);
    if (links.length === 0) throw new Error(`No links found on ${index.url}; the page layout may have changed`);
    const before = seenUrls.size;
    const added = await addPages(links, false);
    console.log(`  ${seenUrls.size - before} pages linked from ${index.url.split('/').pop()} → ${added} chunks`);
  }

  const ids = new Set(chunks.map((c) => c.id));
  if (ids.size !== chunks.length) throw new Error('Duplicate chunk ids; two sources produced the same id');
  const tooBig = chunks.filter((c) => Buffer.byteLength(JSON.stringify(toMetadata(c))) > MAX_METADATA_BYTES);
  if (tooBig.length > 0) {
    throw new Error(`${tooBig.length} chunks exceed Vectorize's metadata limit, e.g. ${tooBig[0].id}`);
  }
  const words = chunks.map((c) => countWords(c.text)).sort((a, b) => a - b);
  console.log(
    `Total: ${chunks.length} chunks, ${words.reduce((a, b) => a + b, 0).toLocaleString()} words ` +
      `(median ${words[words.length >> 1]}, largest ${words[words.length - 1]})`,
  );
  console.log(`Free plan holds ${FREE_PLAN_VECTORS} chunks at ${EMBEDDING_DIMENSIONS} dimensions.`);
  await writeFile(path.join(CACHE_DIR, 'chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');

  if (chunks.length > FREE_PLAN_VECTORS && !ALLOW_PAID) {
    throw new Error(
      `${chunks.length} chunks is over the free plan's ${FREE_PLAN_VECTORS}. ` +
        'Remove a source, or pass --allow-over-free-plan if you are on the paid plan.',
    );
  }
  if (DRY_RUN) {
    console.log(`Dry run: wrote ${CACHE_DIR}/chunks.jsonl, nothing sent to Cloudflare.`);
    return;
  }

  const { getPlatformProxy } = await import('wrangler');
  const platform = await getPlatformProxy<IngestEnv>({ configPath: 'wrangler.ingest.jsonc' });
  try {
    const { AI, VECTORIZE } = platform.env;
    const info = await VECTORIZE.describe().catch((err: Error) => {
      throw new Error(`Could not open the "${INDEX_NAME}" index (${err.message}). Run \`npm run setup\` first.`);
    });
    if (info.dimensions && info.dimensions !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Index has ${info.dimensions} dimensions but ${EMBEDDING_MODEL} produces ${EMBEDDING_DIMENSIONS}.`);
    }

    console.log(`Embedding with ${EMBEDDING_MODEL} and storing in "${INDEX_NAME}"…`);
    if (START > 0) console.log(`  resuming after chunk ${START}`);
    stored = START;
    for (let i = START; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await embedBatch(AI, batch);
      await withRetry('upsert', () =>
        VECTORIZE.upsert(batch.map((c, j) => ({ id: c.id, values: vectors[j], metadata: toMetadata(c) }))),
      );
      stored = Math.min(i + EMBED_BATCH, chunks.length);
      if (stored % 500 < EMBED_BATCH || stored === chunks.length) console.log(`  ${stored}/${chunks.length}`);
    }

    // Remove chunks from the previous run that no longer exist (a section got shorter or was repealed).
    const manifestPath = path.join(CACHE_DIR, 'manifest.json');
    if (existsSync(manifestPath)) {
      const previous: string[] = JSON.parse(await readFile(manifestPath, 'utf8')).ids ?? [];
      const stale = previous.filter((id) => !ids.has(id));
      for (let i = 0; i < stale.length; i += 100) {
        await withRetry('delete', () => VECTORIZE.deleteByIds(stale.slice(i, i + 100)));
      }
      if (stale.length > 0) console.log(`  removed ${stale.length} chunks left over from the previous run`);
    }
    await writeFile(manifestPath, JSON.stringify({ itaCurrentTo: ita.currentTo, ids: [...ids] }));
    console.log('Done. Vectorize takes a few seconds to make new vectors searchable.');
  } finally {
    await platform.dispose();
  }
}

main().catch((err) => {
  console.error(`\nIngest failed: ${(err as Error).message}`);
  if (stored > 0) console.error(`Chunks up to ${stored} are stored. Resume with: npm run ingest -- --start=${stored}`);
  process.exit(1);
});
