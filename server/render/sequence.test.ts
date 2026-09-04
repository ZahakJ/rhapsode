import { describe, expect, it } from "vitest"
import { buildSequenceArgs } from "./sequence.ts"
import type { SourceInfo } from "./graph.ts"
import { sequenceSchema, parseSrt, formatSrt, type SequenceInput } from "../../shared/sequence.ts"

const V = "a".repeat(24)
const P = "b".repeat(24)
const M = "c".repeat(24)
const sources: Record<string, SourceInfo> = {
  [V]: { id: V, path: "/d/v.mp4", media: "video", duration: 60, width: 1920, height: 1080, fps: 30, hasAudio: true },
  [P]: { id: P, path: "/d/p.jpg", media: "image", duration: 0, width: 4000, height: 3000, fps: 0, hasAudio: false },
  [M]: { id: M, path: "/d/m.m4a", media: "video", duration: 200, width: 0, height: 0, fps: 0, hasAudio: true },
}
const fonts = { outline: "/f/anton.ttf", clean: "/f/plex.woff", arabic: "/f/plexar.ttf" }
const build = (raw: SequenceInput) =>
  buildSequenceArgs({ sequence: sequenceSchema.parse(raw), sources, jobDir: "/j", fonts, encoder: "libx264", outPath: "/j/out.mp4" })

const seq: SequenceInput = {
  v: 1,
  tracks: [
    { id: "t1", kind: "visual", clips: [
      { id: "c1", source: P, at: 0, duration: 4, fadeOut: 1, kenBurns: { from: { x: 0, y: 0, w: 1 }, to: { x: 0.2, y: 0.1, w: 0.6 } } },
      { id: "c2", source: V, at: 3, duration: 5, in: 10, fadeIn: 1, volume: 0.5 },
    ] },
    { id: "t2", kind: "visual", clips: [{ id: "c3", source: V, at: 5, duration: 2, in: 30, fit: "free", box: { x: 0.6, y: 0.05, w: 0.35 }, opacity: 0.8, volume: 0 }] },
    { id: "t3", kind: "audio", clips: [{ id: "a1", source: M, at: 0, in: 12, out: 20, gain: 0.7, fadeIn: 1, fadeOut: 2 }] },
    { id: "t4", kind: "text", clips: [
      { id: "x1", at: 1, duration: 2, text: "hello", sub: "مرحبا" },
      { id: "x2", at: 4, duration: 3, text: "boxed", style: "box", align: "left", x: 0.1 },
    ] },
  ],
}

