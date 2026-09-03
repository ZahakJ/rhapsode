import crypto from "node:crypto"
import type { Context, Next } from "hono"
import { clientIp } from "./rateLimit.ts"

// CSRF: the absence of CORS middleware is the defense. x-rhapsode-key is not a
// CORS-safelisted header, so any cross-origin call carrying it must first pass
// a preflight — which this app answers with nothing, so the browser blocks it.
// Adding cors() would hand that away; don't, unless a real cross-origin client
// needs it and you replace the defense with something else.

// Hash both sides before comparing: timingSafeEqual demands equal lengths,
// and comparing raw strings would leak the key's length via the early throw.
export function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false
  const a = crypto.createHash("sha256").update(given).digest()
  const b = crypto.createHash("sha256").update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

export function requireKey(inviteKey: string) {
  return async (c: Context, next: Next) => {
    if (!keyMatches(c.req.header("x-rhapsode-key"), inviteKey)) {
      // never log the attempted key itself
      console.warn(`[rhapsode] key rejected from ${clientIp(c)} — ${c.req.method} ${c.req.path}`)
      return c.json({ error: "invalid or missing invite key" }, 401)
    }
    await next()
  }
}
