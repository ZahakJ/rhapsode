import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Real ffmpeg on generated fixtures; never the network. The counter fixture
// paints frame N with luma 20+3N, so a written frame says which frame it is.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rhapsode-cut-test-"))
process.env.RHAPSODE_CUT_CACHE = path.join(tmp, "cache")
process.env.RHAPSODE_CUT_OUT = path.join(tmp, "out")
const HERE = path.dirname(fileURLToPath(import.meta.url))

const { runOp, gridSelect, parseSceneLines } = await import("./ops.ts")
const { findCovering, downloadArgs } = await import("./source.ts")
const { lookFilters, parseShowinfo, parseSize } = await import("./media.ts")
const { parseTime, parseRange, parseInterval, fmtTime } = await import("./time.ts")
const { cliParams } = await import("./cli.ts")

const counter = path.join(tmp, "counter.mp4")
const shots = path.join(tmp, "shots.mp4")
const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args])

/** which counter frame an image holds */
function frameIndex(img: string): number {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", img, "-vf", "crop=8:8,format=gray", "-f", "rawvideo", "-"])
  const avg = [...raw].reduce((a, b) => a + b, 0) / raw.length
  // RGB/gray outputs are full range: undo the limited→full stretch
  return Math.round(((avg * 219) / 255 + 16 - 20) / 3)
}

