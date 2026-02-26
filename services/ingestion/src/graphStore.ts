import neo4j, { type Session } from 'neo4j-driver';
import type { TaxRecord } from './parsers/csv.js';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password123';

interface Stats {
  count: number;
  totalIncome: number;
  avgIncome: number;
  totalDeductions: number;
  avgDeductions: number;
  totalTaxableIncome: number;
  totalTaxOwed: number;
  avgTaxOwed: number;
  avgTaxRate: number;
}

function computeStats(records: TaxRecord[]): Stats {
  const n = records.length;
  const totalIncome = records.reduce((s, r) => s + r.income, 0);
  const totalDeductions = records.reduce((s, r) => s + r.deductions, 0);
  const totalTaxableIncome = records.reduce((s, r) => s + r.taxableIncome, 0);
  const totalTaxOwed = records.reduce((s, r) => s + r.taxOwed, 0);
  const avgTaxRate = records.reduce((s, r) => s + r.taxRate, 0) / n;
  return {
    count: n,
    totalIncome,
    avgIncome: totalIncome / n,
    totalDeductions,
    avgDeductions: totalDeductions / n,
    totalTaxableIncome,
    totalTaxOwed,
    avgTaxOwed: totalTaxOwed / n,
    avgTaxRate,
  };
}

function groupBy<K extends keyof TaxRecord>(
  arr: TaxRecord[],
  key: K,
): Record<string, TaxRecord[]> {
  const map: Record<string, TaxRecord[]> = {};
  for (const item of arr) {
    const k = String(item[key]);
    (map[k] ??= []).push(item);
  }
  return map;
}

function groupByTwo<K1 extends keyof TaxRecord, K2 extends keyof TaxRecord>(
  arr: TaxRecord[],
  k1: K1,
  k2: K2,
): Record<string, TaxRecord[]> {
  const map: Record<string, TaxRecord[]> = {};
  for (const item of arr) {
    const key = `${String(item[k1])}|${String(item[k2])}`;
    (map[key] ??= []).push(item);
  }
  return map;
}

export async function pushToGraphStore(records: TaxRecord[]): Promise<void> {
  const driver = neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
  );
  const session = driver.session();

  try {
    await session.run('MATCH (n) DETACH DELETE n');

    await createDimensionNodes(session, records);
    await createRelationships(session, records);

    console.log('Graph store populated.');
  } finally {
    await session.close();
    await driver.close();
  }
}

async function createDimensionNodes(
  session: Session,
  records: TaxRecord[],
): Promise<void> {
  for (const [name, recs] of Object.entries(groupBy(records, 'taxpayerType'))) {
    const s = computeStats(recs);
    await session.run(
      `CREATE (:TaxpayerType {
        name: $name, record_count: $count,
        total_income: $totalIncome, avg_income: $avgIncome,
        total_deductions: $totalDeductions, avg_deductions: $avgDeductions,
        total_tax_owed: $totalTaxOwed, avg_tax_owed: $avgTaxOwed,
        avg_tax_rate: $avgTaxRate
      })`,
      { name, ...s },
    );
  }

  for (const [name, recs] of Object.entries(groupBy(records, 'state'))) {
    const s = computeStats(recs);
    await session.run(
      `CREATE (:State {
        name: $name, record_count: $count,
        total_income: $totalIncome, avg_income: $avgIncome,
        total_tax_owed: $totalTaxOwed, avg_tax_owed: $avgTaxOwed
      })`,
      { name, ...s },
    );
  }

  for (const [yearStr, recs] of Object.entries(groupBy(records, 'taxYear'))) {
    const s = computeStats(recs);
    await session.run(
      `CREATE (:TaxYear {
        year: $year, record_count: $count,
        total_income: $totalIncome, avg_income: $avgIncome,
        total_tax_owed: $totalTaxOwed, avg_tax_owed: $avgTaxOwed
      })`,
      { year: neo4j.int(parseInt(yearStr)), ...s },
    );
  }

  for (const [name, recs] of Object.entries(groupBy(records, 'incomeSource'))) {
    const s = computeStats(recs);
    await session.run(
      `CREATE (:IncomeSource {
        name: $name, record_count: $count,
        total_income: $totalIncome, avg_income: $avgIncome
      })`,
      { name, ...s },
    );
  }

  for (const [name, recs] of Object.entries(groupBy(records, 'deductionType'))) {
    const s = computeStats(recs);
    await session.run(
      `CREATE (:DeductionType {
        name: $name, record_count: $count,
        total_deductions: $totalDeductions, avg_deductions: $avgDeductions
      })`,
      { name, ...s },
    );
  }
}

async function createRelationships(
  session: Session,
  records: TaxRecord[],
): Promise<void> {
  for (const [key, recs] of Object.entries(
    groupByTwo(records, 'taxpayerType', 'state'),
  )) {
    const [type, state] = key.split('|');
    const s = computeStats(recs);
    await session.run(
      `MATCH (t:TaxpayerType {name: $type}), (st:State {name: $state})
       CREATE (t)-[:OPERATES_IN {
         record_count: $count, total_income: $totalIncome, avg_income: $avgIncome,
         total_tax_owed: $totalTaxOwed, avg_tax_owed: $avgTaxOwed
       }]->(st)`,
      { type, state, ...s },
    );
  }

  for (const [key, recs] of Object.entries(
    groupByTwo(records, 'taxpayerType', 'taxYear'),
  )) {
    const [type, yearStr] = key.split('|');
    const s = computeStats(recs);
    await session.run(
      `MATCH (t:TaxpayerType {name: $type}), (y:TaxYear {year: $year})
       CREATE (t)-[:ACTIVE_IN_YEAR {
         record_count: $count, total_income: $totalIncome, avg_income: $avgIncome,
         total_tax_owed: $totalTaxOwed, avg_tax_owed: $avgTaxOwed
       }]->(y)`,
      { type, year: neo4j.int(parseInt(yearStr)), ...s },
    );
  }

  for (const [key, recs] of Object.entries(
    groupByTwo(records, 'incomeSource', 'taxpayerType'),
  )) {
    const [source, type] = key.split('|');
    const s = computeStats(recs);
    await session.run(
      `MATCH (i:IncomeSource {name: $source}), (t:TaxpayerType {name: $type})
       CREATE (i)-[:EARNED_BY {
         record_count: $count, total_income: $totalIncome, avg_income: $avgIncome
       }]->(t)`,
      { source, type, ...s },
    );
  }

  for (const [key, recs] of Object.entries(
    groupByTwo(records, 'deductionType', 'taxpayerType'),
  )) {
    const [deduction, type] = key.split('|');
    const s = computeStats(recs);
    await session.run(
      `MATCH (d:DeductionType {name: $deduction}), (t:TaxpayerType {name: $type})
       CREATE (d)-[:CLAIMED_BY {
         record_count: $count, total_deductions: $totalDeductions, avg_deductions: $avgDeductions
       }]->(t)`,
      { deduction, type, ...s },
    );
  }

  for (const [key, recs] of Object.entries(
    groupByTwo(records, 'state', 'taxYear'),
  )) {
    const [state, yearStr] = key.split('|');
    const s = computeStats(recs);
    await session.run(
      `MATCH (st:State {name: $state}), (y:TaxYear {year: $year})
       CREATE (st)-[:HAS_RECORDS_IN {
         record_count: $count, total_income: $totalIncome,
         total_tax_owed: $totalTaxOwed
       }]->(y)`,
      { state, year: neo4j.int(parseInt(yearStr)), ...s },
    );
  }
}
