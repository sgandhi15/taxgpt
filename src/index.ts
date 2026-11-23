import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { streamAnswer } from './chat';

export { UsageCounter } from './usage';

const MAX_QUESTION_CHARS = 1000;

// The app lives at sarthak.page/taxgpt (see routes and assets.base_path in wrangler.jsonc).
const BASE_PATH = '/taxgpt';
const app = new Hono<{ Bindings: Env }>().basePath(BASE_PATH);

app.get('/health', (c) => c.json({ status: 'ok' }));

// Lets the page know whether to run the bot check.
app.get('/config', (c) => c.json({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null }));

async function passesTurnstile(secret: string, token: unknown, ip: string | undefined): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  if (!res.ok) return false;
  const outcome = await res.json<{ success?: boolean }>();
  return outcome.success === true;
}

app.post('/chat', async (c) => {
  const body = await c.req.json<{ message?: unknown; turnstileToken?: unknown }>().catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400);

  const question = typeof body.message === 'string' ? body.message.trim() : '';
  if (!question) return c.json({ error: 'Message is required' }, 400);
  if (question.length > MAX_QUESTION_CHARS) {
    return c.json({ error: `Keep questions under ${MAX_QUESTION_CHARS.toLocaleString('en-CA')} characters.` }, 400);
  }

  // The checks run cheapest first, and the daily total is only charged to
  // requests that pass the others.
  const ip = c.req.header('cf-connecting-ip');
  const { success } = await c.env.CHAT_LIMITER.limit({ key: ip ?? 'unknown' });
  if (!success) {
    return c.json({ error: 'Too many questions at once. Wait a minute and try again.' }, 429);
  }

  if (c.env.TURNSTILE_SECRET_KEY && !(await passesTurnstile(c.env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip))) {
    return c.json({ error: "We couldn't confirm you're not a bot. Reload the page and try again." }, 403);
  }

  if (!c.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set');
    return c.json({ error: 'The assistant is not set up yet (missing API key).' }, 500);
  }

  const dailyLimit = Number(c.env.DAILY_QUESTION_LIMIT) || 500;
  const usage = c.env.USAGE.get(c.env.USAGE.idFromName('global'));
  if (!(await usage.tryConsume(dailyLimit))) {
    return c.json({ error: "TaxGPT has reached today's question limit. Try again tomorrow." }, 429);
  }

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    await streamAnswer(
      c.env,
      question,
      async ({ type, ...data }) => {
        await stream.writeSSE({ event: type, data: JSON.stringify(data) });
      },
      abort.signal,
    );
  });
});

export default app;
