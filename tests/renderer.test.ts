// The chat page formats the model's answer with a small Markdown renderer in
// public/app.js. It is not exported and the file needs a browser to load, so the
// renderer's source is cut out of the file and run on its own here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function escapeHtml(');
const end = source.indexOf('// ---- Bot check');
if (start === -1 || end === -1) throw new Error('Could not find the renderer in public/app.js: update the markers in this test');
const renderMarkdown = new Function(`${source.slice(start, end)}\nreturn renderMarkdown;`)() as (src: string) => string;

const ALLOWED_TAGS = new Set(['p', 'br', 'ul', 'ol', 'li', 'h4', 'strong', 'em', 'code']);

/** Every tag in the rendered HTML, with its attributes if it has any. */
function tags(html: string): { name: string; attributes: string }[] {
  return [...html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)].map((m) => ({ name: m[1].toLowerCase(), attributes: m[2].trim() }));
}

const ATTACKS = [
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=2</script>',
  '**<svg onload="window.__pwned=3">bold</svg>**',
  '- [click me](javascript:window.__pwned=4)',
  '- ![tracker](https://attacker.example/x.png)',
  '`<iframe src="javascript:window.__pwned=5"></iframe>`',
  '*"><img src=x onerror=window.__pwned=6>*',
  '# <a href="https://attacker.example">heading</a>',
  '1. <style>body{display:none}</style>',
  '&lt;script&gt;alert(1)&lt;/script&gt; <b onmouseover=alert(1)>x</b>',
];

describe('renderMarkdown', () => {
  it('formats ordinary answers', () => {
    expect(renderMarkdown('The limit is **$7,000**.\n\n- one\n- two')).toBe('<p>The limit is <strong>$7,000</strong>.</p><ul><li>one</li><li>two</li></ul>');
  });

  it.each(ATTACKS)('only produces its own tags, with no attributes: %s', (attack) => {
    const html = renderMarkdown(`Here is the answer.\n${attack}\nMore text.`);
    for (const tag of tags(html)) {
      expect(ALLOWED_TAGS.has(tag.name), `unexpected <${tag.name}>`).toBe(true);
      expect(tag.attributes).toBe('');
    }
  });

  it('creates no links or images, even from Markdown syntax', () => {
    const html = renderMarkdown('[CRA](https://attacker.example) ![x](https://attacker.example/x.png)');
    expect(html).not.toMatch(/<a\b|<img\b|href=|src=/i);
  });

  it('shows injected markup as text', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });
});
