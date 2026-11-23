// Small, dependency-free behaviours for the chat page. The About panel and the
// sources list need no code here: they use the browser's own `popover`
// attribute and a plain disclosure button (see app.js).

// ---- Thread: follow the answer as it streams --------------------------------------
// Keeps the conversation scrolled to the end while the reader is there, lets go
// when they scroll up to read, and shows the "jump to latest" button while they
// are away from the end.
export function stickToBottom(viewport, content, jumpButton, { threshold = 48, follow = true } = {}) {
  let following = follow;
  let lastTop = viewport.scrollTop;
  const distance = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  const toEnd = (behavior = 'instant') => viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  const update = () => { jumpButton.hidden = distance() <= threshold; };

  viewport.addEventListener('scroll', () => {
    const top = viewport.scrollTop;
    // Any upward move is the reader taking over (we only ever scroll down), even the
    // first few pixels of an animated wheel scroll. A move up that leaves us at the
    // very end is content shrinking, not the reader.
    if (top < lastTop && distance() > 1) following = false;
    else if (distance() <= threshold) following = true;
    lastTop = top;
    update();
  }, { passive: true });

  // Let go as soon as the reader shows they want to move up. Scroll events alone
  // aren't enough: streamed text can arrive before an animated wheel scroll has
  // moved, and our jump to the end would cancel it.
  const release = () => { following = false; };
  viewport.addEventListener('wheel', (event) => { if (event.deltaY < 0) release(); }, { passive: true });
  let touchY = 0;
  viewport.addEventListener('touchstart', (event) => { touchY = event.touches[0].clientY; }, { passive: true });
  viewport.addEventListener('touchmove', (event) => { if (event.touches[0].clientY > touchY) release(); }, { passive: true });
  viewport.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) release();
  });
  // A press on the viewport itself (not its content) is a press on its scrollbar.
  viewport.addEventListener('pointerdown', (event) => { if (event.target === viewport) release(); });

  // Content grows as the answer streams in; the viewport shrinks when a phone
  // keyboard opens. Either way, stay at the end if we were following.
  const resized = () => { if (following) toEnd(); update(); };
  new ResizeObserver(resized).observe(content);
  new ResizeObserver(resized).observe(viewport);

  const jump = () => { following = true; toEnd('smooth'); };
  jumpButton.addEventListener('click', jump);
  update();
  return { jump };
}

// ---- Composer: the question box ------------------------------------------------------
// The box grows with its text. Enter sends and Shift+Enter starts a new line.
// ArrowUp and ArrowDown step through questions already sent. While an answer is
// coming in the composer is busy and won't send another.
export function createComposer(form, { onSend }) {
  const input = form.querySelector('textarea');
  const sendButton = form.querySelector('.send');
  const sent = [];
  let browsing = -1; // index into `sent` while stepping through it, else -1
  let draft = '';
  let busy = false;

  const fit = () => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  };
  const refresh = () => {
    sendButton.disabled = busy || !input.value.trim();
    sendButton.toggleAttribute('data-busy', busy);
  };
  const write = (value) => {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    fit();
    refresh();
  };

  function send(text) {
    const question = text.trim();
    if (!question || busy) return;
    if (sent.at(-1) !== question) sent.push(question);
    browsing = -1;
    write('');
    onSend(question);
  }

  input.addEventListener('input', () => { browsing = -1; fit(); refresh(); });
  input.addEventListener('keydown', (event) => {
    // A key pressed while an input method (for example, for accented letters) is composing belongs to it.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(input.value);
      return;
    }
    // Step through history only from an empty box or an entry recalled unchanged,
    // so the arrows still move the cursor inside text being edited.
    const unchanged = browsing === -1 ? input.value === '' : input.value === sent[browsing];
    if (event.key === 'ArrowUp' && sent.length && unchanged && browsing !== 0) {
      event.preventDefault();
      if (browsing === -1) { draft = input.value; browsing = sent.length; }
      browsing -= 1;
      write(sent[browsing]);
    } else if (event.key === 'ArrowDown' && browsing !== -1 && unchanged) {
      event.preventDefault();
      browsing += 1;
      if (browsing === sent.length) { browsing = -1; write(draft); } else write(sent[browsing]);
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value);
  });

  refresh();
  return {
    send,
    focus: () => input.focus(),
    setBusy(value) { busy = value; refresh(); },
  };
}

// ---- Copy button -------------------------------------------------------------------
// Copies `text` and shows a tick for a moment.
export function copyButton(button, text) {
  let timer;
  button.type = 'button';
  button.setAttribute('aria-label', 'Copy answer');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // clipboard blocked (for example, page not focused); leave the button as it was
    }
    button.toggleAttribute('data-copied', true);
    button.setAttribute('aria-label', 'Copied');
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.toggleAttribute('data-copied', false);
      button.setAttribute('aria-label', 'Copy answer');
    }, 1600);
  });
}

// ---- Screen-reader announcements ---------------------------------------------------
// Reads a short message aloud through the page's live region.
export function announce(message) {
  const region = document.getElementById('live');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = message; }, 50);
}
