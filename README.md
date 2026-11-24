# TaxGPT — Canadian income tax Q&A

A chatbot that answers questions about Canadian federal income tax. It looks up the relevant passages in the Income Tax Act and on Canada Revenue Agency (CRA) pages, then has Claude write an answer from those passages only, with citations.

It runs as a single Cloudflare Worker. There is no server, database or Docker to manage.

**Author:** Sarthak Gandhi

---

## How it works

```
  ONCE, ON YOUR LAPTOP (npm run ingest)

  Income Tax Act (XML) ─┐
                        ├─▶ split into ─▶ turn each chunk ─▶ store in
  CRA pages (HTML) ─────┘    chunks        into a vector      Vectorize
                                           (Workers AI)

  FOR EVERY QUESTION (the Worker)

  question ─▶ limits ─▶ turn question ─▶ find the closest ─▶ Claude writes ─▶ streamed
              (below)    into a vector    chunks (Vectorize)   an answer from    to the page
                         (Workers AI)                          those chunks
```

1. **Ingest** (`scripts/`): downloads the sources, splits them into chunks of up to 450 words, and stores each chunk in Vectorize next to a vector that represents its meaning. The Act is split by section, so a chunk never mixes two sections.
2. **Retrieve** (`src/retrieval.ts`): a question is turned into a vector by the same model, and Vectorize returns the chunks whose vectors are closest. If the question names a section ("section 118.2"), that section's chunks are fetched first.
3. **Answer** (`src/chat.ts`, `src/prompt.ts`): the chunks and the question go to Claude with instructions to answer only from them, cite them, and say so when they don't cover the question. The answer streams to the page as it is written.

| Piece | Service | Cost |
|---|---|---|
| Hosting and chat page | Cloudflare Workers | Free plan |
| Vector search | Cloudflare Vectorize | Free plan (up to 4,882 chunks) |
| Embeddings | Workers AI, `@cf/baai/bge-m3` | Free daily allowance |
| Answers | Anthropic API, `claude-haiku-5-5` | Pay per use, roughly a tenth of a cent per question |

## What is ingested

