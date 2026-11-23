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
tests/              unit tests, plus eval.ts for end-to-end checks
```

## Testing

```bash
npm test             # unit tests for parsing, chunking and section detection
npm run typecheck
API_URL=http://localhost:8787/taxgpt npm run eval   # asks real questions; each one is a billed request
```

## Limitations

- Each question is answered on its own; the app has no memory of earlier questions.
- It covers federal income tax plus the provincial rates on the CRA pages. The Income Tax Regulations, provincial acts and GST/HST are not included.
- The Act is a snapshot from the day you last ran `npm run ingest`. The CRA guide pages describe the most recently filed tax year.
- Answers are general information, not tax advice. The app is not affiliated with the Government of Canada or the CRA.
