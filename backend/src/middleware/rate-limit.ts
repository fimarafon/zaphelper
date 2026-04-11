/**
 * Simple in-memory sliding-window rate limiter.
 *
 * Tracks (key → timestamps[]) where key is typically an IP address or a
 * composite of IP+username. Each hit() call records a timestamp and prunes
 * anything older than `windowMs`. If the remaining count exceeds `max`,
 * the call returns { ok: false, retryAfter }.
 *
 * Not distributed — only works within a single process. Good enough for a
 * single-container zaphelper where brute-force from a single IP is the
 * main threat. If we go multi-replica, switch to Redis INCR with expiry.
 */

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter?: number; // seconds until the oldest hit expires
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  hit(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const existing = this.hits.get(key) ?? [];
    // Drop expired hits in place for memory hygiene.
    const active = existing.filter((t) => t > cutoff);

    if (active.length >= this.max) {
      const oldest = active[0]!;
      const retryAfter = Math.ceil((oldest + this.windowMs - now) / 1000);
      // Don't record this hit — we already blocked.
      this.hits.set(key, active);
      return { ok: false, remaining: 0, retryAfter };
    }

    active.push(now);
    this.hits.set(key, active);
    return { ok: true, remaining: this.max - active.length };
  }

  /**
   * Reset a key's counter — useful on successful login so a legitimate user
   * doesn't get locked out by past failed attempts.
   */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /**
   * Periodic cleanup to prevent unbounded memory growth. Call this from a
   * timer; it removes entries with no active hits.
   */
  cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.hits.entries()) {
      const active = timestamps.filter((t) => t > cutoff);
      if (active.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, active);
      }
    }
  }
}

/**
 * Singleton login limiter: max 5 failed attempts per IP per 15 minutes.
 * Successful logins reset the counter.
 */
export const loginLimiter = new RateLimiter(5, 15 * 60 * 1000);

// Periodic cleanup every 5 minutes to prevent memory bloat.
setInterval(() => loginLimiter.cleanup(), 5 * 60 * 1000).unref();
