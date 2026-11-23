// Turns the Income Tax Act XML from the Justice Laws Website into chunks,
// one or more per section, never mixing two sections in a chunk.
import { parseDocument } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import { type Chunk, type Line, type Part, packParts, renderLines, splitLines } from './chunk.js';

export const ITA_XML_URL = 'https://laws-lois.justice.gc.ca/eng/XML/I-3.3.xml';
const ITA_SECTION_URL = 'https://laws-lois.justice.gc.ca/eng/acts/I-3.3/section-';

// Elements that start a new line. Anything else is inline text.
const BLOCK = new Set([
  'Section', 'Subsection', 'Paragraph', 'Subparagraph', 'Clause', 'Subclause', 'Subsubclause',
  'Definition', 'FormulaGroup', 'FormulaDefinition', 'FormulaParagraph', 'Provision', 'ReadAsText',
  'SectionPiece', 'MarginalNote',
  'ContinuedSectionSubsection', 'ContinuedParagraph', 'ContinuedSubparagraph', 'ContinuedClause',
  'ContinuedSubclause', 'ContinuedDefinition', 'ContinuedFormulaParagraph',
]);
// Inline elements that need a space on each side when flattened to text.
const SPACED = new Set(['Label', 'FormulaTerm', 'FormulaText', 'FormulaConnector']);
// Amendment history ("R.S., 1985, c. 1 …; 2013, c. 34, s. 3") is noise for answering questions.
const SKIP = new Set(['HistoricalNote']);

const isElement = (n: ChildNode): n is Element => n.type === 'tag';
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function inlineText(node: ChildNode): string {
  if (node.type === 'text') return node.data;
  if (!isElement(node) || SKIP.has(node.name)) return '';
  return node.children.map(inlineText).join('');
}

function childElements(el: Element, name?: string): Element[] {
  return el.children.filter(isElement).filter((c) => !name || c.name === name);
}

function renderBlock(el: Element, depth: number, out: Line[]): void {
  let buf = '';
  const flush = () => {
    const text = squash(buf);
    if (text) out.push({ depth, text });
    buf = '';
  };
  for (const child of el.children) {
    if (child.type === 'text') {
      buf += child.data;
    } else if (isElement(child) && !SKIP.has(child.name)) {
      if (BLOCK.has(child.name)) {
        flush();
        // Marginal notes and "continued" text sit at their parent's level, not below it.
        const sameLevel = child.name === 'MarginalNote' || child.name.startsWith('Continued');
        renderBlock(child, sameLevel ? depth : depth + 1, out);
      } else if (SPACED.has(child.name)) {
        // These sit next to their neighbours with no whitespace in the XML ("A" + "is the…").
        buf += ' ' + inlineText(child) + ' ';
      } else {
        buf += inlineText(child);
      }
    }
  }
  flush();
}

function findFirst(node: ChildNode | { children: ChildNode[] }, name: string): Element | undefined {
  for (const child of (node as { children?: ChildNode[] }).children ?? []) {
    if (isElement(child)) {
      if (child.name === name) return child;
      const found = findFirst(child, name);
      if (found) return found;
    }
  }
  return undefined;
}

export interface ItaResult {
  chunks: Chunk[];
  /** Date the consolidation is current to, YYYY-MM-DD. */
  currentTo: string;
  lastAmended: string;
  sections: number;
  repealedSkipped: number;
}

export function parseIta(xml: string, maxWords: number): ItaResult {
  const doc = parseDocument(xml, { xmlMode: true });
  const statute = findFirst(doc, 'Statute');
  const body = statute && childElements(statute, 'Body')[0];
  if (!statute || !body) throw new Error('Not a Justice Laws statute: no <Statute><Body> found');

  const currentTo = statute.attribs['lims:current-date'] ?? '';
  const lastAmended = statute.attribs['lims:lastAmendedDate'] ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(currentTo)) {
    throw new Error(`Could not read the consolidation date from the XML (got "${currentTo}")`);
  }

  const chunks: Chunk[] = [];
  const headings: string[] = []; // current Part / Division / Subdivision titles, by level
  let sections = 0;
  let repealedSkipped = 0;

  for (const el of childElements(body)) {
    if (el.name === 'Heading') {
      const level = Math.max(1, Number(el.attribs.level) || 1);
      headings.length = level - 1;
      headings[level - 1] = squash(childElements(el).map(inlineText).join(' — '));
      continue;
    }
    if (el.name !== 'Section') continue;

    const label = squash(childElements(el, 'Label').map(inlineText).join(' '));
    if (!label) continue;
    sections++;
    const title = squash(childElements(el, 'MarginalNote').map(inlineText).join(' '));

    // One part per subsection, or one for the whole section when it has none.
    const parts: Part[] = [];
    const subsections = childElements(el, 'Subsection');
    if (subsections.length === 0) {
      const lines: Line[] = [];
      renderBlock(el, 0, lines);
      // Drop the section's own heading and number; the chunk header carries both.
      const bodyLines = lines.filter((l, i) => !(i === 0 && l.text === title));
      if (bodyLines[0]?.text.startsWith(label + ' ')) {
        bodyLines[0] = { ...bodyLines[0], text: bodyLines[0].text.slice(label.length + 1) };
      }
      parts.push({ ref: label, lines: bodyLines });
    } else {
      for (const sub of subsections) {
        const subLabel = squash(childElements(sub, 'Label').map(inlineText).join(' '));
        const lines: Line[] = [];
        renderBlock(sub, 0, lines);
        parts.push({ ref: label + subLabel, lines });
      }
    }

    const wholeText = parts.map((p) => renderLines(p.lines)).join(' ');
    if (/^\[Repealed[^\]]*\]$/.test(squash(wholeText))) {
      repealedSkipped++;
      continue;
    }

    // Split any subsection too long for one chunk, then pack them in order.
    const pieces: Part[] = parts.flatMap((p) =>
      splitLines(p.lines, maxWords).map((lines) => ({ ref: p.ref, lines })),
    );
    const context = headings.filter(Boolean).join(' › ');
    packParts(pieces, maxWords).forEach((group, i) => {
      const first = group[0].ref;
      const last = group[group.length - 1].ref;
      const ref = first === last ? `s. ${first}` : `s. ${first} to ${last}`;
      const header =
        `Income Tax Act (Canada), section ${label}${title ? ': ' + title : ''}\n` +
        (context ? `${context}\n` : '') +
        `Provisions: ${ref}`;
      chunks.push({
        id: `ita:${label}:${i}`,
        text: `${header}\n\n${group.map((p) => renderLines(p.lines)).join('\n')}`,
        source: 'ita',
        title: title || `Section ${label}`,
        ref,
        section: label,
        url: `${ITA_SECTION_URL}${label}.html`,
        asOf: currentTo,
      });
    });
  }

  return { chunks, currentTo, lastAmended, sections, repealedSkipped };
}
