export class RateLimiter {
  private hits = new Map<number, number[]>();
  constructor(private max: number, private windowMs: number) {}
  allow(userId: number) {
    const cutoff = Date.now() - this.windowMs;
    const current = (this.hits.get(userId) ?? []).filter(x => x > cutoff);
    if (current.length >= this.max) { this.hits.set(userId, current); return false; }
    current.push(Date.now()); this.hits.set(userId, current); return true;
  }
}
