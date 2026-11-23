// Packing rules shared by the Act and CRA parsers.

export interface Line {
  /** Nesting level: 0 for a subsection, 1 for its paragraphs, and so on. */
  depth: number;
  text: string;
}

export interface Chunk {
  id: string;
  /** Text that is embedded and shown to the model. */
  text: string;
  source: 'ita' | 'cra';
  title: string;
  ref: string;
  section: string;
  url: string;
  asOf: string;
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function renderLines(lines: Line[]): string {
  return lines.map((l) => '  '.repeat(l.depth) + l.text).join('\n');
}

function linesWords(lines: Line[]): number {
  return lines.reduce((n, l) => n + countWords(l.text), 0);
}

function truncateWords(text: string, max: number): string {
  const words = text.split(/\s+/);
  return words.length <= max ? text : words.slice(0, max).join(' ') + ' […]';
}

/** Splits one over-long line into word windows. */
function splitLongLine(line: Line, maxWords: number): Line[] {
  const words = line.text.split(/\s+/);
  const out: Line[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    out.push({ depth: line.depth, text: words.slice(i, i + maxWords).join(' ') });
  }
  return out;
}

/**
 * Splits a block of lines into pieces of at most `maxWords` words.
 *
 * A piece never ends inside a direct child of the block unless that child is
 * itself too long. Every piece after the first starts with the block's opening
 * line (shortened), because a paragraph such as "(c) the amount by which…" means
 * little without the "(1) There may be deducted…" it hangs from.
 */
export function splitLines(lines: Line[], maxWords: number): Line[][] {
  if (lines.length === 0) return [];
  if (linesWords(lines) <= maxWords) return [lines];

  const baseDepth = Math.min(...lines.map((l) => l.depth));
  const leadIn: Line = { depth: lines[0].depth, text: truncateWords(lines[0].text, 40) };
  const budget = Math.max(50, maxWords - countWords(leadIn.text));

  // Group each direct child with its descendants.
  const groups: Line[][] = [];
  for (const line of lines) {
    if (line.depth <= baseDepth + 1 || groups.length === 0) groups.push([line]);
    else groups[groups.length - 1].push(line);
  }

  // Break up any group that is too long on its own.
  const units: Line[][] = [];
  for (const group of groups) {
    if (linesWords(group) <= budget) {
      units.push(group);
    } else if (group.length > 1 && groups.length > 1) {
      units.push(...splitLines(group, budget));
    } else {
      for (const line of group) {
        if (countWords(line.text) <= budget) units.push([line]);
        else units.push(...splitLongLine(line, budget).map((l) => [l]));
      }
    }
  }

  const pieces: Line[][] = [];
  let current: Line[] = [];
  let words = 0;
  for (const unit of units) {
    const w = linesWords(unit);
    if (current.length > 0 && words + w > budget) {
      pieces.push(current);
      current = [];
      words = 0;
    }
    current.push(...unit);
    words += w;
  }
  if (current.length > 0) pieces.push(current);

  return pieces.map((piece, i) => (i === 0 || piece[0] === lines[0] ? piece : [leadIn, ...piece]));
}

export interface Part {
  ref: string;
  lines: Line[];
}

/** Packs consecutive parts into groups of at most `maxWords` words. */
export function packParts(parts: Part[], maxWords: number): Part[][] {
  const out: Part[][] = [];
  let current: Part[] = [];
  let words = 0;
  for (const part of parts) {
    const w = linesWords(part.lines);
    if (current.length > 0 && words + w > maxWords) {
      out.push(current);
      current = [];
      words = 0;
    }
    current.push(part);
    words += w;
  }
  if (current.length > 0) out.push(current);
  return out;
}
