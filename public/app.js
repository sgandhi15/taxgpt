// Chat logic: sends questions to /chat and renders the streamed answer.
// The small interactive behaviours (scrolling, the question box, copying) live in ui.js.
import { stickToBottom, createComposer, copyButton, announce } from './ui.js';

const messages = document.getElementById('messages');
const viewport = document.getElementById('viewport');

// While the welcome block is showing, start at the top of the page: on a short
// screen, following the bottom would cut off the heading.
const thread = stickToBottom(viewport, messages, document.getElementById('jump'), {
  follow: !document.getElementById('welcome'),
});

// ---- Formatting: a small, escape-first Markdown renderer ------------------------
// The model's text is escaped before any tags are added, so nothing it writes
// can inject HTML.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
}
function renderMarkdown(src) {
  const out = [];
  let paragraph = [];
  let list = null; // { tag, items }
  const closeParagraph = () => { if (paragraph.length) { out.push('<p>' + paragraph.join('<br>') + '</p>'); paragraph = []; } };
  const closeList = () => { if (list) { out.push(`<${list.tag}>` + list.items.map((i) => `<li>${i}</li>`).join('') + `</${list.tag}>`); list = null; } };
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) { closeParagraph(); closeList(); }
    else if (heading) { closeParagraph(); closeList(); out.push('<h4>' + inline(heading[1]) + '</h4>'); }
    else if (bullet || numbered) {
      closeParagraph();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) closeList();
      if (!list) list = { tag, items: [] };
      list.items.push(inline((bullet || numbered)[1]));
    }
    else if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ' ' + inline(line.trim()); }
    else { closeList(); paragraph.push(inline(line)); }
  }
  closeParagraph(); closeList();
  return out.join('');
}

// Server routes are found relative to this script, so the page works under any path
// prefix (it is served at /taxgpt/).

// ---- Bot check (only when the server says it is configured) ----------------------
let turnstile = null; // { widgetId, pending: { resolve, reject } | null }
async function setUpTurnstile() {
  const config = await fetch(new URL('config', import.meta.url)).then((r) => r.json()).catch(() => ({}));
  if (!config.turnstileSiteKey) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload = resolve;
    script.onerror = () => reject(new Error("The bot check couldn't load. Reload the page and try again."));
    document.head.appendChild(script);
  });
  const state = { widgetId: null, pending: null };
  state.widgetId = window.turnstile.render('#turnstile', {
    sitekey: config.turnstileSiteKey,
    execution: 'execute',
    appearance: 'interaction-only',
    callback: (token) => { state.pending?.resolve(token); state.pending = null; },
    'error-callback': () => { state.pending?.reject(new Error("We couldn't confirm you're not a bot. Reload the page and try again.")); state.pending = null; },
  });
  turnstile = state;
}
// Tokens are single-use, so each question gets a fresh one.
function freshTurnstileToken() {
  if (!turnstile) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    turnstile.pending = { resolve, reject };
    window.turnstile.reset(turnstile.widgetId);
    window.turnstile.execute('#turnstile');
    setTimeout(() => reject(new Error('The bot check took too long. Try again.')), 30000);
  });
}
const turnstileReady = setUpTurnstile().catch((err) => console.warn(err));

// ---- Building messages ------------------------------------------------------------
const ICONS = {
  chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  copy: '<svg class="copy" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  check: '<svg class="check" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function addMessage(role) {
  const welcome = document.getElementById('welcome');
  if (welcome) {
    welcome.remove();
    thread.jump(); // follow the conversation from here on
  }
  const message = el('article', `msg ${role}`);
  messages.appendChild(message);
  return message;
}

// The row under a finished answer: a button that shows or hides the sources, and a copy button.
let panelCount = 0;
function footer(sources, answerText) {
  const root = el('div', 'sources');
  const actions = el('div', 'actions');
  root.appendChild(actions);

  if (sources.length) {
    const panel = el('div', 'source-panel');
    panel.id = `sources-${++panelCount}`;
    panel.inert = true; // collapsed: its links can't be reached with Tab
    const list = el('ul', 'source-list');
    for (const source of sources) {
      const link = el('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const isCra = source.label.startsWith('CRA');
      const tag = el('span', 'source-tag', isCra ? 'CRA' : 'ACT');
      tag.dataset.kind = isCra ? 'cra' : 'act';
      link.append(tag, el('span', 'source-title', sourceTitle(source)));
      const item = el('li');
      item.appendChild(link);
      list.appendChild(item);
    }
    panel.appendChild(list);

    const toggle = el('button', 'chip');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', panel.id);
    toggle.innerHTML = `${sources.length} ${sources.length === 1 ? 'source' : 'sources'} ${ICONS.chevron}`;
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      panel.toggleAttribute('data-open', open);
      panel.inert = !open;
    });
    actions.appendChild(toggle);
    root.appendChild(panel);
  }

  const copy = el('button', 'icon');
  copy.innerHTML = ICONS.copy + ICONS.check;
  copyButton(copy, answerText);
  actions.appendChild(copy);
  return root;
}

function sourceTitle(source) {
  const section = /s\. (\S+)$/.exec(source.label);
  return section ? `Section ${section[1]}: ${source.title}` : source.title;
}

// Reads the server's event stream: blocks of "event: x" / "data: {json}" separated by blank lines.
async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop();
    for (const block of blocks) {
      let event = 'message';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, JSON.parse(data.join('\n')));
    }
  }
}

// ---- Asking a question -------------------------------------------------------------
async function ask(question) {
  addMessage('user').appendChild(el('div', 'bubble', question));
  const reply = addMessage('assistant');
  const answer = el('div', 'answer');
  const status = el('p', 'status', 'Searching…');
  answer.appendChild(status);
  reply.appendChild(answer);

  const fail = (message) => {
    // Keep whatever was already written and put the error below it.
    status.remove();
    reply.appendChild(el('p', 'error', message));
    announce(message);
  };

  try {
    await turnstileReady;
    const turnstileToken = await freshTurnstileToken();
    const response = await fetch(new URL('chat', import.meta.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, turnstileToken }),
    });
    if (!response.ok || !(response.headers.get('content-type') || '').includes('text/event-stream')) {
      const data = await response.json().catch(() => ({}));
      fail(data.error || `Something went wrong (error ${response.status}). Try again.`);
      return;
    }

    let text = '';
    let sources = [];
    let finished = false;
    await readEvents(response, (event, data) => {
      if (event === 'sources') {
        sources = data.sources;
        status.textContent = 'Writing…';
      } else if (event === 'delta') {
        text += data.text;
        answer.innerHTML = renderMarkdown(text);
      } else if (event === 'done') {
        finished = true;
        if (data.truncated) reply.appendChild(el('p', 'note', 'This answer was cut off. Try asking about one part at a time.'));
        reply.appendChild(footer(sources, text));
        announce('Answer ready.');
      } else if (event === 'error') {
        finished = true;
        fail(data.message);
      }
    });
    if (!finished) fail('The connection dropped before the answer finished. Try again.');
  } catch (err) {
    fail(err.message || 'Something went wrong. Try again.');
  }
}

// ---- Wiring ------------------------------------------------------------------------
// The composer won't send another question until the current answer has finished.
const composer = createComposer(document.getElementById('composer'), {
  async onSend(question) {
    composer.setBusy(true);
    await ask(question);
    composer.setBusy(false);
    composer.focus();
  },
});

// An example question goes through the composer, so it is sent and remembered like a typed one.
document.getElementById('suggestions').addEventListener('click', (event) => {
  const button = event.target.closest('.suggestion');
  if (button) composer.send(button.textContent);
});
