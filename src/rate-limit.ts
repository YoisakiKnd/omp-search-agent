export class RateLimiter {
  private hits = new Map<number, number[]>();
  private checks = 0;
  constructor(private max: number, private windowMs: number) {}
  allow(userId: number) {
    const cutoff = Date.now() - this.windowMs;
    if (++this.checks % 256 === 0) {
      for (const [id, hits] of this.hits) {
        const active = hits.filter((timestamp) => timestamp > cutoff);
        if (active.length) this.hits.set(id, active); else this.hits.delete(id);
      }
    }
    const current = (this.hits.get(userId) ?? []).filter(x => x > cutoff);
    if (current.length >= this.max) { this.hits.set(userId, current); return false; }
    current.push(Date.now()); this.hits.set(userId, current); return true;
  }
}
