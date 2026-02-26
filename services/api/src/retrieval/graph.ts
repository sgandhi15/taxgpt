import neo4j from 'neo4j-driver';

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password123';

export interface GraphResult {
  relationships: string[];
}

const TAXPAYER_TYPES: Record<string, string> = {
  individual: 'Individual',
  individuals: 'Individual',
  corporation: 'Corporation',
  corporations: 'Corporation',
  corporate: 'Corporation',
  partnership: 'Partnership',
  partnerships: 'Partnership',
  trust: 'Trust',
  trusts: 'Trust',
  'non-profit': 'Non-Profit',
  nonprofit: 'Non-Profit',
  'non profit': 'Non-Profit',
  nonprofits: 'Non-Profit',
};

const STATE_MAP: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
};

const ALL_STATE_ABBREVS = new Set(Object.values(STATE_MAP));

const INCOME_SOURCES: Record<string, string> = {
  salary: 'Salary',
  salaries: 'Salary',
  investment: 'Investment',
  investments: 'Investment',
  'capital gains': 'Capital Gains',
  'capital gain': 'Capital Gains',
  rental: 'Rental',
  rent: 'Rental',
  'business income': 'Business Income',
  royalties: 'Royalties',
  royalty: 'Royalties',
};

const DEDUCTION_TYPES: Record<string, string> = {
  'charitable contributions': 'Charitable Contributions',
  charitable: 'Charitable Contributions',
  charity: 'Charitable Contributions',
  'mortgage interest': 'Mortgage Interest',
  mortgage: 'Mortgage Interest',
  'education expenses': 'Education Expenses',
  education: 'Education Expenses',
  'medical expenses': 'Medical Expenses',
  medical: 'Medical Expenses',
  'business expenses': 'Business Expenses',
};

interface ExtractedEntities {
  taxpayerTypes: string[];
  states: string[];
  years: number[];
  incomeSources: string[];
  deductionTypes: string[];
}

function extractEntities(query: string): ExtractedEntities {
  const q = query.toLowerCase();

  const taxpayerTypes = [
    ...new Set(
      Object.entries(TAXPAYER_TYPES)
        .filter(([key]) => q.includes(key))
        .map(([, val]) => val),
    ),
  ];

  const states: string[] = [];
  for (const [name, abbrev] of Object.entries(STATE_MAP)) {
    if (q.includes(name)) states.push(abbrev);
  }
  const words = q.toUpperCase().split(/\s+/);
  for (const w of words) {
    if (ALL_STATE_ABBREVS.has(w) && !states.includes(w)) states.push(w);
  }

  const years: number[] = [];
  const yearMatches = q.match(/\b(20[12]\d)\b/g);
  if (yearMatches) {
    for (const m of yearMatches) {
      const y = parseInt(m);
      if (y >= 2019 && y <= 2025) years.push(y);
    }
  }

  const incomeSources = [
    ...new Set(
      Object.entries(INCOME_SOURCES)
        .filter(([key]) => q.includes(key))
        .map(([, val]) => val),
    ),
  ];

  const deductionTypes = [
    ...new Set(
      Object.entries(DEDUCTION_TYPES)
        .filter(([key]) => q.includes(key))
        .map(([, val]) => val),
    ),
  ];

  return { taxpayerTypes, states, years, incomeSources, deductionTypes };
}

function toNum(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val && typeof (val as any).toNumber === 'function')
    return (val as any).toNumber();
  return parseFloat(String(val)) || 0;
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

