import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { describeError } from '../src/chat';

const apiError = (status: number, message: string) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message } }, undefined, new Headers());

describe('describeError', () => {
  it('says the budget is used up when the workspace spend limit is reached', () => {
    const budget = 'TaxGPT has used up its budget for this month. Try again next month.';
    expect(describeError(apiError(400, 'You have reached your specified workspace API usage limits.'))).toBe(budget);
    expect(describeError(apiError(429, 'You have reached your specified workspace API usage limits.'))).toBe(budget);
    expect(describeError(apiError(400, 'Your credit balance is too low to access the Anthropic API.'))).toBe(budget);
  });

  it('keeps the usual messages for other errors', () => {
    expect(describeError(apiError(429, 'Number of request tokens has exceeded your rate limit.'))).toBe(
      'TaxGPT is busy right now. Try again in a minute.',
    );
    expect(describeError(apiError(529, 'Overloaded'))).toBe("TaxGPT's AI service is having trouble. Try again shortly.");
    expect(describeError(apiError(401, 'invalid x-api-key'))).toBe("TaxGPT isn't working right now. Try again later.");
  });
});
