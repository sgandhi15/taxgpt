import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt, toSources, userMessage, type Source } from './prompt';
import { retrieve } from './retrieval';

// Caps the cost of a single answer. Thinking counts toward it, so it is set well
// above the length of a normal reply.
const MAX_OUTPUT_TOKENS = 6000;

export type ChatEvent =
  | { type: 'sources'; sources: Source[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; truncated: boolean }
  | { type: 'error'; message: string };

// A reached workspace spend limit comes back as a 400 or a 429 with this wording,
// and an empty prepaid balance as a 400 about the credit balance.
const OUT_OF_BUDGET = /usage limits|spend limit|credit balance/i;

export function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError && OUT_OF_BUDGET.test(err.message)) {
    return 'TaxGPT has used up its budget for this month. Try again next month.';
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "TaxGPT isn't working right now. Try again later.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'TaxGPT is busy right now. Try again in a minute.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "TaxGPT couldn't reach its AI service. Try again.";
  }
  if (err instanceof Anthropic.APIError) {
    return err.status && err.status >= 500
      ? "TaxGPT's AI service is having trouble. Try again shortly."
      : "TaxGPT couldn't answer that. Try rewording your question.";
  }
  return 'Something went wrong. Try again.';
}

/** Retrieves excerpts, asks Claude, and reports progress through `emit`. Never throws. */
export async function streamAnswer(
  env: Env,
  question: string,
  emit: (event: ChatEvent) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  try {
    const excerpts = await retrieve(env, question);
    if (excerpts.length === 0) {
      await emit({ type: 'error', message: 'The search index is empty. The site owner needs to run the ingest step.' });
      return;
    }
    await emit({ type: 'sources', sources: toSources(excerpts) });

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const stream = client.messages.stream(
      {
        model: env.CLAUDE_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        output_config: { effort: env.CLAUDE_EFFORT },
        system: systemPrompt(new Date().toISOString().slice(0, 10)),
        messages: [{ role: 'user', content: userMessage(question, excerpts) }],
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        await emit({ type: 'delta', text: event.delta.text });
      }
    }

    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      await emit({ type: 'error', message: "TaxGPT couldn't answer that. Try rewording your question." });
      return;
    }
    await emit({ type: 'done', truncated: message.stop_reason === 'max_tokens' });
  } catch (err) {
    if (signal.aborted) return; // the visitor closed the page
    console.error('chat failed:', err);
    await emit({ type: 'error', message: describeError(err) }).catch(() => {});
  }
}
