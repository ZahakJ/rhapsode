import { describe, expect, it } from "vitest"
import { outputDurationOf, recipeSchema, type RecipeInput } from "./recipe.ts"

const B = "a".repeat(24)
const O = "b".repeat(24)
const ok: RecipeInput = { v: 1, base: { kind: "video", source: B, in: 1, out: 11 }, overlay: { source: O, in: 0, out: 5 } }

describe("recipe schema", () => {
  it("applies defaults", () => {
    const r = recipeSchema.parse(ok)
    expect(r.mode).toEqual({ kind: "dub" })
    expect(r.audio).toEqual({ base: "duck", overlay: "keep", baseGain: 1, overlayGain: 1 })
    expect(r.captions).toEqual([])
    expect(r.output).toEqual({ aspect: "source", fit: "contain" })
    expect(r.overlay.at).toBe(0)
  })
  it("derives the image duration from the overlay", () => {
    const r = recipeSchema.parse({ ...ok, base: { kind: "image", source: B } })
    expect(outputDurationOf(r)).toBe(5)
    expect(outputDurationOf(recipeSchema.parse({ ...ok, base: { kind: "image", source: B, duration: 2 } }))).toBe(2)
    expect(outputDurationOf(recipeSchema.parse(ok))).toBe(10)
  })
  const bad: Array<[string, RecipeInput]> = [
    ["out <= in", { ...ok, overlay: { source: O, in: 5, out: 5 } }],
    ["base empty", { ...ok, base: { kind: "video", source: B, in: 5, out: 4 } }],
    ["output too long", { ...ok, base: { kind: "video", source: B, in: 0, out: 181 } }],
    ["overlay too long", { ...ok, base: { kind: "image", source: B, duration: 10 }, overlay: { source: O, in: 0, out: 181 } }],
    ["at past end", { ...ok, overlay: { source: O, in: 0, out: 5, at: 10 } }],
    ["pip overflow", { ...ok, mode: { kind: "pip", box: { x: 0.8, y: 0, w: 0.5 } } }],
    ["too many captions", { ...ok, captions: Array.from({ length: 7 }, () => ({ text: "x" })) }],
    ["caption too long", { ...ok, captions: [{ text: "x".repeat(201) }] }],
    ["caption to <= from", { ...ok, captions: [{ text: "x", from: 2, to: 1 }] }],
    ["unknown mode", { ...ok, mode: { kind: "wipe" } as never }],
    ["bad id", { ...ok, base: { kind: "video", source: "nope", in: 0, out: 1 } }],
    ["crop leaves the frame", { ...ok, overlay: { source: O, in: 0, out: 5, edit: { crop: { x: 0.6, y: 0, w: 0.5, h: 0.5 } } } }],
    ["bad rotation", { ...ok, overlay: { source: O, in: 0, out: 5, edit: { rotate: 45 as never } } }],
  ]
  for (const [name, input] of bad) {
    it(`rejects ${name}`, () => {
      expect(recipeSchema.safeParse(input).success).toBe(false)
    })
  }
})
