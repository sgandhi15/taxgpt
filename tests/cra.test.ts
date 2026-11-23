import { describe, expect, it } from 'vitest';
import { extractLinks, parseCraPage } from '../scripts/lib/cra';

const row = (n: number) => `<tr><td>${n}</td><td>${Array(20).fill('amount').join(' ')}</td></tr>`;
const HTML = `<html><head><title>Line 21900 – Moving expenses - Canada.ca</title>
<meta name="dcterms.modified" content="2026-01-20"></head><body>
<nav><a href="/en/skip.html">Skip</a></nav>
<main>
  <h1>Line 21900 – Moving expenses</h1>
  <p>You can claim <strong>eligible</strong> moving expenses.</p>
  <ul><li>Transportation</li><li>Storage <a href="/en/tax/moving/storage.html#details">costs</a></li></ul>
  <h2>Limits by year</h2>
  <table><tr><th>Year</th><th>Limit</th></tr>${[1, 2, 3, 4, 5, 6].map(row).join('')}</table>
  <a href="/en/other/unrelated.html">Unrelated</a>
  <section class="pagedetails"><p>Page details</p></section>
  <script>ignored()</script>
</main></body></html>`;
const URL = 'https://www.canada.ca/en/tax/moving/line-21900-moving-expenses.html';

describe('parseCraPage', () => {
  const page = parseCraPage(HTML, URL, 60);

  it('reads the title and modified date', () => {
    expect(page.title).toBe('Line 21900 – Moving expenses');
    expect(page.asOf).toBe('2026-01-20');
  });

  it('turns paragraphs, list items and table rows into lines, without page furniture', () => {
    const text = page.chunks.map((c) => c.text).join('\n');
    expect(text).toContain('You can claim eligible moving expenses.');
    expect(text).toContain('Transportation');
    expect(text).toContain('Storage costs');
    expect(text).toContain('Year | Limit');
    expect(text).not.toContain('Page details');
    expect(text).not.toContain('ignored');
  });

  it('repeats the table heading when a table is split across chunks', () => {
    expect(page.chunks.length).toBeGreaterThan(1);
    const continued = page.chunks.filter((c) => /^\d \| amount/m.test(c.text));
    expect(continued.length).toBeGreaterThan(1);
    expect(continued.every((c) => c.text.includes('Year | Limit'))).toBe(true);
  });

  it('gives chunks unique ids within the 64-byte limit', () => {
    const ids = page.chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('cra:line-21900-moving-expenses-') && id.length <= 64)).toBe(true);
  });
});

describe('extractLinks', () => {
  it('returns links under the prefix, without fragments, from the main content only', () => {
    expect(extractLinks(HTML, URL, '/en/tax/moving/')).toEqual(['https://www.canada.ca/en/tax/moving/storage.html']);
  });
});

describe('parseCraPage navigation clutter', () => {
  const html = `<html><head><title>Lines 33099 and 33199 – Eligible medical expenses - Canada.ca</title></head><body><main>
    <h1>Lines 33099 and 33199 – Eligible medical expenses</h1>
    <h2><strong>On this page</strong></h2>
    <ul><li><a href="#lgbl">Eligibility criteria</a></li><li><a href="#xpnss">Eligible expenses</a></li></ul>
    <h2 id="lgbl">Eligibility criteria</h2>
    <p>You can claim eligible medical expenses paid in any 12-month period.</p>
    <ul><li><a href="#xpnss">Eligible expenses</a> include prescription drugs.</li></ul>
    <section class="gc-contributors"><h2>From:</h2><ul><li><a href="/en/revenue-agency.html">Canada Revenue Agency</a></li></ul></section>
  </main></body></html>`;
  const page = parseCraPage(html, 'https://www.canada.ca/en/x/medical.html', 400);
  const text = page.chunks.map((c) => c.text).join('\n');

  it('drops the table of contents and its heading', () => {
    expect(text).not.toContain('On this page');
    expect(text).not.toMatch(/^- ?Eligibility criteria$/m);
    expect(page.chunks.every((c) => !c.title.includes('On this page'))).toBe(true);
  });

  it('drops the "From:" byline', () => {
    expect(text).not.toContain('From:');
    expect(page.chunks.every((c) => !c.title.includes('From:'))).toBe(true);
  });

  it('keeps real content, including list items that only start with an in-page link', () => {
    expect(text).toContain('You can claim eligible medical expenses paid in any 12-month period.');
    expect(text).toContain('Eligible expenses include prescription drugs.');
    expect(page.chunks[0].title).toBe('Lines 33099 and 33199 – Eligible medical expenses: Eligibility criteria');
  });
});

describe('parseCraPage tables', () => {
  const rates = (name: string, n: number) => `<details><summary>${name}</summary><table>
    <caption class="wb-inv">${name} rate: 2026</caption>
    <thead><tr><th colspan="2">Each portion of your taxable income</th><td></td></tr>
    <tr><th>from</th><th>up to</th><th>is taxed at</th></tr></thead>
    <tbody>${Array.from({ length: n }, (_, i) => `<tr><td>$${i}0,000</td><td>$${i + 1}0,000</td><td>${i + 4}%</td></tr>`).join('')}</tbody>
  </table></details>`;
  const html = (body: string) => `<html><head><title>Rates - Canada.ca</title></head><body><main><h1>Rates</h1>
    <p>${Array(30).fill('intro').join(' ')}</p>${body}</main></body></html>`;

  it('keeps a caption that Canada.ca hides from sighted readers', () => {
    const page = parseCraPage(html(rates('Nunavut', 3)), 'https://www.canada.ca/en/x/rates.html', 400);
    expect(page.chunks.map((c) => c.text).join('\n')).toContain('Nunavut rate: 2026');
  });

  it('moves a small table whole to the next chunk instead of splitting it', () => {
    // Each table is about 30 words; with a 70-word limit the second one cannot fit after the intro and the first.
    const page = parseCraPage(html(rates('Alberta', 3) + rates('Nunavut', 3)), 'https://www.canada.ca/en/x/rates.html', 70);
    const withNunavutRows = page.chunks.filter((c) => c.text.includes('6%') && c.text.includes('Nunavut rate'));
    expect(withNunavutRows.length).toBe(1);
    const nunavut = withNunavutRows[0].text;
    expect(nunavut.indexOf('Nunavut rate: 2026')).toBeLessThan(nunavut.indexOf('$00,000'));
  });

  it('repeats the caption and every heading row when a large table is split', () => {
    const page = parseCraPage(html(rates('Ontario', 40)), 'https://www.canada.ca/en/x/rates.html', 80);
    const parts = page.chunks.filter((c) => /\d+%/.test(c.text));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text).toContain('Ontario rate: 2026');
      expect(part.text).toContain('Each portion of your taxable income');
      expect(part.text).toContain('from | up to | is taxed at');
    }
  });
});
