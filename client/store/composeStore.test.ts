import { describe, expect, it } from "vitest"
import type { SourceDto } from "../../shared/recipe.ts"
import { defaultCut } from "./composeStore.ts"

const src = (p: Partial<SourceDto>): SourceDto => ({
  id: "x", kind: "url", media: "video", status: "ready", title: "", ext: "mp4", url: null,
  duration: 900, width: 640, height: 360, fps: 25, hasAudio: true,
  windowStart: null, windowEnd: null, around: null, error: null, jobId: null,
  proxyUrl: null, thumbUrl: null, parentId: null, stem: null, createdAt: 0, ...p,
})

describe("defaultCut", () => {
  it("takes the first 15 s of a whole fetch", () => {
    expect(defaultCut(src({}))).toEqual({ in: 0, out: 15 })
    expect(defaultCut(src({ duration: 8 }))).toEqual({ in: 0, out: 8 })
  })

  it("starts at the moment asked for inside a window", () => {
    // asked for 2:00 of a 30:00 video: the window is 0:00–15:00
    expect(defaultCut(src({ windowStart: 0, windowEnd: 900, around: 120 }))).toEqual({ in: 120, out: 135 })
    // asked for 30:00: the window is 25:00–40:00, so 30:00 is 300 s into the file
    expect(defaultCut(src({ windowStart: 1500, windowEnd: 2400, around: 1800 }))).toEqual({ in: 300, out: 315 })
  })

  it("stays inside the file near its end", () => {
    expect(defaultCut(src({ windowStart: 0, windowEnd: 900, around: 895 }))).toEqual({ in: 895, out: 900 })
    expect(defaultCut(src({ windowStart: 0, windowEnd: 900, around: 900 }))).toEqual({ in: 0, out: 15 })
  })
})