describe("sequence builder", () => {
  it("lays out inputs per clip and ends at the last clip", () => {
    const r = build(seq)
    expect(r.duration).toBe(8)
    expect(r.width).toBe(1920)
    expect(r.args.slice(6, 6 + 8)).toEqual(["-loop", "1", "-framerate", "30", "-t", "4", "-i", "/d/p.jpg"])
    expect(r.args).toContain("/d/m.m4a")
    expect(r.args.indexOf("-t", r.args.indexOf("-map"))).toBeGreaterThan(0)
    expect(r.args).not.toContain("-shortest")
  })
  it("composites bottom→top over the background with alpha fades and enable windows", () => {
    const { filterComplex } = build(seq)
    expect(filterComplex).toContain("color=c=0x000000:s=1920x1080:r=30:d=8[bg]")
    expect(filterComplex).toContain("[bg][v0]overlay=x=0:y=0:eof_action=pass:enable='between(t,0,4)'[o0]")
    expect(filterComplex).toContain("[o0][v1]overlay=x=0:y=0:eof_action=pass:enable='between(t,3,8)'[o1]")
    expect(filterComplex).toContain("[o1][v2]overlay=x=1152:y=54:eof_action=pass:enable='between(t,5,7)'[comp]")
    expect(filterComplex).toContain("fade=t=out:st=3:d=1:alpha=1")
    expect(filterComplex).toContain("fade=t=in:st=0:d=1:alpha=1")
    expect(filterComplex).toContain("colorchannelmixer=aa=0.8")
    expect(filterComplex).toContain("pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black@0")
  })
  it("pans and zooms stills with zoompan at the image aspect", () => {
    const { filterComplex } = build(seq)
    expect(filterComplex).toContain("zoompan=z='1/(1+(-0.4)*min(on/120,1))':x='iw*(0+(0.2)*min(on/120,1))':y='ih*(0+(0.1)*min(on/120,1))':d=1:s=1920x1440:fps=30")
  })
  it("mixes clip sound and music lanes with fades, normalize=0", () => {
    const { filterComplex } = build(seq)
    expect(filterComplex).toContain("[1:a]asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.5,adelay=3000:all=1,apad[a0]")
    expect(filterComplex).toContain("[3:a]asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.7,afade=t=in:st=0:d=1,afade=t=out:st=6:d=2,adelay=0:all=1,apad[a1]")
    expect(filterComplex).toContain("[a0][a1]amix=inputs=2:duration=first:normalize=0[a]")
    expect(filterComplex).not.toContain("[2:a]")
  })
  it("burns cues with a second line and per-style fonts", () => {
    const r = build(seq)
    expect(r.captionFiles.map((c) => c.text)).toEqual(["hello", "مرحبا", "boxed"])
    expect(r.filterComplex).toContain("drawtext=textfile=/j/cue0.txt:fontfile=/f/anton.ttf:fontsize=59:fontcolor=0xffffff:borderw=4:bordercolor=black:x=960-text_w/2:y=950-text_h-15")
    // the Arabic second line switches to the Arabic-capable face on its own
    expect(r.filterComplex).toContain("textfile=/j/cue0s.txt:fontfile=/f/plexar.ttf:fontsize=47:fontcolor=0xffd27a")
    expect(r.filterComplex).toContain("textfile=/j/cue1.txt:fontfile=/f/plex.woff:fontsize=59:fontcolor=0xffffff:box=1:boxcolor=black@0.55:boxborderw=21:x=192:y=950-text_h/2:text_align=L+M")
    expect(r.filterComplex).toContain("expansion=none[v]")
  })
  it("falls back to silence and a bare background", () => {
    const r = build({ v: 1, tracks: [{ id: "t", kind: "text", clips: [{ id: "x", at: 0, duration: 2, text: "only words" }] }] })
    expect(r.args).toContain("anullsrc=r=48000:cl=stereo")
    expect(r.filterComplex).toContain("[bg]null[comp]")
    expect(r.duration).toBe(2)
  })
  it("respects muted tracks and clamps video clips to the source", () => {
    const r = build({ v: 1, tracks: [
      { id: "t", kind: "visual", muted: true, clips: [{ id: "m", source: V, at: 0, duration: 5 }] },
      { id: "u", kind: "visual", clips: [{ id: "n", source: V, at: 0, duration: 50, in: 55 }] },
    ] })
    expect(r.filterComplex).not.toContain("/d/p.jpg")
    expect(r.args.slice(6, 12)).toEqual(["-ss", "55", "-t", "5", "-i", "/d/v.mp4"])
    expect(r.filterComplex).toContain("enable='between(t,0,5)'")
  })
})

describe("sequence schema", () => {
  it("rejects duplicates, empties, free without box, over-long", () => {
    expect(sequenceSchema.safeParse({ v: 1, tracks: [] }).success).toBe(false)
    expect(sequenceSchema.safeParse({ v: 1, tracks: [{ id: "t", kind: "visual", clips: [] }] }).success).toBe(false)
    expect(sequenceSchema.safeParse({ v: 1, tracks: [{ id: "t", kind: "visual", clips: [{ id: "t", source: V, at: 0, duration: 1 }] }] }).success).toBe(false)
    expect(sequenceSchema.safeParse({ v: 1, tracks: [{ id: "t", kind: "visual", clips: [{ id: "c", source: V, at: 0, duration: 1, fit: "free" }] }] }).success).toBe(false)
    expect(sequenceSchema.safeParse({ v: 1, tracks: [{ id: "t", kind: "visual", clips: [{ id: "c", source: V, at: 590, duration: 20 }] }] }).success).toBe(false)
  })
})

describe("srt", () => {
  it("round-trips", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,500\nhello <i>there</i>\nline two\n\n2\n00:01:00,250 --> 00:01:02,000\nbye\n"
    const cues = parseSrt(srt)
    expect(cues).toEqual([
      { index: 1, from: 1, to: 2.5, text: "hello there\nline two" },
      { index: 2, from: 60.25, to: 62, text: "bye" },
    ])
    expect(formatSrt(cues)).toContain("00:01:00,250 --> 00:01:02,000\nbye")
    expect(parseSrt(formatSrt(cues))).toEqual(cues)
  })
})
