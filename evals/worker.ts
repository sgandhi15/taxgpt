// Eval-only Worker. It is never deployed: `evals/wrangler.jsonc` has no route and
// no workers.dev address, the main `wrangler.jsonc` does not reference this file,
// and every request must come from localhost.
//
// It runs the app's own `retrieve` and `streamAnswer` (src/), without the rate
// limiter, the daily counter or the bot check, and reports what /chat does not:
// the ids and text of the excerpts the model received, and the token usage.
import { AsyncLocalStorage } from 'node:async_hooks';
import { streamAnswer } from '../src/chat';
import type { Source } from '../src/prompt';
import { retrieve, type Excerpt } from '../src/retrieval';
import { EMBEDDING_DIMENSIONS, type ChunkMetadata } from '../src/shared';

interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

interface AnswerRequest {
  question?: unknown;
  /** Sent by evals/run.ts, which reads the key, model and effort from the project's own files. */
  apiKey?: unknown;
  model?: unknown;
  effort?: unknown;
  /** Planted excerpts, for indirect-injection cases. Skips retrieval. */
  excerpts?: { id: string; meta: ChunkMetadata }[];
}

// ---- Token usage ---------------------------------------------------------------
// streamAnswer does not report usage, so the Anthropic response is read a second
// time here as it streams past. AsyncLocalStorage keeps concurrent requests apart.
const usageScope = new AsyncLocalStorage<{ usage?: Promise<Usage | null> }>();
const realFetch = globalThis.fetch.bind(globalThis);

async function readUsage(body: ReadableStream<Uint8Array>): Promise<Usage | null> {
  const text = await new Response(body).text();
  const usage: Usage = { model: '', input_tokens: 0, output_tokens: 0 };
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let event: { type?: string; message?: { model?: string; usage?: Record<string, number> }; usage?: Record<string, number> };
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (event.type === 'message_start' && event.message) {
      const u = event.message.usage ?? {};
      usage.model = event.message.model ?? '';
      usage.input_tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      usage.output_tokens = u.output_tokens ?? 0;
    }
    if (event.type === 'message_delta' && event.usage?.output_tokens != null) usage.output_tokens = event.usage.output_tokens;
  }
  return usage.model ? usage : null;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await realFetch(input, init);
  const scope = usageScope.getStore();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!scope || !res.body || !url.startsWith('https://api.anthropic.com/')) return res;
  const [forCaller, forUsage] = res.body.tee();
  scope.usage = readUsage(forUsage).catch(() => null);
  return new Response(forCaller, res);
}) as typeof fetch;

// ---- Environments handed to the app's code -------------------------------------

/** Repeats of the same embedding or index query return the first result, so a
 *  `retrieve` call here and the one inside `streamAnswer` see identical excerpts. */
function memoised(env: Env): Env {
  const cache = new Map<string, Promise<unknown>>();
  const once = (key: string, run: () => Promise<unknown>) => {
    if (!cache.has(key)) cache.set(key, run());
    return cache.get(key)!;
  };
  return {
    ...env,
    AI: { run: (model: string, input: unknown) => once(`ai:${model}:${JSON.stringify(input)}`, () => env.AI.run(model as never, input as never)) } as unknown as Env['AI'],
    VECTORIZE: {
      query: (vector: number[], options: unknown) => once(`vec:${JSON.stringify(options)}`, () => env.VECTORIZE.query(vector, options as never)),
    } as unknown as Env['VECTORIZE'],
  };
}

/** Makes retrieval return the given excerpts, whatever the question. */
function planted(env: Env, excerpts: { id: string; meta: ChunkMetadata }[]): Env {
  const matches = excerpts.map((e) => ({ id: e.id, score: 0.8, metadata: e.meta }));
  return {
    ...env,
    AI: { run: async () => ({ data: [new Array(EMBEDDING_DIMENSIONS).fill(0)] }) } as unknown as Env['AI'],
    VECTORIZE: { query: async () => ({ matches, count: matches.length }) } as unknown as Env['VECTORIZE'],
  };
}

// ---- Routes --------------------------------------------------------------------

async function answer(env: Env, body: AnswerRequest): Promise<Response> {
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) return Response.json({ error: 'question is required' }, { status: 400 });

  const runEnv: Env = {
    ...(body.excerpts ? planted(env, body.excerpts) : memoised(env)),
    ...(typeof body.apiKey === 'string' ? { ANTHROPIC_API_KEY: body.apiKey } : {}),
    ...(typeof body.model === 'string' ? { CLAUDE_MODEL: body.model as Env['CLAUDE_MODEL'] } : {}),
    ...(typeof body.effort === 'string' ? { CLAUDE_EFFORT: body.effort as Env['CLAUDE_EFFORT'] } : {}),
  };

  const excerpts: Excerpt[] = await retrieve(runEnv, question);
  let sources: Source[] = [];
  let text = '';
  let truncated: boolean | null = null;
  let error: string | null = null;
  const scope: { usage?: Promise<Usage | null> } = {};

  await usageScope.run(scope, () =>
    streamAnswer(
      runEnv,
      question,
      async (event) => {
        if (event.type === 'sources') sources = event.sources;
        else if (event.type === 'delta') text += event.text;
        else if (event.type === 'done') truncated = event.truncated;
        else if (event.type === 'error') error = event.message;
      },
      new AbortController().signal,
    ),
  );

  return Response.json({ excerpts, sources, answer: text, truncated, error, usage: (await scope.usage) ?? null });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return new Response('Not found', { status: 404 });

    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ status: 'ok', evalOnly: true });
    if (request.method !== 'POST') return new Response('Not found', { status: 404 });

    const body = await request.json<AnswerRequest>().catch(() => null);
    if (!body) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    try {
      if (url.pathname === '/retrieve') {
        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (!question) return Response.json({ error: 'question is required' }, { status: 400 });
        return Response.json({ excerpts: await retrieve(env, question) });
      }
      if (url.pathname === '/answer') return await answer(env, body);
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
