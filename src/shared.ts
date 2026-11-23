// Shared by the Worker and scripts/ingest.ts. Questions and documents must be
// embedded by the same model, so both sides read it from here.
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const EMBEDDING_DIMENSIONS = 1024;
export const INDEX_NAME = 'taxgpt';

// Stored with every vector. `section` has a Vectorize metadata index, so a
// question that names a section can be answered from that section's chunks.
export interface ChunkMetadata {
  text: string;
  source: 'ita' | 'cra';
  /** Section heading (Act) or page title (CRA). */
  title: string;
  /** How to cite it, e.g. "s. 118.2(1) to 118.2(2)". Empty for CRA pages. */
  ref: string;
  /** Act section number, e.g. "118.2". Empty for CRA pages. */
  section: string;
  url: string;
  /** Date the source was current to (Act) or last modified (CRA), YYYY-MM-DD. */
  asOf: string;
}
