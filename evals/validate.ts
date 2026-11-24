// Dataset types, and a check that the datasets still match the ingested corpus:
// every chunk id exists, and every expected figure is written in one of the
// chunks the question cites. Expected answers come from the chunks, never from
// memory, and this is what keeps it that way after a re-ingest.
//
//   npm run eval:validate      (no network, no cost)
import { pathToFileURL } from 'node:url';
import { hasFact } from './lib/checks';
import { loadChunks, loadDataset, type Chunk } from './lib/env';

export interface Question {
  id: string;
  category: 'rates' | 'limits' | 'credits' | 'ita' | 'howto' | 'multi' | 'phrasing';
  question: string;
  /** Short correct answer, written from the gold chunks. */
  reference: string;
  /** Figures the answer must contain. Each is a list of accepted spellings. */
  must_include: string[][];
  /** Evidence groups: each is a list of chunk ids, any one of which holds that part of the answer. */
  gold: string[][];
  note?: string;
}

export interface DeclineCase {
  id: string;
  kind: 'out_of_scope' | 'not_in_data' | 'false_premise';
  question: string;
  /** What a good answer does, for the judge. */
  expected: string;
  /** Regular expressions that must not match the answer. */
  forbid: string[];
  must_include: string[][];
  /** Chunks that hold the true fact, for false premises. */
  truth: string[];
}

export interface DirectAttack {
  id: string;
  kind: string;
  goal: string;
  prompt: string;
  /** The pass rule, for the judge. */
  rule: string;
  forbid: string[];
  must_include: string[][];
  max_chars?: number;
}

export interface IndirectAttack {
  id: string;
  goal: string;
  question: string;
  excerpts: { id?: string; append?: string; insert_middle?: string; forged?: { title: string; text: string } }[];
  rule: string;
  forbid: string[];
  must_include: string[][];
  /** Patterns reported as a warning rather than a fail. */
  warn: string[];
}

export interface CalibrationCase {
  id: string;
  judge: 'correctness' | 'faithfulness' | 'decline' | 'injection';
  question: string;
  answer: string;
  /** The verdict fields a sound judge must return. */
  expect: Record<string, boolean>;
  reference?: string;
  chunks?: string[];
  kind?: string;
  expected?: string;
  goal?: string;
  rule?: string;
}

export function validateDatasets(chunks: Map<string, Chunk>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const checkId = (id: string) => {
    if (seen.has(id)) problems.push(`${id}: duplicate id`);
    seen.add(id);
  };
  const checkChunks = (id: string, ids: string[]) => {
    for (const chunk of ids) if (!chunks.has(chunk)) problems.push(`${id}: chunk ${chunk} is not in chunks.jsonl`);
  };
  const checkFacts = (id: string, facts: string[][], ids: string[]) => {
    const text = ids.map((chunk) => chunks.get(chunk)?.text ?? '').join('\n');
    for (const spellings of facts) {
      if (!spellings.some((s) => hasFact(text, s))) problems.push(`${id}: "${spellings[0]}" is not in its chunks (${ids.join(', ')})`);
    }
  };

  for (const q of loadDataset<Question>('questions.json')) {
    checkId(q.id);
    const ids = q.gold.flat();
    checkChunks(q.id, ids);
    if (ids.length) checkFacts(q.id, q.must_include, ids);
    else if (q.must_include.length) problems.push(`${q.id}: has required figures but no gold chunks`);
    // A chunk listed as an alternative must really hold the answer: all the
    // figures when there is one evidence group, at least one of them otherwise.
    for (const chunk of q.must_include.length ? ids : []) {
      const text = chunks.get(chunk)?.text ?? '';
      const found = q.must_include.filter((spellings) => spellings.some((s) => hasFact(text, s))).length;
      if (q.gold.length === 1 ? found < q.must_include.length : found === 0) problems.push(`${q.id}: chunk ${chunk} does not hold the expected figures`);
    }
  }
  for (const c of loadDataset<DeclineCase>('decline.json')) {
    checkId(c.id);
    checkChunks(c.id, c.truth);
    if (c.must_include.length) checkFacts(c.id, c.must_include, c.truth);
    for (const pattern of c.forbid) new RegExp(pattern);
  }
  for (const a of loadDataset<DirectAttack>('injection-direct.json')) {
    checkId(a.id);
    for (const pattern of a.forbid) new RegExp(pattern);
  }
  for (const a of loadDataset<IndirectAttack>('injection-indirect.json')) {
    checkId(a.id);
    checkChunks(a.id, a.excerpts.flatMap((e) => (e.id ? [e.id] : [])));
    for (const pattern of [...a.forbid, ...a.warn]) new RegExp(pattern);
  }
  for (const c of loadDataset<CalibrationCase>('judge-calibration.json')) {
    checkId(c.id);
    checkChunks(c.id, c.chunks ?? []);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = validateDatasets(loadChunks());
  console.log(problems.length ? problems.join('\n') : 'Datasets match .ingest/chunks.jsonl.');
  process.exit(problems.length ? 1 : 0);
}
