// Asks a running copy of the app each question in eval-questions.json and checks
// the answer mentions the expected facts. Every question is a real, billed request.
//
//   API_URL=http://localhost:8787/taxgpt npm run eval
import questions from './eval-questions.json' with { type: 'json' };

const API_URL = process.env.API_URL ?? 'http://localhost:8787/taxgpt';
const PAUSE_MS = 13_000; // stays under the site's 5-questions-a-minute limit

async function ask(question: string): Promise<{ text: string; sources: number }> {
  const res = await fetch(`${API_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: question }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  let text = '';
  let sources = 0;
  for (const block of (await res.text()).split(/\r?\n\r?\n/)) {
    const event = /^event:\s*(.*)$/m.exec(block)?.[1];
    const data = /^data:\s*(.*)$/m.exec(block)?.[1];
    if (!event || !data) continue;
    const payload = JSON.parse(data);
    if (event === 'delta') text += payload.text;
    if (event === 'sources') sources = payload.sources.length;
    if (event === 'error') throw new Error(payload.message);
  }
  return { text, sources };
}

let failed = 0;
for (const [i, { question, expected_keywords }] of questions.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
  try {
    const { text, sources } = await ask(question);
    const missing = expected_keywords.filter((k) => !text.toLowerCase().includes(k.toLowerCase()));
    const ok = missing.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${question}  (${sources} sources)`);
    if (!ok) console.log(`      missing: ${missing.join(', ')}\n      answer: ${text.slice(0, 300).replace(/\n/g, ' ')}`);
  } catch (err) {
    failed++;
    console.log(`ERROR ${question}\n      ${(err as Error).message}`);
  }
}
console.log(`\n${questions.length - failed}/${questions.length} passed`);
process.exit(failed ? 1 : 0);
