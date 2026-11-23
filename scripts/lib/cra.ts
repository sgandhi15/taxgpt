// Turns a Canada.ca page into chunks: headings, paragraphs, list items and table
// rows become lines, which are packed under the section heading they sit below.
import { createHash } from 'node:crypto';
import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import { type Chunk, countWords } from './chunk.js';

const SKIP_TAGS = new Set(['script', 'style', 'nav', 'form', 'noscript', 'svg', 'button', 'template', 'figure']);
// Page furniture: "Page details", feedback widget, screen-reader-only labels,
// the "From: Canada Revenue Agency" byline.
const SKIP_CLASSES = ['pagedetails', 'gc-pg-hlpfl', 'wb-inv', 'gc-followus', 'nojs-show', 'gc-contributors'];
// The heading of a page's table of contents; the list under it is skipped as an in-page link list.
const TOC_HEADING = /^on this page:?$/i;
const BLOCK_TAGS = new Set([
  'p', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'caption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'article', 'details', 'summary',
  'header', 'footer', 'blockquote', 'main', 'aside',
]);

interface HtmlLine {
  kind: 'heading' | 'text' | 'row' | 'caption';
  level?: number; // headings only
  tableId?: number; // rows and captions
  isHeaderRow?: boolean;
  text: string;
}

const isElement = (n: ChildNode): n is Element => n.type === 'tag';
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function skipped(el: Element): boolean {
  if (SKIP_TAGS.has(el.name)) return true;
  // A table caption names the table (for example "Nunavut rate: 2026") even when
  // Canada.ca shows it only to screen readers, so it is always kept.
  if (el.name === 'caption') return false;
  const cls = el.attribs.class ?? '';
  return SKIP_CLASSES.some((c) => cls.split(/\s+/).includes(c)) || isInPageLinkList(el);
}

// A list whose every item is just a link to a spot on the same page: a table of contents.
function isInPageLinkList(el: Element): boolean {
  if (el.name !== 'ul' && el.name !== 'ol') return false;
  const items = el.children.filter(isElement);
  return items.length > 0 && items.every((li) => {
    const parts = li.children.filter((c) => isElement(c) || (c.type === 'text' && c.data.trim()));
    return parts.length === 1 && isElement(parts[0]) && parts[0].name === 'a' && (parts[0].attribs.href ?? '').startsWith('#');
  });
}

function inlineText(node: ChildNode): string {
  if (node.type === 'text') return node.data;
  if (!isElement(node) || skipped(node)) return '';
  if (node.name === 'br') return ' ';
  return node.children.map(inlineText).join('');
}

function find(node: { children?: ChildNode[] }, test: (el: Element) => boolean): Element | undefined {
  for (const child of node.children ?? []) {
    if (isElement(child)) {
      if (test(child)) return child;
      const found = find(child, test);
      if (found) return found;
    }
  }
  return undefined;
}

let tableCounter = 0;

function walk(el: Element, out: HtmlLine[], tableId?: number, inHead = false): void {
  if (skipped(el)) return;

  if (el.name === 'tr') {
    const cells = el.children.filter(isElement).filter((c) => c.name === 'th' || c.name === 'td');
    const text = cells.map((c) => squash(inlineText(c))).join(' | ');
    if (squash(text.replace(/\|/g, ''))) {
      // Rows in <thead> are headings even when they hold an empty <td>.
      const isHeaderRow = inHead || (cells.length > 0 && cells.every((c) => c.name === 'th'));
      out.push({ kind: 'row', tableId, isHeaderRow, text });
    }
    return;
  }
  if (el.name === 'caption') {
    const text = squash(inlineText(el));
    if (text) out.push({ kind: 'caption', tableId, text });
    return;
  }
  if (el.name === 'table') tableId = ++tableCounter;
  if (el.name === 'thead') inHead = true;

  const heading = /^h([1-6])$/.exec(el.name);
  let buf = '';
  const flush = () => {
    const text = squash(buf);
    if (text) out.push(heading ? { kind: 'heading', level: Number(heading[1]), text } : { kind: 'text', text });
    buf = '';
  };
  for (const child of el.children) {
    if (child.type === 'text') buf += child.data;
    else if (isElement(child)) {
      if (BLOCK_TAGS.has(child.name)) {
        flush();
        walk(child, out, tableId, inHead);
      } else {
        buf += inlineText(child);
      }
    }
  }
  flush();
}

export interface CraPage {
  title: string;
  asOf: string;
  chunks: Chunk[];
}

