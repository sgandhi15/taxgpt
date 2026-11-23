import { describe, expect, it } from 'vitest';
import { countWords, packParts, splitLines, type Line } from '../scripts/lib/chunk';

const words = (n: number, w = 'w') => Array(n).fill(w).join(' ');
const total = (lines: Line[]) => lines.reduce((n, l) => n + countWords(l.text), 0);

describe('splitLines', () => {
  it('keeps a short block whole', () => {
    const lines: Line[] = [{ depth: 0, text: '(1) Short rule.' }, { depth: 1, text: '(a) one' }];
    expect(splitLines(lines, 100)).toEqual([lines]);
  });

  it('splits between paragraphs and repeats the opening line', () => {
    const lines: Line[] = [
      { depth: 0, text: '(1) There may be deducted' },
      { depth: 1, text: `(a) ${words(60)}` },
      { depth: 2, text: `(i) ${words(20)}` },
      { depth: 1, text: `(b) ${words(60)}` },
      { depth: 1, text: `(c) ${words(60)}` },
    ];
    const pieces = splitLines(lines, 100);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece[0].text).toBe('(1) There may be deducted');
      expect(total(piece)).toBeLessThanOrEqual(100);
    }
    // A paragraph stays with its own subparagraph.
    const withA = pieces.find((p) => p.some((l) => l.text.startsWith('(a)')))!;
    expect(withA.some((l) => l.text.startsWith('(i)'))).toBe(true);
    // Nothing is lost.
    const bodies = pieces.flatMap((p) => p.filter((l) => l.depth > 0).map((l) => l.text));
    expect(bodies).toEqual(lines.slice(1).map((l) => l.text));
  });

  it('breaks up a single line that is too long', () => {
    const pieces = splitLines([{ depth: 0, text: words(500) }], 100);
    expect(pieces.length).toBeGreaterThanOrEqual(5);
    expect(pieces.every((p) => total(p) <= 100)).toBe(true);
  });
});

describe('packParts', () => {
  it('groups consecutive parts up to the limit, in order', () => {
    const parts = ['1(1)', '1(2)', '1(3)'].map((ref) => ({ ref, lines: [{ depth: 0, text: words(40) }] }));
    const groups = packParts(parts, 100);
    expect(groups.map((g) => g.map((p) => p.ref))).toEqual([['1(1)', '1(2)'], ['1(3)']]);
  });
});