export async function queryGraphStore(query: string): Promise<GraphResult> {
  const driver = neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
  );
  const session = driver.session();

  try {
    const ent = extractEntities(query);
    const lines: string[] = [];

    if (ent.taxpayerTypes.length > 0 && ent.states.length > 0) {
      const res = await session.run(
        `MATCH (t:TaxpayerType)-[r:OPERATES_IN]->(s:State)
         WHERE t.name IN $types AND s.name IN $states
         RETURN t.name AS type, s.name AS state,
                r.record_count AS cnt, r.avg_income AS avgInc,
                r.total_income AS totInc, r.avg_tax_owed AS avgTax,
                r.total_tax_owed AS totTax`,
        { types: ent.taxpayerTypes, states: ent.states },
      );
      for (const rec of res.records) {
        lines.push(
          `${rec.get('type')} in ${rec.get('state')}: ` +
            `${toNum(rec.get('cnt'))} records, ` +
            `Avg Income: ${fmtMoney(toNum(rec.get('avgInc')))}, ` +
            `Total Income: ${fmtMoney(toNum(rec.get('totInc')))}, ` +
            `Avg Tax Owed: ${fmtMoney(toNum(rec.get('avgTax')))}, ` +
            `Total Tax Owed: ${fmtMoney(toNum(rec.get('totTax')))}`,
        );
      }
    }

    if (ent.taxpayerTypes.length > 0 && ent.years.length > 0) {
      const res = await session.run(
        `MATCH (t:TaxpayerType)-[r:ACTIVE_IN_YEAR]->(y:TaxYear)
         WHERE t.name IN $types AND y.year IN $years
         RETURN t.name AS type, y.year AS year,
                r.record_count AS cnt, r.avg_income AS avgInc,
                r.total_income AS totInc, r.avg_tax_owed AS avgTax,
                r.total_tax_owed AS totTax`,
        { types: ent.taxpayerTypes, years: ent.years.map((y) => neo4j.int(y)) },
      );
      for (const rec of res.records) {
        lines.push(
          `${rec.get('type')} in ${toNum(rec.get('year'))}: ` +
            `${toNum(rec.get('cnt'))} records, ` +
            `Avg Income: ${fmtMoney(toNum(rec.get('avgInc')))}, ` +
            `Total Income: ${fmtMoney(toNum(rec.get('totInc')))}, ` +
            `Avg Tax Owed: ${fmtMoney(toNum(rec.get('avgTax')))}, ` +
            `Total Tax Owed: ${fmtMoney(toNum(rec.get('totTax')))}`,
        );
      }
    }

    if (
      ent.taxpayerTypes.length > 0 &&
      ent.states.length === 0 &&
      ent.years.length === 0
    ) {
      const res = await session.run(
        `MATCH (t:TaxpayerType)
         WHERE t.name IN $types
         RETURN t.name AS name, t.record_count AS cnt,
                t.total_income AS totInc, t.avg_income AS avgInc,
                t.total_deductions AS totDed, t.avg_deductions AS avgDed,
                t.total_tax_owed AS totTax, t.avg_tax_owed AS avgTax,
                t.avg_tax_rate AS avgRate`,
        { types: ent.taxpayerTypes },
      );
      for (const rec of res.records) {
        lines.push(
          `${rec.get('name')}: ${toNum(rec.get('cnt'))} records, ` +
            `Avg Income: ${fmtMoney(toNum(rec.get('avgInc')))}, ` +
            `Total Income: ${fmtMoney(toNum(rec.get('totInc')))}, ` +
            `Avg Deductions: ${fmtMoney(toNum(rec.get('avgDed')))}, ` +
            `Avg Tax Rate: ${(toNum(rec.get('avgRate')) * 100).toFixed(1)}%, ` +
            `Avg Tax Owed: ${fmtMoney(toNum(rec.get('avgTax')))}, ` +
            `Total Tax Owed: ${fmtMoney(toNum(rec.get('totTax')))}`,
        );
      }
    }

    if (ent.states.length > 0 && ent.taxpayerTypes.length === 0) {
      const res = await session.run(
        `MATCH (s:State)
         WHERE s.name IN $states
         RETURN s.name AS name, s.record_count AS cnt,
                s.total_income AS totInc, s.avg_income AS avgInc,
                s.total_tax_owed AS totTax, s.avg_tax_owed AS avgTax`,
        { states: ent.states },
      );
      for (const rec of res.records) {
        lines.push(
          `State ${rec.get('name')}: ${toNum(rec.get('cnt'))} records, ` +
            `Avg Income: ${fmtMoney(toNum(rec.get('avgInc')))}, ` +
            `Total Income: ${fmtMoney(toNum(rec.get('totInc')))}, ` +
            `Avg Tax Owed: ${fmtMoney(toNum(rec.get('avgTax')))}, ` +
            `Total Tax Owed: ${fmtMoney(toNum(rec.get('totTax')))}`,
        );
      }
    }

    if (ent.years.length > 0 && ent.taxpayerTypes.length === 0 && ent.states.length === 0) {
      const res = await session.run(
        `MATCH (y:TaxYear)
         WHERE y.year IN $years
         RETURN y.year AS year, y.record_count AS cnt,
                y.total_income AS totInc, y.avg_income AS avgInc,
                y.total_tax_owed AS totTax, y.avg_tax_owed AS avgTax`,
        { years: ent.years.map((y) => neo4j.int(y)) },
      );
      for (const rec of res.records) {
        lines.push(
          `Year ${toNum(rec.get('year'))}: ${toNum(rec.get('cnt'))} records, ` +
            `Avg Income: ${fmtMoney(toNum(rec.get('avgInc')))}, ` +
            `Total Income: ${fmtMoney(toNum(rec.get('totInc')))}, ` +
            `Avg Tax Owed: ${fmtMoney(toNum(rec.get('avgTax')))}, ` +
            `Total Tax Owed: ${fmtMoney(toNum(rec.get('totTax')))}`,
        );
      }
    }

    if (ent.incomeSources.length > 0) {
      const res = await session.run(
        `MATCH (i:IncomeSource)
         WHERE i.name IN $sources
         RETURN i.name AS name, i.record_count AS cnt,
                i.total_income AS totInc, i.avg_income AS avgInc`,
        { sources: ent.incomeSources },
      );
      for (const rec of res.records) {
        lines.push(
          `Income Source "${rec.get('name')}": ${toNum(rec.get('cnt'))} records, ` +
            `Avg Income: ${fmtMoney(toNum(rec.get('avgInc')))}, ` +
            `Total Income: ${fmtMoney(toNum(rec.get('totInc')))}`,
        );
      }
    }

    if (ent.deductionTypes.length > 0) {
      const res = await session.run(
        `MATCH (d:DeductionType)
         WHERE d.name IN $deductions
         RETURN d.name AS name, d.record_count AS cnt,
                d.total_deductions AS totDed, d.avg_deductions AS avgDed`,
        { deductions: ent.deductionTypes },
      );
      for (const rec of res.records) {
        lines.push(
          `Deduction "${rec.get('name')}": ${toNum(rec.get('cnt'))} records, ` +
            `Avg Deductions: ${fmtMoney(toNum(rec.get('avgDed')))}, ` +
            `Total Deductions: ${fmtMoney(toNum(rec.get('totDed')))}`,
        );
      }
    }

    if (lines.length === 0) {
      const res = await session.run(
        `MATCH (t:TaxpayerType)
         RETURN t.name AS name, t.record_count AS cnt,
                t.avg_income AS avgInc, t.avg_tax_owed AS avgTax
         ORDER BY t.record_count DESC`,
      );
      for (const rec of res.records) {
        lines.push(
          `${rec.get('name')}: ${toNum(rec.get('cnt'))} records, ` +
            `Avg Income: ${fmtMoney(toNum(rec.get('avgInc')))}, ` +
            `Avg Tax Owed: ${fmtMoney(toNum(rec.get('avgTax')))}`,
        );
      }
    }

    return { relationships: lines };
  } finally {
    await session.close();
    await driver.close();
  }
}
