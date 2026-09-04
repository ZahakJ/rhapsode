import { describe, expect, it } from "vitest"
import { buildArgs, canvasFor, even, type SourceInfo } from "./graph.ts"
import { recipeSchema, type RecipeInput } from "../../shared/recipe.ts"

const B = "a".repeat(24)
const O = "b".repeat(24)
const I = "c".repeat(24)
const S = "d".repeat(24)

const sources: Record<string, SourceInfo> = {
  [B]: { id: B, path: "/d/base.mp4", media: "video", duration: 60, width: 1920, height: 1080, fps: 29.97, hasAudio: true },
  [O]: { id: O, path: "/d/ov.mp4", media: "video", duration: 30, width: 1280, height: 720, fps: 25, hasAudio: true },
  [I]: { id: I, path: "/d/img.png", media: "image", duration: 0, width: 4000, height: 3000, fps: 0, hasAudio: false },
  [S]: { id: S, path: "/d/silent.mp4", media: "video", duration: 10, width: 640, height: 480, fps: 30, hasAudio: false },
}

function build(raw: RecipeInput, encoder: "libx264" | "h264_nvenc" = "libx264") {
  const recipe = recipeSchema.parse(raw)
  return buildArgs({ recipe, sources, jobDir: "/j/x", fonts: { outline: "/f/Anton.ttf", clean: "/f/plex.woff", arabic: "/f/plexar.ttf" }, encoder, outPath: "/j/x/out.mp4" })
}

const dub: RecipeInput = { v: 1, base: { kind: "video", source: B, in: 12.5, out: 20 }, overlay: { source: O, in: 3, out: 7, at: 1 } }

describe("canvas math", () => {
  it("presets", () => {
    expect(canvasFor(recipeSchema.parse({ ...dub, output: { aspect: "9:16" } }), sources[B]!)).toEqual({ w: 1080, h: 1920 })
  })
  it("source aspect scales to the max edge and stays even", () => {
    expect(canvasFor(recipeSchema.parse(dub), { width: 4000, height: 3001 })).toEqual({ w: 1920, h: 1440 })
    expect(canvasFor(recipeSchema.parse(dub), { width: 641, height: 361 })).toEqual({ w: 640, h: 360 })
  })
  it("even() floors and never returns zero", () => {
    expect(even(7)).toBe(6)
    expect(even(1)).toBe(2)
  })
})

describe("inputs", () => {
  it("trims both inputs before -i and clamps the overlay to the base end", () => {
    const { args } = build({ ...dub, overlay: { source: O, in: 3, out: 20, at: 5 } })
    const prefix = args.slice(6, 6 + 12)
    expect(prefix).toEqual(["-ss", "12.5", "-t", "7.5", "-i", "/d/base.mp4", "-ss", "3", "-t", "2.5", "-i", "/d/ov.mp4"])
  })
  it("image base loops at the output fps with no seek", () => {
    const { args, duration, fps } = build({ v: 1, base: { kind: "image", source: I }, overlay: { source: O, in: 0, out: 4 } })
    expect(args.slice(6, 11)).toEqual(["-loop", "1", "-framerate", "30", "-i"])
    expect(duration).toBe(4)
    expect(fps).toBe(30)
  })
  it("uses -t D on the output and never -shortest", () => {
    const { args } = build(dub)
    expect(args).not.toContain("-shortest")
    const i = args.indexOf("-t", args.indexOf("-map"))
    expect(args[i + 1]).toBe("7.5")
  })
  it("fps follows the base, clamped and rounded", () => {
    expect(build(dub).fps).toBe(30)
    const hi = { ...sources, [B]: { ...sources[B]!, fps: 120 } }
    const r = buildArgs({ recipe: recipeSchema.parse(dub), sources: hi, jobDir: "/j", fonts: { outline: "/f", clean: "/f", arabic: "/f" }, encoder: "libx264", outPath: "/o" })
    expect(r.fps).toBe(60)
  })
})