export function parseCraPage(html: string, url: string, maxWords: number): CraPage {
  const doc = parseDocument(html);
  const main = find(doc, (el) => el.name === 'main');
  if (!main) throw new Error(`No <main> element in ${url}`);

  const meta = find(doc, (el) => el.name === 'meta' && el.attribs.name === 'dcterms.modified');
  const asOf = meta?.attribs.content ?? '';
  const titleEl = find(doc, (el) => el.name === 'title');
  const h1 = find(main, (el) => el.name === 'h1');
  // Some pages share a generic <h1> ("Calculate payroll deductions and contributions")
  // and carry the specific name only in <title>, so prefer <title> when it contains the <h1>.
  const h1Text = h1 ? squash(inlineText(h1)) : '';
  const docTitle = titleEl ? squash(inlineText(titleEl)).replace(/\s*-\s*Canada\.ca$/, '') : '';
  const title = (docTitle.includes(h1Text) ? docTitle : h1Text) || docTitle || url;

  const lines: HtmlLine[] = [];
  walk(main, lines);

  // Vector ids are capped at 64 bytes, so shorten the page name and add a hash of the URL to keep it unique.
  const name = (url.split('/').pop() ?? 'page').replace(/\.html?$/, '').slice(0, 40);
  const slug = `${name}-${createHash('sha1').update(url).digest('hex').slice(0, 6)}`;
  const chunks: Chunk[] = [];
  let section = ''; // nearest h2 above the current line
  let body: string[] = [];
  let words = 0;
  let chunkSection = '';

  // Per table: its caption and heading rows (repeated when the table is split
  // across chunks) and its total size (small tables are kept in one chunk).
  const tableLabel = new Map<number, HtmlLine[]>();
  const tableWords = new Map<number, number>();
  for (const line of lines) {
    if (line.tableId === undefined) continue;
    tableWords.set(line.tableId, (tableWords.get(line.tableId) ?? 0) + countWords(line.text));
  }
  let currentTable: number | undefined;

  const emit = () => {
    if (words === 0) return;
    const header =
      `Canada Revenue Agency: ${title}` +
      (chunkSection && chunkSection !== title ? `\nSection: ${chunkSection}` : '') +
      (asOf ? `\nPage last modified: ${asOf}` : '');
    chunks.push({
      id: `cra:${slug}:${chunks.length}`,
      text: `${header}\n\n${body.join('\n')}`,
      source: 'cra',
      title: chunkSection && chunkSection !== title ? `${title}: ${chunkSection}` : title,
      ref: '',
      section: '',
      url,
      asOf,
    });
    body = [];
    words = 0;
  };

  for (const line of lines) {
    if (line.kind === 'heading' && line.level === 1) continue; // already the title
    if (line.kind === 'heading' && TOC_HEADING.test(line.text)) continue; // its list is skipped too
    if (line.kind === 'heading' && line.level === 2) {
      // Start a new chunk at each major heading, unless the current one is still tiny.
      if (words >= 150) emit();
      section = line.text;
    }
    const t = line.tableId;
    const startsTable = t !== undefined && t !== currentTable;
    currentTable = t;
    if (t !== undefined && (line.kind === 'caption' || line.isHeaderRow)) {
      tableLabel.set(t, [...(tableLabel.get(t) ?? []), line]);
    }

    const w = countWords(line.text);
    // A table that fits in one chunk starts a new chunk rather than being split.
    const tableSize = startsTable ? (tableWords.get(t!) ?? 0) : 0;
    if (words > 0 && startsTable && words + tableSize > maxWords && tableSize <= maxWords) {
      emit();
    } else if (words > 0 && words + w > maxWords) {
      emit();
      // A table split across chunks repeats its caption and heading rows, so the
      // rows in the next chunk still say which table (and which columns) they are.
      if (t !== undefined && !startsTable) {
        for (const label of tableLabel.get(t) ?? []) {
          if (label === line) continue;
          body.push(label.text);
          words += countWords(label.text);
        }
      }
    }
    if (words === 0) chunkSection = section;
    body.push(line.kind === 'heading' ? `## ${line.text}` : line.text);
    words += w;
  }
  emit();

  return { title, asOf, chunks };
}

/** Absolute URLs of the links inside <main> whose path starts with `pathPrefix`. */
export function extractLinks(html: string, pageUrl: string, pathPrefix: string): string[] {
  const main = find(parseDocument(html), (el) => el.name === 'main');
  if (!main) throw new Error(`No <main> element in ${pageUrl}`);
  const urls = new Set<string>();
  const visit = (node: { children?: ChildNode[] }) => {
    for (const child of node.children ?? []) {
      if (!isElement(child)) continue;
      const href = child.name === 'a' ? child.attribs.href : undefined;
      if (href) {
        const url = new URL(href, pageUrl);
        url.hash = '';
        if (url.pathname.startsWith(pathPrefix) && url.pathname.endsWith('.html')) urls.add(url.toString());
      }
      visit(child);
    }
  };
  visit(main);
  urls.delete(pageUrl);
  return [...urls];
}
