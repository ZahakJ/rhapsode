import type { Context, MiddlewareHandler } from "hono"
import { getConnInfo } from "@hono/node-server/conninfo"

// Per-IP sliding-window limiter, in memory. One process serves this box, so a
// shared store would be ceremony; the cost of a restart is a cleared window.

export class RateLimiter {
  private hits = new Map<string, number[]>()
  private lastSweep = 0
  readonly limit: number
  readonly windowMs: number

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit
    this.windowMs = windowMs
  }

  /** null when the call is allowed, else seconds until the window frees up */
  check(key: string, now: number = Date.now()): number | null {
    this.sweep(now)
    const cutoff = now - this.windowMs
    const log = (this.hits.get(key) ?? []).filter((t) => t > cutoff)
    this.hits.set(key, log)
    if (log.length >= this.limit) {
      return Math.max(1, Math.ceil((log[0]! + this.windowMs - now) / 1000))
    }
    log.push(now)
    return null
  }

  /** entries expire lazily — sweeping on access keeps stray timers out of tests */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return
    this.lastSweep = now
    const cutoff = now - this.windowMs
    for (const [key, log] of this.hits) {
      const live = log.filter((t) => t > cutoff)
      if (live.length) this.hits.set(key, live)
      else this.hits.delete(key)
    }
  }

  get size(): number {
    return this.hits.size
  }
}

// Prod sits behind a Cloudflare tunnel, so the socket address is always
// loopback and CF-Connecting-IP carries the real client. Trusting that header
// is safe only because the server binds loopback exclusively — nothing but the
// tunnel can reach it to forge one.
export function clientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip")?.trim()
  if (cf) return cf
  try {
    return getConnInfo(c).remote.address ?? "unknown"
  } catch {
    return "unknown"
  }
}

export function rateLimit(limiter: RateLimiter, label: string): MiddlewareHandler {
  return async (c, next) => {
    const ip = clientIp(c)
    const retryAfter = limiter.check(ip)
    if (retryAfter !== null) {
      console.warn(`[rhapsode] rate-limit ${label} tripped by ${ip} — ${c.req.method} ${c.req.path}`)
      c.header("Retry-After", String(retryAfter))
      return c.json({ error: "rate limit exceeded" }, 429)
    }
    await next()
  }
}
