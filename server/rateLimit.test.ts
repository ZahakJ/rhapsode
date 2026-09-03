import { describe, expect, it } from "vitest"
import { RateLimiter } from "./rateLimit.ts"

describe("RateLimiter", () => {
  it("allows up to the limit, then blocks", () => {
    const rl = new RateLimiter(3, 1000)
    const t = 1_000_000
    expect(rl.check("a", t)).toBeNull()
    expect(rl.check("a", t)).toBeNull()
    expect(rl.check("a", t)).toBeNull()
    expect(rl.check("a", t)).toBe(1)
  })

  it("counts each key separately", () => {
    const rl = new RateLimiter(1, 1000)
    const t = 1_000_000
    expect(rl.check("a", t)).toBeNull()
    expect(rl.check("b", t)).toBeNull()
    expect(rl.check("a", t)).not.toBeNull()
  })

  it("slides: hits age out of the window", () => {
    const rl = new RateLimiter(2, 1000)
    const t = 1_000_000
    rl.check("a", t)
    rl.check("a", t + 500)
    expect(rl.check("a", t + 900)).not.toBeNull()
    // the first hit has aged out by now, the second has not
    expect(rl.check("a", t + 1100)).toBeNull()
  })

  it("reports seconds until the window frees up", () => {
    const rl = new RateLimiter(1, 60_000)
    const t = 1_000_000
    rl.check("a", t)
    expect(rl.check("a", t + 30_000)).toBe(30)
  })

  it("prunes stale keys instead of growing forever", () => {
    const rl = new RateLimiter(5, 1000)
    const t = 1_000_000
    for (let i = 0; i < 50; i++) rl.check(`ip-${i}`, t)
    expect(rl.size).toBe(50)
    rl.check("fresh", t + 5000)
    expect(rl.size).toBe(1)
  })
})
