/**
 * Finds Act section numbers a question names outright, e.g. "section 118.2",
 * "s. 146(1)", "paragraph 20(1)(c)" → ["118.2", "146", "20"].
 */
export function extractSectionRefs(question: string): string[] {
  const pattern =
    /\b(?:sections?|subsections?|paragraphs?|subparagraphs?|sec\.?|ss?\.)\s*(\d{1,3}(?:\.\d{1,3}){0,2})(?![\d%])/gi;
  const refs = new Set<string>();
  for (const match of question.matchAll(pattern)) refs.add(match[1]);
  return [...refs];
}
