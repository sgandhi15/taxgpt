import fs from 'fs';
import pdf from 'pdf-parse';

export interface PDFParseResult {
  text: string;
  numpages: number;
  info: Record<string, unknown>;
}

export async function parsePDF(filePath: string): Promise<PDFParseResult> {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdf(dataBuffer);
  
  return {
    text: data.text,
    numpages: data.numpages,
    info: data.info,
  };
}
