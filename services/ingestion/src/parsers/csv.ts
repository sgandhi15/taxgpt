import csvParser from 'csv-parser';
import fs from 'fs';

export interface TaxRecord {
  taxpayerType: string;
  taxYear: number;
  transactionDate: string;
  incomeSource: string;
  deductionType: string;
  state: string;
  income: number;
  deductions: number;
  taxableIncome: number;
  taxRate: number;
  taxOwed: number;
}

export async function parseCSV(filePath: string): Promise<TaxRecord[]> {
  return new Promise((resolve, reject) => {
    const results: TaxRecord[] = [];
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('data', (row: Record<string, string>) => {
        results.push({
          taxpayerType: row['Taxpayer Type'] ?? '',
          taxYear: parseInt(row['Tax Year']) || 0,
          transactionDate: row['Transaction Date'] ?? '',
          incomeSource: row['Income Source'] ?? '',
          deductionType: row['Deduction Type'] ?? '',
          state: row['State'] ?? '',
          income: parseFloat(row['Income']) || 0,
          deductions: parseFloat(row['Deductions']) || 0,
          taxableIncome: parseFloat(row['Taxable Income']) || 0,
          taxRate: parseFloat(row['Tax Rate']) || 0,
          taxOwed: parseFloat(row['Tax Owed']) || 0,
        });
      })
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}
