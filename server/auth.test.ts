import { describe, expect, it } from "vitest"
import { keyMatches } from "./auth.ts"

describe("keyMatches", () => {
  it("accepts the exact key", () => {
    expect(keyMatches("hunter2", "hunter2")).toBe(true)
  })
  it("rejects a wrong key", () => {
    expect(keyMatches("hunter3", "hunter2")).toBe(false)
  })
  it("rejects different-length keys without throwing", () => {
    expect(keyMatches("h", "hunter2")).toBe(false)
  })
  it("rejects when no key is given", () => {
    expect(keyMatches(undefined, "hunter2")).toBe(false)
    expect(keyMatches("", "hunter2")).toBe(false)
  })
  it("rejects everything when the server key is unset", () => {
    expect(keyMatches("anything", "")).toBe(false)
  })
})
