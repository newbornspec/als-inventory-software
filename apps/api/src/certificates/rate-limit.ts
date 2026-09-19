// A simple in-memory, fixed-window rate limiter for the public certificate
// check (plan step 30) - the API had no rate limiting at all, and this is
// the first route anyone on the internet can call.
//
// Per process: with N API instances a caller gets up to N x the limit. Good
// enough to stop enumeration and hammering (ids are random v4 UUIDs, so
// guessing is hopeless anyway); a shared store would be needed for a hard
// limit. A second, GLOBAL window bounds the database work the route can be
// made to do however many addresses a caller has.
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  // true if the call is allowed (and counted).
  take(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      // Forget finished windows now and then, so the map cannot grow without
      // bound under a spray of addresses.
      if (this.windows.size > 10_000) this.prune(t);
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count++;
    return true;
  }

  private prune(t: number): void {
    for (const [k, w] of this.windows)
      if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}

// The caller's address for rate limiting. The API runs behind Railway's
// proxy, so the socket address is the proxy's; the proxy APPENDS the address
// it received the request from to X-Forwarded-For, so the LAST entry is the
// one a client cannot forge (anything a client sends itself comes earlier in
// the list). Falls back to the socket address when there is no header
// (local runs).
export function clientAddress(req: {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const xff = req.headers?.['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : (xff ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    list[list.length - 1] ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown'
  );
}
