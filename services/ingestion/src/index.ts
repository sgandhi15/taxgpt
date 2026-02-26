import { ChromaClient } from 'chromadb';
import neo4j from 'neo4j-driver';
import path from 'path';
import fs from 'fs';
import { parseCSV, type TaxRecord } from './parsers/csv.js';
import { parsePDF } from './parsers/pdf.js';
import { parsePPT } from './parsers/ppt.js';
import { chunkText, type Chunk } from './chunker.js';
import { pushToVectorStore, checkIfIngested } from './vectorStore.js';
import { pushToGraphStore } from './graphStore.js';

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password123';
const DATA_DIR = process.env.DATA_DIR || findDataDir();

function findDataDir(): string {
  const candidates = [
    path.join(process.cwd(), 'data'),
    path.resolve(process.cwd(), '../../data'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForChromaDB(retries = 30, delayMs = 2000): Promise<void> {
  const client = new ChromaClient({ path: CHROMA_URL });
  for (let i = 0; i < retries; i++) {
    try {
      await client.heartbeat();
      console.log('ChromaDB is ready.');
      return;
    } catch {
      console.log(`Waiting for ChromaDB... (${i + 1}/${retries})`);
      await sleep(delayMs);
    }
  }
  throw new Error(`ChromaDB not ready after ${retries} attempts`);
}

async function waitForNeo4j(retries = 30, delayMs = 2000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    const driver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    );
    try {
      await driver.verifyConnectivity();
      console.log('Neo4j is ready.');
      await driver.close();
      return;
    } catch {
      await driver.close();
      console.log(`Waiting for Neo4j... (${i + 1}/${retries})`);
      await sleep(delayMs);
    }
  }
  throw new Error(`Neo4j not ready after ${retries} attempts`);
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function createCSVChunks(records: TaxRecord[], source: string): Chunk[] {
  const chunks: Chunk[] = [];
  const ROWS_PER_CHUNK = 10;

  for (let i = 0; i < records.length; i += ROWS_PER_CHUNK) {
    const batch = records.slice(i, i + ROWS_PER_CHUNK);
    const text = batch
      .map(
        (r) =>
          `${r.taxpayerType} in ${r.state} (${r.taxYear}): ` +
          `Income ${formatMoney(r.income)}, Deductions ${formatMoney(r.deductions)}, ` +
          `Taxable Income ${formatMoney(r.taxableIncome)}, ` +
          `Tax Rate ${(r.taxRate * 100).toFixed(1)}%, Tax Owed ${formatMoney(r.taxOwed)}. ` +
          `Source: ${r.incomeSource}, Deduction: ${r.deductionType}.`,
      )
      .join('\n');

    chunks.push({ id: `${source}-batch-${i}`, content: text, source });
  }

  chunks.push(...createSummaryChunks(records, source));
  return chunks;
}

function createSummaryChunks(records: TaxRecord[], source: string): Chunk[] {
  const chunks: Chunk[] = [];

  const byType = groupBy(records, (r) => r.taxpayerType);
  for (const [type, recs] of byType) {
    const s = stats(recs);
    chunks.push({
      id: `${source}-summary-type-${type}`,
      content:
        `Summary for ${type} taxpayers (${recs.length} records):\n` +
        `Average Income: ${formatMoney(s.avgIncome)}, Total Income: ${formatMoney(s.totalIncome)}\n` +
        `Average Deductions: ${formatMoney(s.avgDeductions)}\n` +
        `Average Taxable Income: ${formatMoney(s.avgTaxableIncome)}\n` +
        `Average Tax Rate: ${(s.avgTaxRate * 100).toFixed(1)}%\n` +
        `Average Tax Owed: ${formatMoney(s.avgTaxOwed)}, Total Tax Owed: ${formatMoney(s.totalTaxOwed)}\n` +
        `States: ${[...new Set(recs.map((r) => r.state))].join(', ')}\n` +
        `Income Sources: ${[...new Set(recs.map((r) => r.incomeSource))].join(', ')}\n` +
        `Tax Years: ${[...new Set(recs.map((r) => r.taxYear))].sort().join(', ')}`,
      source,
    });
  }

  const byState = groupBy(records, (r) => r.state);
  for (const [state, recs] of byState) {
    const s = stats(recs);
    chunks.push({
      id: `${source}-summary-state-${state}`,
      content:
        `Tax data summary for state ${state} (${recs.length} records):\n` +
        `Average Income: ${formatMoney(s.avgIncome)}, Total Income: ${formatMoney(s.totalIncome)}\n` +
        `Average Tax Owed: ${formatMoney(s.avgTaxOwed)}, Total Tax Owed: ${formatMoney(s.totalTaxOwed)}\n` +
        `Taxpayer Types: ${[...new Set(recs.map((r) => r.taxpayerType))].join(', ')}\n` +
        `Tax Years: ${[...new Set(recs.map((r) => r.taxYear))].sort().join(', ')}`,
      source,
    });
  }

  const byYear = groupBy(records, (r) => String(r.taxYear));
  for (const [year, recs] of byYear) {
    const s = stats(recs);
    chunks.push({
      id: `${source}-summary-year-${year}`,
      content:
        `Tax data summary for year ${year} (${recs.length} records):\n` +
        `Total Income: ${formatMoney(s.totalIncome)}, Average Income: ${formatMoney(s.avgIncome)}\n` +
        `Total Tax Owed: ${formatMoney(s.totalTaxOwed)}, Average Tax Owed: ${formatMoney(s.avgTaxOwed)}\n` +
        `States: ${[...new Set(recs.map((r) => r.state))].join(', ')}\n` +
        `Taxpayer Types: ${[...new Set(recs.map((r) => r.taxpayerType))].join(', ')}`,
      source,
    });
  }

  const overall = stats(records);
  chunks.push({
    id: `${source}-overall-summary`,
    content:
      `Overall tax data summary (${records.length} total records):\n` +
      `Total Income: ${formatMoney(overall.totalIncome)}, Average Income: ${formatMoney(overall.avgIncome)}\n` +
      `Total Deductions: ${formatMoney(overall.totalDeductions)}, Average Deductions: ${formatMoney(overall.avgDeductions)}\n` +
      `Total Tax Owed: ${formatMoney(overall.totalTaxOwed)}, Average Tax Owed: ${formatMoney(overall.avgTaxOwed)}\n` +
      `Average Tax Rate: ${(overall.avgTaxRate * 100).toFixed(1)}%\n` +
      `Taxpayer Types: ${[...new Set(records.map((r) => r.taxpayerType))].join(', ')}\n` +
      `States: ${[...new Set(records.map((r) => r.state))].join(', ')}\n` +
      `Tax Years: ${[...new Set(records.map((r) => r.taxYear))].sort().join(', ')}\n` +
      `Income Sources: ${[...new Set(records.map((r) => r.incomeSource))].join(', ')}\n` +
      `Deduction Types: ${[...new Set(records.map((r) => r.deductionType))].join(', ')}`,
    source,
  });

  return chunks;
}

function groupBy<T>(arr: T[], fn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const key = fn(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

function stats(recs: TaxRecord[]) {
  const n = recs.length;
  const totalIncome = recs.reduce((s, r) => s + r.income, 0);
  const totalDeductions = recs.reduce((s, r) => s + r.deductions, 0);
  const totalTaxOwed = recs.reduce((s, r) => s + r.taxOwed, 0);
  const totalTaxableIncome = recs.reduce((s, r) => s + r.taxableIncome, 0);
  const avgTaxRate = recs.reduce((s, r) => s + r.taxRate, 0) / n;
  return {
    totalIncome,
    avgIncome: totalIncome / n,
    totalDeductions,
    avgDeductions: totalDeductions / n,
    totalTaxableIncome,
    avgTaxableIncome: totalTaxableIncome / n,
    totalTaxOwed,
    avgTaxOwed: totalTaxOwed / n,
    avgTaxRate,
  };
}

async function runPipeline(): Promise<void> {
  console.log('Starting ingestion pipeline...');

  const allChunks: Chunk[] = [];
  let allRecords: TaxRecord[] = [];

  const files = fs.readdirSync(DATA_DIR);

  const csvFiles = files.filter((f) => f.endsWith('.csv'));
  for (const file of csvFiles) {
    console.log(`Parsing CSV: ${file}...`);
    const records = await parseCSV(path.join(DATA_DIR, file));
    allRecords = allRecords.concat(records);
    const csvChunks = createCSVChunks(records, file);
    allChunks.push(...csvChunks);
    console.log(
      `  ${records.length} rows → ${csvChunks.length} chunks`,
    );
  }

  const MAX_PDF_CHARS = 600_000;
  const pdfFiles = files.filter((f) => f.endsWith('.pdf'));
  for (const file of pdfFiles) {
    console.log(`Parsing PDF: ${file}...`);
    try {
      const result = await parsePDF(path.join(DATA_DIR, file));
      let text = result.text;
      if (text.length > MAX_PDF_CHARS) {
        console.log(
          `  Truncating ${file} from ${text.length} to ${MAX_PDF_CHARS} chars (${result.numpages} pages)`,
        );
        text = text.slice(0, MAX_PDF_CHARS);
      }
      const pdfChunks = chunkText(text, file, { chunkSize: 800, overlap: 100 });
      allChunks.push(...pdfChunks);
      console.log(
        `  ${result.numpages} pages → ${pdfChunks.length} chunks`,
      );
    } catch (err) {
      console.warn(`  Failed to parse ${file}:`, err);
    }
  }

  const pptFiles = files.filter((f) => /\.pptx?$/i.test(f));
  for (const file of pptFiles) {
    console.log(`Parsing PPT: ${file}...`);
    try {
      const text = await parsePPT(path.join(DATA_DIR, file));
      const pptChunks = chunkText(text, file);
      allChunks.push(...pptChunks);
      console.log(`  → ${pptChunks.length} chunks`);
    } catch (err) {
      console.warn(`  Failed to parse ${file}:`, err);
    }
  }

  console.log(`Total chunks to ingest: ${allChunks.length}`);

  console.log('Pushing to vector store...');
  await pushToVectorStore(allChunks);
  console.log('Vector store updated.');

  if (allRecords.length > 0) {
    console.log('Pushing to graph store...');
    await pushToGraphStore(allRecords);
    console.log('Graph store updated.');
  }

  console.log('Ingestion complete.');
}

async function main() {
  console.log('Waiting for services...');
  await Promise.all([waitForChromaDB(), waitForNeo4j()]);

  const alreadyIngested = await checkIfIngested();
  if (alreadyIngested) {
    console.log('Data already ingested, skipping. Delete the ChromaDB volume to re-ingest.');
    process.exit(0);
  }

  await runPipeline();
  process.exit(0);
}

main().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
