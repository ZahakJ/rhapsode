import { describe, expect, it } from "vitest"
import { makeSlug, uniqueSlug, slugifyName } from "./slugs.ts"
import { ADJECTIVES, NOUNS } from "../shared/slugWords.ts"

describe("makeSlug", () => {
  it("is adjective-noun from the word pools", () => {
    const slug = makeSlug()
    const [a, n] = slug.split("-") as [string, string]
    expect(ADJECTIVES).toContain(a)
    expect(NOUNS).toContain(n)
  })
  it("is deterministic under a seeded rand", () => {
    expect(makeSlug(() => 0)).toBe(`${ADJECTIVES[0]}-${NOUNS[0]}`)
  })
})

describe("uniqueSlug", () => {
  it("returns first free slug", () => {
    expect(uniqueSlug(() => false, () => 0)).toBe(`${ADJECTIVES[0]}-${NOUNS[0]}`)
  })
  it("suffixes when the pool keeps colliding", () => {
    const taken = new Set([`${ADJECTIVES[0]}-${NOUNS[0]}`])
    const slug = uniqueSlug((s) => taken.has(s), () => 0)
    expect(slug).toMatch(new RegExp(`^${ADJECTIVES[0]}-${NOUNS[0]}-[0-9a-z]{2}$`))
  })
})

describe("slugifyName", () => {
  it("lowercases and dashes", () => {
    expect(slugifyName("Distracted Boyfriend")).toBe("distracted-boyfriend")
  })
  it("strips punctuation and trims dashes", () => {
    expect(slugifyName("  Wait... WHAT?! ")).toBe("wait-what")
  })
  it("handles diacritics", () => {
    expect(slugifyName("Épic Mème")).toBe("epic-meme")
  })
})