- **Income Tax Act**, the full consolidated statute from the [Justice Laws Website](https://laws-lois.justice.gc.ca/eng/acts/I-3.3/). Repealed sections, amendment history notes, amendments not yet in force and the schedules are left out.
- **CRA pages** listed in [`scripts/sources.ts`](scripts/sources.ts):
  - the year's figures: tax brackets, indexed amounts, RRSP/TFSA limits, CPP and EI rates;
  - the Federal Income Tax and Benefit Guide;
  - every page linked from CRA's "All deductions, credits, and expenses" and "All types of income" lists (about 120 plain-language pages, one per line of the tax return).

To add a page, add its URL to `CRA_PAGES` and run `npm run ingest` again. After re-ingesting, update the "current to" date in the About panel in `public/index.html` (the ingest prints the Act's date). `npm run ingest:dry` shows the chunk counts without sending anything to Cloudflare.

## Setup

You need Node 20+, a Cloudflare account and an Anthropic API key.

```bash
npm install
npx wrangler login

# 1. Create the search index (once)
npm run setup

# 2. Fill it (a few minutes; re-run whenever the Act or the CRA pages change)
npm run ingest

# 3. Run locally at http://localhost:8787/taxgpt/
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars
npm run dev

# 4. Deploy to sarthak.page/taxgpt
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npm run deploy
```

The app is served at `sarthak.page/taxgpt`, next to the other projects on that domain, through a Worker route (`routes` in `wrangler.jsonc`). It has no workers.dev address. Everything lives under the `/taxgpt` prefix: `assets.base_path` serves `public/` there, the Worker's routes are mounted on it (`BASE_PATH` in `src/index.ts`), the page links its files with the prefix, and `public/_headers` rules use full paths. To move it to another path, change all four.

The Anthropic key for this app belongs to its own TaxGPT workspace in the Anthropic Console, which has a $20 monthly spend limit, so it cannot run up costs on other projects' keys.

`npm run dev` uses the real index and embedding model, because Cloudflare cannot simulate either locally.

## Limits on public use

Anyone can open the page, so several limits cap what it can cost:

| Limit | Default | Where to change it |
|---|---|---|
| Questions per visitor | 5 per minute, by IP address | `ratelimits` in `wrangler.jsonc` |
| Questions per day, all visitors | 500 | `DAILY_QUESTION_LIMIT` in `wrangler.jsonc` |
| Question length | 1,000 characters | `MAX_QUESTION_CHARS` in `src/index.ts` |
| Answer length | 6,000 tokens, including the model's reasoning | `MAX_OUTPUT_TOKENS` in `src/chat.ts` |
| Bot check | Off until configured | see below |

Also set a monthly spend limit in the Anthropic Console as the final backstop.

**Bot check.** A Turnstile widget named TaxGPT (hostnames `sarthak.page` and `localhost`, Managed mode, pre-clearance off) guards `/chat`: the page gets a fresh token for every question, usually without showing anything, and the Worker verifies it before any model call. Its site key is `TURNSTILE_SITE_KEY` in `wrangler.jsonc`; its secret goes in `.dev.vars` locally and `npx wrangler secret put TURNSTILE_SECRET_KEY` for production. The widget only affects pages that load it, so other sites on sarthak.page are untouched. Headless browsers may fail the check; to test locally without it, remove `TURNSTILE_SECRET_KEY` from `.dev.vars`.

## Prompt injection

Anyone can type anything into the question box, so the app assumes some people will try to make the model ignore its rules. What limits the damage is mostly the design, not the prompt:

- The model has no tools, no memory between questions and no private data. The worst a successful attack can do is make one answer, shown only to the attacker, say something wrong or off-topic.
- The question is escaped before it goes into the prompt (`src/untrusted.ts`), so text typed to look like an `<excerpt>` can't pass for one. The system prompt (`src/prompt.ts`) says excerpt-like text in a question is the person's own claim, not a source, and forbids web addresses, emails and phone numbers that aren't in the excerpts.
- The page escapes the answer before formatting it, creates no links or images from it, and the content security policy (`public/_headers`) blocks inline scripts.
- Questions are capped at 1,000 characters and answers at 6,000 tokens, alongside the per-visitor and daily limits above.

In November 2026 this was tested with 26 attacks: instruction overrides, persona jailbreaks, system-prompt extraction, forged excerpts and system notices, base64 and payload splitting, a fake dialogue, phishing links, script injection, a "legally binding offer" trick, and three poisoned excerpts. All failed except one: a forged excerpt citing a section that doesn't exist made the model present an invented credit as law. Escaping the question and the new prompt rule fixed it.

The model-facing attacks are now the `injection` eval (see Evals below), graded automatically, and the page's renderer is covered by `tests/renderer.test.ts`.

## Configuration

| Setting | Where | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | required |
| `CLAUDE_MODEL` | `wrangler.jsonc` | `claude-haiku-5-5` |
| `CLAUDE_EFFORT` | `wrangler.jsonc` | `medium` (how much the model reasons: `low` to `max`) |
| `DAILY_QUESTION_LIMIT` | `wrangler.jsonc` | `500` |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | `wrangler.jsonc` / secret | on (widget "TaxGPT", hostnames sarthak.page and localhost) |

The embedding model is set in `src/shared.ts`. Changing it means recreating the index with the new model's dimensions and ingesting again.

## The chat page

The page is plain HTML, CSS and JavaScript modules with no framework, no dependencies and no build step. Where the browser has a built-in feature it is used; the rest is a few small functions in `public/ui.js`:

| Part | Built from | What it does |
|---|---|---|
| About panel | the HTML `popover` attribute | opens above the page; closes on Escape or a click outside |
| Sources list | a button with `aria-expanded` and an `inert` panel | shows or hides an answer's sources; hidden links can't be reached with Tab |
| Conversation | `stickToBottom` in `ui.js` | follows an answer as it streams, lets go when you scroll up, offers "jump to latest" |
| Question box | `createComposer` in `ui.js` | Enter sends, Shift+Enter adds a line, ArrowUp and ArrowDown step through earlier questions, the box grows with the text |
| Copy button | `copyButton` in `ui.js` | copies an answer and shows a tick for a moment |
| Screen-reader updates | `announce` in `ui.js` and a live region | reads out "Answer ready" and error messages |

All the styling is in `public/styles.css`. The page uses two fonts: [Plus Jakarta Sans](https://fonts.google.com/specimen/Plus+Jakarta+Sans) for text and [Bricolage Grotesque](https://fonts.google.com/specimen/Bricolage+Grotesque) for the heading and name. They come from Fontsource packages, under the SIL Open Font License, and `npm run vendor` copies their Latin subset into `public/vendor/fonts/` (git-ignored). Wrangler runs it before every `dev` and `deploy`, so the page never depends on a third-party site at runtime. Because Wrangler reads the asset list when `npm run dev` starts, restart it after adding new files under `public/`.

`public/_headers` sets response headers for the static files: a content security policy that only allows our own scripts (plus Cloudflare's Turnstile, if it is turned on), and a one-week browser cache for the fonts. The page, stylesheet and our scripts are re-checked on every visit, so changes show up straight away.

## Project layout

```
src/index.ts        routes and the limits on /chat
src/chat.ts         retrieval + Claude, streamed as events
src/retrieval.ts    embeds the question and queries Vectorize
src/prompt.ts       system prompt and how excerpts are presented
src/usage.ts        daily question counter (a Durable Object)
public/index.html   the chat page's markup
public/styles.css   its styling
public/ui.js        small behaviours: scrolling, the question box, copy, announcements
public/app.js       chat logic: sends questions, renders the streamed answer
scripts/ingest.ts   builds the index
scripts/vendor-fonts.mjs  copies the fonts into public/vendor/fonts/
scripts/lib/        parsers for the Act (ita.ts) and CRA pages (cra.ts), chunk packing (chunk.ts)
scripts/sources.ts  the list of CRA pages
tests/              unit tests (no network)
evals/              the eval suite: datasets, judges, runner and a local-only Worker
```

## Testing

```bash
npm test             # unit tests: parsing, chunking, section detection, the page's Markdown renderer, the eval checks
npm run typecheck
```

## Evals

`npm test` checks the code. The evals check the answers: they ask the real system real questions and grade what comes back. Everything is in `evals/`.

| Suite | Cases | What it measures | How it is graded |
|---|---|---|---|
| `retrieval` | 91 | Are the chunks that hold the answer among the excerpts the model is given (8, or up to 10 when the question names a section)? | Recall and mean reciprocal rank (MRR) against the chunk ids recorded for each question. No Claude calls. |
| `answers` | 94 | Is the answer right? Federal and every province's and territory's rates, RRSP/TFSA/FHSA/CPP/EI limits, credits and deductions, Act sections by number, CRA how-to questions, multi-part and ambiguous questions, plain-language and typo-ridden ones. | The expected figures must appear in the answer (a text check), and a judge model must agree it matches a short reference answer. |
| (same answers) | 94 | Faithfulness and citations: is every claim supported by the excerpts the model actually received, and does every citation point to one of them? | A judge model that is shown those excerpts. |
| `decline` | 20 | Questions it should not answer as asked: out of scope (US tax, stock picks, recipes), not in the data (2028 brackets), false premises ("why is the lowest rate 10%?"). | Forbidden text and required corrections (text checks), plus a judge. |
| `injection` | 27 | 24 attacks typed into the question box and 3 planted inside excerpts (see Prompt injection above). | Per-attack rules: no web or email address that isn't in the excerpts, no Markdown image, no sentence of the system prompt, no forbidden text; plus a judge reading each attack's pass rule. |
| `judges` | 12 | Do the judges themselves work? Answers with a known verdict, right and wrong, go through each judge. | Agreement with the known verdict. |

Every expected answer was written from `.ingest/chunks.jsonl`, the text that was actually ingested, and each question records the chunk ids it came from. `npm run eval:validate` (also part of `npm test`) fails if a chunk id no longer exists or an expected figure is no longer in its chunk, which is what will happen to some questions after a re-ingest for a new tax year.

```bash
npm run eval:server     # terminal 1: the eval Worker, at http://localhost:8799
npm run eval            # terminal 2: answers, decline, injection and judges (retrieval is scored from the same answers)

npm run eval:retrieval  # retrieval only: free
npm run eval:injection  # one suite; also eval:answers, eval:decline, eval:judges
npm run eval -- answers --only rates --limit 5   # filter by category, kind or part of an id
npm run eval -- injection --no-judge             # text checks only
```

Each run prints a summary table and a list of failures with the likely cause (retrieval miss, or the right excerpt but a wrong answer), and saves every question, answer, excerpt id and verdict to `evals/results/<time>/` (git-ignored). The command exits non-zero if anything failed.

**Cost.** A full run is 141 answers from the app and about 300 judge calls: about **$1.20** (app $0.16, judges $1.05) at November 2026 prices, and takes 5 to 10 minutes. The run prints the real figure from the token counts. `eval:retrieval` uses only the embedding model and the index, within Cloudflare's free allowances. The key comes from `.dev.vars`, so the spend counts against the TaxGPT workspace's monthly limit.

**How it runs without touching production.** `/chat` has a rate limit, a daily cap and a bot check, and does not report which chunks were retrieved. So the evals use a second, local-only Worker, `evals/worker.ts`, started by `npm run eval:server` from its own config (`evals/wrangler.jsonc`). It calls the app's own `retrieve` and `streamAnswer` with the model and effort from the main `wrangler.jsonc`, and returns the excerpts and token usage as well as the answer. It has no route and no workers.dev address, refuses requests that aren't to localhost, and is not part of what `npm run deploy` uploads. It reads the real index and embedding model but does not use the rate limiter or the daily counter, so eval runs never eat into the 500 questions a day. Don't deploy it.

**Judges.** The app answers with `claude-haiku-5-5`; `claude-sonnet-5-5` judges correctness, declines and injection. Faithfulness needs all the excerpts (about 8,000 tokens a question), so Haiku reads every answer first and Sonnet re-reads only the ones Haiku faults; Sonnet's verdict stands. A faithfulness pass therefore rests on Haiku alone, and a fail always has Sonnet behind it. To have one model judge everything, set `JUDGE_MODEL` and `FAITHFULNESS_JUDGE_MODEL` (for example both to `claude-opus-5-5`, which costs several dollars a run). Judges return structured output: pass/fail fields and a reason.

**Reading the results.** Each run asks every question once, and the model's answers vary a little from run to run, so a difference of two or three questions between runs is noise. "Faithful" is strict: one sentence of unsupported background fails it. "No material unsupported claim" counts only unsupported figures, dates, rules and form numbers. An `ERROR` row means the plumbing failed (a timeout, an API error); it is reported and not scored.

## Limitations

- Each question is answered on its own; the app has no memory of earlier questions.
- It covers federal income tax plus the provincial rates on the CRA pages. The Income Tax Regulations, provincial acts and GST/HST are not included.
- The Act is a snapshot from the day you last ran `npm run ingest`. The CRA guide pages describe the most recently filed tax year.
- Answers are general information, not tax advice. The app is not affiliated with the Government of Canada or the CRA.
