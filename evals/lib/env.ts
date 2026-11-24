// Paths, settings read from the project's own files, prices, and small helpers.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChunkMetadata } from '../../src/shared';

export const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.resolve(EVALS_DIR, '..');
export const RESULTS_DIR = path.join(EVALS_DIR, 'results');
export const EVAL_URL = process.env.EVAL_URL ?? 'http://localhost:8799';

// A stronger model than the one under test grades correctness, declines and
// injection, where the inputs are short. Faithfulness sends all the excerpts
// (about 8,000 tokens a question), so the cheap model reads every answer first
// and the stronger model re-reads only the ones it faults (see judgeFaithfulness).
// `npm run eval:judges` checks both against answers with known verdicts.
// Set both to the same model to have it judge everything.
export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'claude-sonnet-5-5';
export const FAITHFULNESS_JUDGE_MODEL = process.env.FAITHFULNESS_JUDGE_MODEL ?? 'claude-haiku-5-5';

/** US dollars per million tokens (input, output). Update when prices change. */
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};

export function cost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (!price) throw new Error(`No price for ${model}: add it to PRICES in evals/lib/env.ts`);
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}

/** Reads the key in code only. It is never printed or written to results. */
export function anthropicKey(): string {
  const file = path.join(REPO_DIR, '.dev.vars');
  const match = existsSync(file) ? /^ANTHROPIC_API_KEY=(.*)$/m.exec(readFileSync(file, 'utf8')) : null;
  const key = match?.[1].trim().replace(/^["']|["']$/g, '') ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not found in .dev.vars or the environment');
  return key;
}

/** The model and effort the deployed Worker uses, from the main wrangler.jsonc. */
export function appSettings(): { model: string; effort: string } {
  const config = readFileSync(path.join(REPO_DIR, 'wrangler.jsonc'), 'utf8');
  const read = (name: string) => {
    const value = new RegExp(`"${name}":\\s*"([^"]+)"`).exec(config)?.[1];
    if (!value) throw new Error(`${name} not found in wrangler.jsonc`);
    return value;
  };
  return { model: read('CLAUDE_MODEL'), effort: read('CLAUDE_EFFORT') };
}

export type Chunk = ChunkMetadata & { id: string };

/** Every ingested chunk, by id. This is the ground truth the datasets cite. */
export function loadChunks(): Map<string, Chunk> {
  const file = path.join(REPO_DIR, '.ingest', 'chunks.jsonl');
  if (!existsSync(file)) throw new Error('.ingest/chunks.jsonl is missing: run `npm run ingest:dry` to rebuild it');
  const chunks = new Map<string, Chunk>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const chunk = JSON.parse(line) as Chunk;
    chunks.set(chunk.id, chunk);
  }
  return chunks;
}

export function loadDataset<T>(name: string): T[] {
  return JSON.parse(readFileSync(path.join(EVALS_DIR, 'datasets', name), 'utf8')) as T[];
}

/** Runs `task` over `items`, at most `limit` at a time, keeping the order. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await task(items[i], i);
      }
    }),
  );
  return results;
}