describe("video chains", () => {
  it("dub is the fitted base only", () => {
    const { filterComplex } = build(dub)
    expect(filterComplex).toContain(
      "[0:v]setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease:flags=bicubic,scale=trunc(iw/2)*2:trunc(ih/2)*2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[base]",
    )
    expect(filterComplex).toContain("[base]format=yuv420p[v]")
    expect(filterComplex).not.toContain("overlay=")
  })
  it("pip scales to the box width, shifts pts after fps, and enables in the window", () => {
    const { filterComplex } = build({ ...dub, mode: { kind: "pip", box: { x: 0.6, y: 0.05, w: 0.35 } }, output: { aspect: "9:16" } })
    expect(filterComplex).toContain("[1:v]setpts=PTS-STARTPTS,scale=w=378:h=-2:flags=bicubic,setsar=1,fps=30,setpts=PTS+1/TB[ov]")
    expect(filterComplex).toContain("[base][ov]overlay=x=648:y=96:eof_action=pass:enable='between(t,1,5)'[vp]")
  })
  it("cover fit crops instead of padding", () => {
    const { filterComplex } = build({ ...dub, output: { aspect: "1:1", fit: "cover" } })
    expect(filterComplex).toContain("scale=1080:1080:force_original_aspect_ratio=increase:flags=bicubic,crop=1080:1080")
  })
  it("stack builds two lanes on a black timed canvas", () => {
    const r = build({ ...dub, mode: { kind: "stack", dir: "bottom" }, output: { aspect: "9:16" } })
    expect(r.width).toBe(1080)
    expect(r.height).toBe(1920)
    expect(r.filterComplex).toContain("color=c=black:s=1080x960:r=30:d=7.5[blank]")
    expect(r.filterComplex).toContain("[blank][ov]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:enable='between(t,1,5)'[laneB]")
    expect(r.filterComplex).toContain("[laneA][laneB]vstack[vs]")
    const top = build({ ...dub, mode: { kind: "stack", dir: "top" } })
    expect(top.filterComplex).toContain("[laneB][laneA]vstack[vs]")
    const left = build({ ...dub, mode: { kind: "stack", dir: "left" } })
    expect(left.filterComplex).toContain("[laneB][laneA]hstack[vs]")
    expect(left.width).toBe(1920)
    expect(left.height).toBe(1080)
  })
})