beforeAll(() => {
  ff(["-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=2,geq=lum='20+3*N':cb=128:cr=128",
    "-f", "lavfi", "-i", "sine=d=2", "-c:v", "libx264", "-qp", "0", "-g", "15", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-t", "2", counter])
  ff(["-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "color=c=white:s=320x180:r=30:d=1",
    "-f", "lavfi", "-i", "color=c=0x404040:s=320x180:r=30:d=1",
    "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", shots])
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe("time", () => {
  it("parses the forms people type", () => {
    expect(parseTime("12.5")).toBe(12.5)
    expect(parseTime("1:02.5")).toBe(62.5)
    expect(parseTime("01:02:03")).toBe(3723)
    expect(parseTime("1500ms")).toBe(1.5)
    expect(parseRange("1:00-1:05")).toEqual({ start: 60, end: 65 })
    expect(parseRange("12+3")).toEqual({ start: 12, end: 15 })
    expect(parseInterval("15fps")).toBeCloseTo(1 / 15)
    expect(parseInterval("67ms")).toBeCloseTo(0.067)
    expect(fmtTime(62.3)).toBe("00:01:02.300")
    expect(() => parseRange("5-3")).toThrow()
    expect(() => parseTime("soon")).toThrow()
  })
})

describe("pure builders", () => {
  it("chains look filters", () => {
    expect(lookFilters({ size: "640x360" }, { colorSpace: "bt709", height: 1080 })).toEqual([
      "scale=640:360:force_original_aspect_ratio=increase:flags=lanczos", "crop=640:360",
    ])
    expect(lookFilters({ crop: "100:50:10:20", size: "x90", fit: "contain" }, { colorSpace: null, height: 1080 })).toEqual([
      "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709", "crop=100:50:10:20", "scale=-2:90:flags=lanczos",
    ])
    expect(parseSize("640x")).toEqual({ w: 640, h: null })
    expect(() => lookFilters({ crop: "1:2" }, { colorSpace: null, height: 100 })).toThrow()
  })
  it("parses showinfo and scene lines", () => {
    expect(parseShowinfo("[Parsed_showinfo_1 @ 0x5] n:   3 pts:   3003 pts_time:0.1001  duration:1001")).toEqual({ n: 3, t: 0.1001 })
    expect(parseSceneLines(["frame:0    pts:30      pts_time:1", "lavfi.scene_score=0.912000"])).toEqual([{ t: 1, score: 0.912 }])
    expect(gridSelect(0.1)).toContain("st(0,0.1*(floor(")
  })
  it("reuses a cached file that covers the window at enough height", () => {
    const base = { bytes: 1, sha256: "x", fetchedAt: "" }
    const entries = [
      { ...base, file: "a", start: 10, end: 20, maxHeight: 720, height: 720, audio: false },
      { ...base, file: "b", start: 0, end: 60, maxHeight: 1080, height: 1080, audio: true },
      { ...base, file: "c", start: null, end: null, maxHeight: 480, height: 480, audio: true },
      { ...base, file: "d", start: 0, end: 100, maxHeight: 1080, height: 360, audio: true },
    ]
    expect(findCovering(entries, { start: 12, end: 15, maxHeight: 720, audio: false })?.file).toBe("a")
    expect(findCovering(entries, { start: 12, end: 15, maxHeight: 720, audio: true })?.file).toBe("b")
    expect(findCovering(entries, { start: 70, end: 75, maxHeight: 480, audio: false })?.file).toBe("c")
    expect(findCovering(entries, { start: 70, end: 75, maxHeight: 720, audio: false })).toBeNull()
    // a 360p fallback is not reused when the source has 1080p, but is when that is all it has
    expect(findCovering(entries, { start: 70, end: 75, maxHeight: 1080, audio: true }, 1080)).toBeNull()
    expect(findCovering(entries, { start: 70, end: 75, maxHeight: 1080, audio: true }, 360)?.file).toBe("d")
  })
  it("asks yt-dlp for a section at a height", () => {
    const a = downloadArgs("https://example.com/v", "/c", "s1", { start: 10, end: 14.5, maxHeight: 720, audio: false })
    expect(a).toContain("res:720,fps,vcodec:h264,acodec:m4a")
    expect(a.slice(a.indexOf("--download-sections"), a.indexOf("--download-sections") + 2)).toEqual(["--download-sections", "*10.000-14.500"])
    expect(a[a.indexOf("-f") + 1]).toBe("bv*/b")
    expect(a.slice(-2)).toEqual(["--", "https://example.com/v"])
  })
  it("maps CLI flags to op params", () => {
    expect(cliParams("strip", ["v.mp4", "--from", "1:02", "--to", "64", "--fps", "15", "--size", "640x", "--sheet"])).toEqual({
      src: "v.mp4", from: "1:02", to: 64, every: "15fps", size: "640x", sheet: true,
    })
    expect(cliParams("frames", ["v.mp4", "--at", "1,2.5", "--at", "0:03"]).at).toEqual([1, 2.5, "0:03"])
  })
})

describe("ops on a local fixture", () => {
  it("frames: first frame at or after each time, exact", async () => {
    const m = await runOp("frames", { src: counter, at: [0.5, 0.51, "1.2"], hw: "cpu" })
    expect(m.outputs.map((o) => frameIndex(o.path))).toEqual([15, 16, 36])
    m.outputs.forEach((o, i) => expect(o.t).toBeCloseTo([0.5, 0.533333, 1.2][i]!, 4))
    expect(m.outputs[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(m.source?.sha256).toMatch(/^[0-9a-f]{64}$/)
    const onDisk = JSON.parse(fs.readFileSync(path.join(m.dir!, "manifest.json"), "utf8"))
    expect(onDisk.outputs.length).toBe(3)
  })
  it("strip: fixed grid, parallel chunks land in order", async () => {
    const m = await runOp("strip", { src: counter, from: 0.2, to: 1.8, every: "100ms", jobs: 4, hw: "cpu", format: "png" })
    const idx = m.outputs.map((o) => frameIndex(o.path))
    expect(idx).toEqual([6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51])
    expect(m.outputs[0]!.requested).toBeCloseTo(0.2)
  })
  it("strip: long windows split into chunks without gaps", async () => {
    const m = await runOp("strip", { src: counter, from: 0, to: 2, every: "30fps", jobs: 3, hw: "cpu", format: "jpg" })
    expect(m.outputs.length).toBe(60)
    expect(m.outputs.map((o) => frameIndex(o.path))).toEqual(Array.from({ length: 60 }, (_, i) => i))
  })
  it("scaling and crop hit the asked size", async () => {
    const m = await runOp("frames", { src: counter, at: [1], size: "160x160", crop: "200:100:0:0", hw: "cpu" })
    const dims = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", m.outputs[0]!.path]).toString().trim()
    expect(dims).toBe("160,160")
  })
  it("scenes: finds the two cuts and writes the first frame of each shot", async () => {
    const m = await runOp("scenes", { src: shots, hw: "cpu", sheet: true })
    const frames = m.outputs.filter((o) => o.kind === "frame")
    expect(frames.length).toBe(3)
    frames.forEach((o, i) => expect(o.t).toBeCloseTo(i, 3))
    expect(m.outputs.filter((o) => o.kind === "sheet").length).toBe(1)
  })
  it("clip: copies on a keyframe, encodes off one", async () => {
    const m = await runOp("clip", { src: counter, ranges: ["0.5-1.5", "0.6+0.5"] })
    expect(m.outputs.map((o) => o.mode)).toEqual(["copy", "encode"])
    expect(m.outputs[0]!.duration).toBeCloseTo(1, 1)
    expect(m.outputs[1]!.duration).toBeCloseTo(0.5, 1)
    const first = path.join(tmp, "clipfirst.png")
    ff(["-i", m.outputs[1]!.path, "-frames:v", "1", first])
    expect(frameIndex(first)).toBe(18)
  })
  it("sheet: from an earlier manifest", async () => {
    const s = await runOp("strip", { src: counter, from: 0, to: 1, every: "250ms", hw: "cpu" })
    const m = await runOp("sheet", { manifest: path.join(s.dir!, "manifest.json"), cols: 2, width: 100 })
    expect(m.outputs.length).toBe(1)
    expect(m.outputs[0]!.width).toBe(2 * 100 + 3 * 4)
  })
  it("refuses times outside the media", async () => {
    await expect(runOp("frames", { src: counter, at: [9] })).rejects.toThrow(/outside/)
    await expect(runOp("strip", { src: counter, from: 1 })).rejects.toThrow()
  })
})

describe("mcp", () => {
  it("lists tools and runs one over stdio", async () => {
    const child = spawn(process.execPath, [path.join(HERE, "cli.ts"), "mcp"], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "inherit"],
    })
    const replies = new Map<number, Record<string, any>>()
    let buf = ""
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        replies.set(msg.id, msg)
      }
    })
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`)
    const wait = async (id: number) => {
      for (let i = 0; i < 600 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 50))
      return replies.get(id)!
    }
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
    expect((await wait(1)).result.serverInfo.name).toBe("rhapsode-cut")
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const tools = (await wait(2)).result.tools as Array<{ name: string; inputSchema: { type: string } }>
    expect(tools.map((t) => t.name)).toEqual(["probe", "fetch", "list_scenes", "frames", "strip", "clip", "contact_sheet"])
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true)
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "frames", arguments: { src: counter, at: [1], hw: "cpu" } } })
    const r = (await wait(3)).result
    expect(r.isError).toBeUndefined()
    expect(fs.existsSync(r.structuredContent.outputs[0].path)).toBe(true)
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "frames", arguments: { src: counter } } })
    expect((await wait(4)).result.isError).toBe(true)
    child.stdin.end()
    await new Promise((r) => child.on("close", r))
  })
})
