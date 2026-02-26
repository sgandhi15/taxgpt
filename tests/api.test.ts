import { describe, test, expect } from 'bun:test';
import evalQuestions from './eval-questions.json' with { type: 'json' };

const API_URL = process.env.API_URL || 'http://localhost:3000';
const DELAY_BETWEEN_EVAL_MS = 4000; // Avoid Groq rate limit (TPM) when running eval questions

async function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function chatWithRetry(message: string, maxRetries = 3): Promise<Response> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const isRetryable = res.status === 429 || res.status === 500;
    if (isRetryable && attempt < maxRetries) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '15', 10);
      const waitMs = Math.min(retryAfter * 1000, 20000);
      console.log(`  ${res.status} response, waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}...`);
      await delay(waitMs);
      continue;
    }
    return res;
  }
  return fetch(`${API_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

describe('API health', () => {
  test('GET / returns HTML chat UI', async () => {
    const res = await fetch(API_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('POST /chat returns a response', async () => {
    const res = await chatWithRetry('Hello');
    expect(res.status).toBe(200);
    const data = (await res.json()) as { response: string };
    expect(data).toHaveProperty('response');
    expect(typeof data.response).toBe('string');
  });

  test('POST /chat returns 400 without message', async () => {
    const res = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('POST /chat returns 400 for invalid JSON', async () => {
    const res = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });
});

describe('Evaluation questions', () => {
  for (let i = 0; i < evalQuestions.length; i++) {
    const { question, expected_keywords } = evalQuestions[i];
    test.serial(`answers "${question}"`, async () => {
      // Space out requests to avoid Groq TPM rate limit
      if (i > 0) await delay(DELAY_BETWEEN_EVAL_MS);

      const res = await chatWithRetry(question);

      expect(res.status).toBe(200);
      const data = (await res.json()) as { response: string };
      expect(data).toHaveProperty('response');

      const response = data.response.toLowerCase();
      const matched = expected_keywords.filter((kw) =>
        response.includes(kw.toLowerCase()),
      );

      const ratio = matched.length / expected_keywords.length;
      console.log(
        `  "${question}" → matched ${matched.length}/${expected_keywords.length} keywords (${(ratio * 100).toFixed(0)}%)`,
      );

      expect(ratio).toBeGreaterThanOrEqual(0.3);
    }, 60_000);
  }
});