describe("audio", () => {
  it("duck uses a sidechain compressor into a normalize=0 mix", () => {
    const { filterComplex } = build(dub)
    expect(filterComplex).toContain("adelay=1000:all=1,apad,asplit=2[oa][sc]")
    expect(filterComplex).toContain("[ba][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[bd]")
    expect(filterComplex).toContain("[bd][oa]amix=inputs=2:duration=first:normalize=0[a]")
  })
  it("keep/keep mixes plainly", () => {
    const { filterComplex } = build({ ...dub, audio: { base: "keep" } })
    expect(filterComplex).toContain("[ba][oa]amix=inputs=2:duration=first:normalize=0[a]")
    expect(filterComplex).not.toContain("sidechaincompress")
  })
  it("mute/mute and silent files pull in anullsrc", () => {
    const { args, filterComplex } = build({ ...dub, audio: { base: "mute", overlay: "mute" } })
    expect(args).toContain("anullsrc=r=48000:cl=stereo")
    expect(filterComplex).toContain("[2:a]anull[a]")
    const silent = build({ ...dub, base: { kind: "video", source: S, in: 0, out: 5 }, overlay: { source: S, in: 0, out: 2 } })
    expect(silent.args).toContain("anullsrc=r=48000:cl=stereo")
  })
  it("single lanes never reference a missing stream", () => {
    const ovOnly = build({ ...dub, base: { kind: "image", source: I } })
    expect(ovOnly.filterComplex).not.toContain("[0:a]")
    expect(ovOnly.filterComplex).toContain("adelay=1000:all=1,apad[a]")
    const baseOnly = build({ ...dub, overlay: { source: S, in: 0, out: 2 } })
    expect(baseOnly.filterComplex).not.toContain("[1:a]")
    expect(baseOnly.filterComplex).toContain("[0:a]asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=1,apad[a]")
  })
  it("every amix carries normalize=0", () => {
    for (const r of [build(dub), build({ ...dub, audio: { base: "keep" } })]) {
      for (const m of r.filterComplex.match(/amix=[^[]*/g) ?? []) expect(m).toContain("normalize=0")
    }
  })
})

describe("edits", () => {
  it("crops in even source pixels before the fit, then rotates and mirrors", () => {
    const r = build({ ...dub, base: { kind: "video", source: B, in: 0, out: 5, edit: { crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 }, rotate: 90, flipH: true } } })
    expect(r.filterComplex).toContain("[0:v]setpts=PTS-STARTPTS,crop=960:540:480:108,transpose=1,hflip,scale=")
    // source canvas follows the cropped, rotated frame: 960x540 turned → 540x960
    expect(r.width).toBe(540)
    expect(r.height).toBe(960)
  })
  it("crops the overlay before the pip scale", () => {
    const r = build({ ...dub, overlay: { source: O, in: 0, out: 2, edit: { crop: { x: 0.8, y: 0.8, w: 0.2, h: 0.2 } } }, mode: { kind: "pip", box: { x: 0, y: 0, w: 0.5 } } })
    expect(r.filterComplex).toContain("[1:v]setpts=PTS-STARTPTS,crop=256:144:1024:576,scale=w=960")
  })
  it("emits nothing for an identity edit", () => {
    const r = build({ ...dub, base: { kind: "video", source: B, in: 0, out: 5, edit: { rotate: 0, flipH: false } } })
    expect(r.filterComplex).toContain("[0:v]setpts=PTS-STARTPTS,scale=1920")
  })
})

describe("captions", () => {
  it("pins the ffmpeg 9 drawtext option order and writes text to files", () => {
    const r = build({ ...dub, captions: [{ text: "hi: there" }, { text: "L", align: "left", x: 0.1, y: 0.2, from: 1, to: 2 }] })
    expect(r.captionFiles).toEqual([
      { path: "/j/x/cap0.txt", text: "hi: there" },
      { path: "/j/x/cap1.txt", text: "L" },
    ])
    expect(r.filterComplex).toContain(
      "drawtext=textfile=/j/x/cap0.txt:fontfile=/f/Anton.ttf:fontsize=76:fontcolor=white:borderw=5:bordercolor=black:x=960-text_w/2:y=918-text_h/2:text_align=C+M:line_spacing=8:expansion=none",
    )
    expect(r.filterComplex).toContain("x=192:y=216-text_h/2:text_align=L+M:line_spacing=8:enable='between(t,1,2)':expansion=none")
    const ar = build({ ...dub, captions: [{ text: "مرحبا" }] })
    expect(ar.filterComplex).toContain("fontfile=/f/plexar.ttf")
    expect(r.filterComplex).toContain("expansion=none,drawtext=")
    expect(r.filterComplex).toMatch(/expansion=none\[v\]/)
  })
})

describe("encoders", () => {
  it("nvenc vs x264 argv", () => {
    const nv = build(dub, "h264_nvenc").args
    expect(nv.slice(nv.indexOf("-c:v"), nv.indexOf("-c:v") + 6)).toEqual(["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq"])
    expect(nv).toContain("-cq")
    const x = build(dub, "libx264").args
    expect(x).toContain("libx264")
    expect(x).toContain("-crf")
    for (const a of [nv, x]) {
      expect(a).toContain("+faststart")
      expect(a.at(-1)).toBe("/j/x/out.mp4")
      expect(a.slice(-3, -1)).toEqual(["-progress", "pipe:1"])
    }
  })
})
