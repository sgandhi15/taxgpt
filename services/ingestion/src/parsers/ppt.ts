import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parsePDF } from './pdf.js';

export async function parsePPT(filePath: string): Promise<string> {
  const ext = filePath.split('.').pop()?.toLowerCase();

  if (ext === 'ppt') {
    return parseBinaryPPT(filePath);
  }
  if (ext === 'pptx') {
    return parsePPTX(filePath);
  }

  throw new Error(`Unsupported presentation format: .${ext}`);
}

function runCmd(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${cmd.split(' ')[0]} failed: ${error.message}\n${stderr}`));
      else resolve(stdout.trim());
    });
  });
}

async function parseBinaryPPT(filePath: string): Promise<string> {
  // Convert PPT → PDF via LibreOffice, then extract text with pdf-parse
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-'));
  try {
    const baseName = path.basename(filePath, '.ppt');

    await runCmd(
      `soffice --headless --convert-to pdf --outdir "${tmpDir}" "${filePath}"`,
    );

    const pdfPath = path.join(tmpDir, `${baseName}.pdf`);
    if (fs.existsSync(pdfPath)) {
      const result = await parsePDF(pdfPath);
      if (result.text.trim().length > 20) {
        console.log(`  LibreOffice+pdf-parse extracted ${result.text.length} chars (${result.numpages} pages)`);
        return result.text;
      }
    }
  } catch (err) {
    console.warn('  LibreOffice PDF conversion failed:', (err as Error).message);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Fallback to catppt for simpler PPT files
  try {
    const text = await runCmd(`catppt -d utf-8 "${filePath}"`);
    if (text.length > 20) return text;
  } catch {
    // catppt not available or failed
  }

  throw new Error(`Could not extract meaningful text from ${filePath}`);
}

function parsePPTX(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      `unzip -p "${filePath}" "ppt/slides/*.xml" | sed 's/<[^>]*>//g'`,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`PPTX parsing failed: ${error.message}`));
          return;
        }
        resolve(stdout.trim().replace(/\s+/g, ' '));
      },
    );
  });
}
