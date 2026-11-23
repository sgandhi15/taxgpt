import { describe, expect, it } from 'vitest';
import { parseIta } from '../scripts/lib/ita';

const XML = `<?xml version="1.0" encoding="utf-8"?>
<Statute xmlns:lims="http://justice.gc.ca/lims" lims:current-date="2026-10-29" lims:lastAmendedDate="2026-06-18">
  <Identification><ShortTitle>Income Tax Act</ShortTitle></Identification>
  <Body>
    <Heading level="1"><Label>PART I</Label><TitleText>Income Tax</TitleText></Heading>
    <Heading level="2"><Label>DIVISION E</Label><TitleText>Computation of Tax</TitleText></Heading>
    <Section>
      <MarginalNote>Medical expense credit</MarginalNote><Label>118.2</Label>
      <Subsection><Label>(1)</Label><Text>There may be deducted the amount determined by the formula</Text>
        <FormulaGroup><Formula><FormulaText>A × B</FormulaText></Formula><FormulaConnector>where</FormulaConnector>
          <FormulaDefinition><FormulaTerm>A</FormulaTerm><Text>is the appropriate percentage;</Text></FormulaDefinition>
        </FormulaGroup>
      </Subsection>
      <Subsection><MarginalNote>Medical expenses</MarginalNote><Label>(2)</Label><Text>A medical expense is an amount paid</Text>
        <Paragraph><Label>(a)</Label><Text>to a <DefinedTermEn>medical practitioner</DefinedTermEn>;</Text></Paragraph>
      </Subsection>
      <HistoricalNote><HistoricalNoteSubItem>R.S., 1985, c. 1</HistoricalNoteSubItem></HistoricalNote>
    </Section>
    <Section><Label>119</Label><Text><Repealed>[Repealed, 2013, c. 34, s. 3]</Repealed></Text></Section>
    <Heading level="2"><Label>DIVISION F</Label><TitleText>Special Rules</TitleText></Heading>
    <Section><MarginalNote>Short rule</MarginalNote><Label>120</Label><Text>This rule has no subsections.</Text></Section>
  </Body>
</Statute>`;

describe('parseIta', () => {
  const result = parseIta(XML, 400);

  it('reads the consolidation dates', () => {
    expect(result.currentTo).toBe('2026-10-29');
    expect(result.lastAmended).toBe('2026-06-18');
  });

  it('makes one chunk per section and skips repealed ones', () => {
    expect(result.chunks.map((c) => c.id)).toEqual(['ita:118.2:0', 'ita:120:0']);
    expect(result.repealedSkipped).toBe(1);
  });

  it('labels each chunk with its section, citation, heading path and link', () => {
    const chunk = result.chunks[0];
    expect(chunk.section).toBe('118.2');
    expect(chunk.title).toBe('Medical expense credit');
    expect(chunk.ref).toBe('s. 118.2(1) to 118.2(2)');
    expect(chunk.url).toBe('https://laws-lois.justice.gc.ca/eng/acts/I-3.3/section-118.2.html');
    expect(chunk.asOf).toBe('2026-10-29');
    expect(chunk.text).toContain('Income Tax Act (Canada), section 118.2: Medical expense credit');
    expect(chunk.text).toContain('PART I — Income Tax › DIVISION E — Computation of Tax');
  });

  it('renders provisions as indented lines with readable formulas', () => {
    const text = result.chunks[0].text;
    expect(text).toContain('(1) There may be deducted the amount determined by the formula');
    expect(text).toContain('A × B where');
    expect(text).toContain('A is the appropriate percentage;');
    expect(text).toContain('Medical expenses\n(2) A medical expense is an amount paid\n  (a) to a medical practitioner;');
    expect(text).not.toContain('R.S., 1985');
  });

  it('tracks the heading path as divisions change', () => {
    const chunk = result.chunks[1];
    expect(chunk.ref).toBe('s. 120');
    expect(chunk.text).toContain('PART I — Income Tax › DIVISION F — Special Rules');
    expect(chunk.text).toContain('\n\nThis rule has no subsections.');
  });

  it('rejects a file that is not a statute', () => {
    expect(() => parseIta('<html></html>', 400)).toThrow(/Not a Justice Laws statute/);
  });
});
