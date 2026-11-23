import { describe, expect, it } from 'vitest';
import { extractSectionRefs } from '../src/sections';

describe('extractSectionRefs', () => {
  it.each([
    ['What does section 118.2 say?', ['118.2']],
    ['Explain s. 146(1) and subsection 248(1)', ['146', '248']],
    ['paragraph 20(1)(c) interest', ['20']],
    ['Sections 110.6 and section 110.6 again', ['110.6']],
    ['sec 8 deductions', ['8']],
  ])('%s', (question, expected) => {
    expect(extractSectionRefs(question)).toEqual(expected);
  });

  it.each([
    'What are the tax brackets for 2026?',
    'Is 15% the lowest rate?',
    'How much is the TFSA limit of $7,000?',
    'What rate applies to subsection income of 14%?',
  ])('finds none in: %s', (question) => {
    expect(extractSectionRefs(question)).toEqual([]);
  });
});
