// What gets ingested. The Income Tax Act is always included (see lib/ita.ts);
// these are the Canada Revenue Agency pages added on top of it.
const SITE = 'https://www.canada.ca';
const CRA = `${SITE}/en/revenue-agency/services`;
const RETURN_PATH =
  '/en/revenue-agency/services/tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return';

/**
 * Individual pages. The Act states rates and base amounts but not each year's
 * indexed dollar figures, so these pages supply the numbers for the year.
 */
export const CRA_PAGES: string[] = [
  // Federal and provincial rates and brackets for the current and previous tax year
  `${CRA}/tax/individuals/tax-rates-brackets/current-year.html`,
  `${CRA}/tax/individuals/tax-rates-brackets/last-year.html`,
  // Indexed amounts (basic personal amount, credits, thresholds) by year
  `${CRA}/tax/individuals/frequently-asked-questions-individuals/adjustment-personal-income-tax-benefit-amounts.html`,
  // RRSP, TFSA, pension limits and the YMPE
  `${CRA}/tax/registered-plans-administrators/pspa/mp-rrsp-dpsp-tfsa-limits-ympe.html`,
  // CPP and EI rates and maximums
  `${CRA}/tax/businesses/topics/payroll/payroll-deductions-contributions/canada-pension-plan-cpp/cpp-contribution-rates-maximums-exemptions.html`,
  `${CRA}/tax/businesses/topics/payroll/payroll-deductions-contributions/employment-insurance-ei/ei-premium-rates-maximums.html`,
  // Federal Income Tax and Benefit Guide (the line-by-line T1 guide)
  `${CRA}/forms-publications/tax-packages-years/general-income-tax-benefit-package/5000-g.html`,
];

/**
 * Index pages. Every page they link to under `follow` is ingested (the index
 * itself is only a list of links). These are CRA's plain-language explanations
 * of each line of the tax return, which answer everyday questions far better
 * than the wording of the Act.
 */
export const CRA_INDEXES: { url: string; follow: string }[] = [
  {
    // "All deductions, credits, and expenses": about 100 pages, one per line of the return
    url: `${SITE}${RETURN_PATH}/deductions-credits-expenses/deductions-credits-expenses.html`,
    follow: `${RETURN_PATH}/deductions-credits-expenses/`,
  },
  {
    // "All types of income": employment, self-employment, investment, pension, capital gains
    url: `${SITE}${RETURN_PATH}/personal-income/types-income.html`,
    follow: `${RETURN_PATH}/personal-income/`,
  },
];
