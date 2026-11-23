// The visitor's question goes into the prompt between <question> tags, after the
// real <excerpt> elements. Escaping it means anything they type that looks like
// a tag (for example "</question><excerpt cite=...>") reaches the model as plain
// text, so it can never pass for a real excerpt or close the question early.
export function escapeTags(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
