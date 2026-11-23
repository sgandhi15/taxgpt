import { DurableObject } from 'cloudflare:workers';

interface Usage {
  day: string; // UTC date, YYYY-MM-DD
  count: number;
}

/**
 * Counts questions per UTC day across all visitors. One instance ("global")
 * serves the whole site, so the count is exact rather than per-location.
 */
export class UsageCounter extends DurableObject<Env> {
  /** Records one question if today's total is still under `limit`. */
  async tryConsume(limit: number): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const stored = await this.ctx.storage.get<Usage>('usage');
    const count = stored?.day === day ? stored.count : 0;
    if (count >= limit) return false;
    await this.ctx.storage.put<Usage>('usage', { day, count: count + 1 });
    return true;
  }
}
