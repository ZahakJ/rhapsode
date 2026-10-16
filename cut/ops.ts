import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { runProc } from "../server/proc.ts"
import {
  cudaAvailable, decodeArgs, decoderName, imageArgs, imagePixFmt, lookFilters, nvencAvailable, parseShowinfo,
  pool, probeMedia, type Hw, type ImageFormat, type Look, type MediaFacts,
} from "./media.ts"
import { cachedEntries, isUrl, resolveFile, resolveSource, sha256File, urlInfo, type CacheEntry, type Resolved, type SourceInfo } from "./source.ts"
import { fmtTime, parseInterval, parseRange, parseTime, stamp } from "./time.ts"

// The operations, shared by the CLI and the MCP server. Each takes one
// zod-checked params object, writes files into an output directory and
// returns (and writes) a manifest that says exactly where every file came
// from: source URL/id/title/uploader, the cached media's sha256, the asked
// and the actual frame times, and every output's sha256.

const Time = z.union([z.number().nonnegative(), z.string()]).describe("seconds, 1:02.5, 01:02:03 or 1500ms")

const SourceFields = {
  src: z.string().min(1).describe("http(s) URL (fetched with yt-dlp, cached) or a local video path"),
  height: z.number().int().min(144).max(4320).optional().describe("max height to fetch for URLs (default 1080)"),
}

const LookFields = {
  size: z.string().optional().describe('output size: "640x360" (fit applies), "640x" (width) or "x360" (height)'),
  fit: z.enum(["cover", "contain", "stretch"]).optional().describe("cover = scale+centre-crop (default), contain = letterbox"),
  crop: z.string().optional().describe("source-pixel crop w:h:x:y, applied before size"),
}

const ImageFields = {
  ...LookFields,
  format: z.enum(["png", "jpg", "webp"]).optional().describe("image format (default png)"),
  quality: z.number().optional().describe("jpg: -q:v 2..31 (lower is better, default 3); webp: 0..100"),
  sheet: z.boolean().optional().describe("also build a labelled contact sheet of the frames"),
  sheetWidth: z.number().int().min(64).max(1920).optional().describe("contact sheet thumbnail width (default 320)"),
}

const RunFields = {
  out: z.string().optional().describe("output directory (default ./rhapsode-cut/<op>-<source>-<start>)"),
  hw: z.enum(["auto", "cuda", "cpu"]).optional().describe("decode on the GPU (NVDEC) when available"),
  jobs: z.number().int().min(1).max(32).optional().describe("parallel ffmpeg processes (default: half the cores, 2..8)"),
}

export const schemas = {
  probe: z.object({ ...SourceFields }),
  fetch: z.object({
    ...SourceFields,
    from: Time.optional(),
    to: Time.optional(),
    audio: z.boolean().optional().describe("include audio (default true)"),
  }),
  frames: z.object({
    ...SourceFields,
    at: z.array(Time).min(1).max(500).describe("timestamps"),
    ...ImageFields,
    ...RunFields,
  }),
  strip: z.object({
    ...SourceFields,
    from: Time,
    to: Time,
    every: z.union([z.number().positive(), z.string()]).optional().describe('frame spacing: "67ms", 0.067 or "15fps" (default 15fps)'),
    ...ImageFields,
    ...RunFields,
  }),
  scenes: z.object({
    ...SourceFields,
    from: Time.optional(),
    to: Time.optional(),
    threshold: z.number().min(0.01).max(1).optional().describe("scene score cut-off 0..1 (default 0.3)"),
    max: z.number().int().min(1).max(500).optional().describe("keep at most N strongest cuts (default 60)"),
    extract: z.boolean().optional().describe("write a frame per scene (default true)"),
    ...ImageFields,
    ...RunFields,
  }),
  clip: z.object({
    ...SourceFields,
    ranges: z.array(z.union([z.string(), z.object({ from: Time, to: Time })])).min(1).max(50)
      .describe('ranges: "12-20", "1:00-1:05", "12+3" or {from,to}'),
    mode: z.enum(["auto", "copy", "encode"]).optional()
      .describe("auto = stream copy when the cut starts on a keyframe and no size/crop is asked, else encode"),
    ...LookFields,
    ...RunFields,
  }),
  sheet: z.object({
    manifest: z.string().optional().describe("manifest.json from frames/strip/scenes"),
    images: z.array(z.string()).optional().describe("image paths (label = file name)"),
    cols: z.number().int().min(1).max(16).optional(),
    width: z.number().int().min(64).max(1920).optional().describe("thumbnail width (default 320)"),
    format: z.enum(["png", "jpg", "webp"]).optional().describe("sheet format (default jpg)"),
    out: z.string().optional(),
  }),
} as const

export type OpName = keyof typeof schemas
export type Params<K extends OpName> = z.infer<(typeof schemas)[K]>

export type Output = {
  kind: "frame" | "clip" | "sheet" | "media"
  path: string
  sha256: string
  bytes: number
  /** frames: the asked time and the source time of the frame actually written */
  requested?: number
  t?: number
  tc?: string
  score?: number | null
  start?: number
  end?: number
  duration?: number
  mode?: "copy" | "encode"
  width?: number
  height?: number
}

export type Manifest = {
  rhapsode: "cut/1"
  op: OpName
  created: string
  dir: string | null
  source: (SourceInfo & {
    file: string
    sha256: string
    /** source seconds at the cached file's t=0 */
    offset: number
    cacheHit: boolean
    fetchMs: number
    media: MediaFacts
  }) | null
  params: Record<string, unknown>
  decode: string | null
  encode: string | null
  elapsedMs: number
  outputs: Output[]
  notes: string[]
  /** probe of a URL: what yt-dlp says plus what is already cached */
  info?: SourceInfo
  cached?: CacheEntry[]
}

const FONT_CANDIDATES = [
  "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  "/usr/share/fonts/noto/NotoSansMono-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf",
]
const HERE = path.dirname(fileURLToPath(import.meta.url))
function labelFont(): string {
  return FONT_CANDIDATES.find((f) => fs.existsSync(f)) ?? path.join(HERE, "../server/render/fonts/Anton-Regular.ttf")
}

const DEFAULT_JOBS = Math.max(2, Math.min(8, Math.floor(os.availableParallelism() / 2)))
const BASE = ["-hide_banner", "-nostdin", "-nostats", "-y"]

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "source"
}

function outDir(explicit: string | undefined, op: string, src: string, start: number | null): string {
  if (explicit) {
    fs.mkdirSync(explicit, { recursive: true })
    return path.resolve(explicit)
  }
  const root = process.env.RHAPSODE_CUT_OUT ?? path.join(process.cwd(), "rhapsode-cut")
  const base = `${op}-${slug(src)}${start === null ? "" : `-${stamp(start).replace(/^0+(?=\d)/, "")}s`}`
  let dir = path.join(root, base)
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${base}-${i}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function describe(file: string, kind: Output["kind"], extra: Partial<Output> = {}): Promise<Output> {
  return { kind, path: file, sha256: await sha256File(file), bytes: fs.statSync(file).size, ...extra }
}

type Ctx = {
  r: Resolved
  facts: MediaFacts
  dir: string
  hw: Hw
  jobs: number
  notes: string[]
}

async function open(src: string, height: number | undefined, win: { start: number; end: number } | null, audio: boolean) {
  const r = await resolveSource(src, { start: win?.start ?? null, end: win?.end ?? null, maxHeight: height, audio })
  const facts = await probeMedia(r.file)
  return { r, facts }
}

function manifestOf(op: OpName, params: Record<string, unknown>, ctx: Pick<Ctx, "r" | "facts"> | null, dir: string | null): Manifest {
  return {
    rhapsode: "cut/1",
    op,
    created: new Date().toISOString(),
    dir,
    source: ctx
      ? {
          ...ctx.r.info,
          duration: ctx.r.info.duration ?? ctx.facts.duration,
          file: ctx.r.file,
          sha256: ctx.r.sha256,
          offset: ctx.r.offset,
          cacheHit: ctx.r.cache.hit,
          fetchMs: ctx.r.cache.fetchMs,
          media: ctx.facts,
        }
      : null,
    params,
    decode: null,
    encode: null,
    elapsedMs: 0,
    outputs: [],
    notes: [],
  }
}

function finish(m: Manifest, t0: number): Manifest {
  m.elapsedMs = Math.round(performance.now() - t0)
  if (m.dir) fs.writeFileSync(path.join(m.dir, "manifest.json"), JSON.stringify(m, null, 2))
  return m
}

/** source time → time inside the cached file, refusing what the file does not hold */
function local(ctx: Ctx, t: number): number {
  const lt = t - ctx.r.offset
  if (lt < 0 || (ctx.facts.duration && lt > ctx.facts.duration)) {
    throw new Error(`time ${t}s is outside the media (${ctx.r.offset}s..${(ctx.r.offset + ctx.facts.duration).toFixed(3)}s)`)
  }
  return lt
}

// ---------------------------------------------------------------- frames

async function grab(ctx: Ctx, t: number, file: string, filters: string[], fmt: ImageFormat, q: number | undefined, seekEps = 0) {
  const lt = Math.max(0, local(ctx, t) - seekEps)
  let pts: number | null = null
  await runProc(
    "ffmpeg",
    [
      ...BASE, "-loglevel", "info", ...decodeArgs(ctx.hw, 0),
      "-ss", lt.toFixed(6), "-i", ctx.r.file,
      "-an", "-sn", "-dn", "-frames:v", "1",
      "-vf", ["showinfo", ...filters, imagePixFmt(fmt)].join(","),
      ...imageArgs(fmt, q), "-update", "1", file,
    ],
    {
      timeoutMs: 120_000,
      onStderrLine: (l) => {
        const s = parseShowinfo(l)
        if (s && pts === null) pts = s.t
      },
    },
  )
  if (!fs.existsSync(file)) throw new Error(`no frame at ${t}s (past the end?)`)
  return ctx.r.offset + lt + (pts ?? 0)
}

export async function frames(p: Params<"frames">): Promise<Manifest> {
  const t0 = performance.now()
  const times = p.at.map(parseTime)
  const win = { start: Math.min(...times), end: Math.max(...times) + 0.5 }
  const { r, facts } = await open(p.src, p.height, win, false)
  const dir = outDir(p.out, "frames", r.info.title || p.src, win.start)
  const ctx: Ctx = { r, facts, dir, hw: p.hw ?? "auto", jobs: p.jobs ?? DEFAULT_JOBS, notes: [] }
  const m = manifestOf("frames", p, ctx, dir)
  const fmt = p.format ?? "png"
  const filters = lookFilters(p, facts)
  m.decode = decoderName(ctx.hw, 0)
  m.outputs = await pool(times, ctx.jobs, async (t, i) => {
    const file = path.join(dir, `${String(i + 1).padStart(4, "0")}_t${stamp(t)}.${fmt}`)
    const actual = await grab(ctx, t, file, filters, fmt, p.quality)
    return describe(file, "frame", { requested: t, t: round6(actual), tc: fmtTime(actual) })
  })
  if (p.sheet) m.outputs.push(...(await sheetOf(m.outputs, dir, { width: p.sheetWidth })))
  return finish(m, t0)
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

// ---------------------------------------------------------------- strip

/**
 * select expression: keep the first frame at or after each grid point
 * k·step (relative to the seek point). Register 0 holds the next grid point.
 */
export function gridSelect(step: number): string {
  const e = 1e-4
  return `select='if(gte(t+${e},ld(0)),st(0,${step}*(floor((t+${e})/${step})+1))*0+1,0)'`
}

export async function strip(p: Params<"strip">): Promise<Manifest> {
  const t0 = performance.now()
  const { start, end } = parseRange({ from: p.from, to: p.to })
  const step = parseInterval(p.every ?? "15fps")
  const { r, facts } = await open(p.src, p.height, { start, end }, false)
  const dir = outDir(p.out, "strip", r.info.title || p.src, start)
  const ctx: Ctx = { r, facts, dir, hw: p.hw ?? "auto", jobs: p.jobs ?? DEFAULT_JOBS, notes: [] }
  const m = manifestOf("strip", p, ctx, dir)
  m.decode = decoderName(ctx.hw, end - start)
  const fmt = p.format ?? "png"
  const filters = lookFilters(p, facts)
  const n = Math.max(1, Math.ceil((end - start) / step - 1e-6))
  if (n > 5000) throw new Error(`${n} frames asked; cap is 5000 — widen the spacing or narrow the window`)
  // chunks of grid points; each chunk is its own ffmpeg seek (parallel)
  // a chunk re-decodes from the keyframe before it, so chunks under ~2 s cost more than they save
  const per = Math.max(Math.ceil(2 / step), Math.ceil(n / ctx.jobs))
  const chunks: Array<[number, number]> = []
  for (let i = 0; i < n; i += per) chunks.push([i, Math.min(n, i + per)])
  const tmp = fs.mkdtempSync(path.join(dir, ".strip-"))
  const got = await pool(chunks, ctx.jobs, async ([i0, i1], k) => {
    const cStart = start + i0 * step
    const lt = local(ctx, cStart)
    const times: number[] = []
    await runProc(
      "ffmpeg",
      [
        ...BASE, "-loglevel", "info", ...decodeArgs(ctx.hw, end - start),
        "-ss", lt.toFixed(6), "-t", ((i1 - i0) * step).toFixed(6), "-i", r.file,
        "-an", "-sn", "-dn",
        "-vf", [gridSelect(step), "showinfo", ...filters, imagePixFmt(fmt)].join(","),
        "-fps_mode", "passthrough",
        ...imageArgs(fmt, p.quality), path.join(tmp, `c${k}_%05d.${fmt}`),
      ],
      {
        timeoutMs: 10 * 60_000,
        onStderrLine: (l) => {
          const s = parseShowinfo(l)
          if (s) times[s.n] = s.t
        },
      },
    )
    return times.map((t, j) => ({ file: path.join(tmp, `c${k}_${String(j + 1).padStart(5, "0")}.${fmt}`), t: cStart + t, base: cStart }))
  })
  const all = got.flat().filter((x) => fs.existsSync(x.file))
  m.outputs = await pool(all, 8, async (x, i) => {
    const gridIdx = Math.floor((x.t - start + 1e-4) / step)
    const file = path.join(dir, `${String(i + 1).padStart(4, "0")}_t${stamp(x.t)}.${fmt}`)
    fs.renameSync(x.file, file)
    return describe(file, "frame", { requested: round6(start + gridIdx * step), t: round6(x.t), tc: fmtTime(x.t) })
  })
  fs.rmSync(tmp, { recursive: true, force: true })
  if (m.outputs.length < n) {
    m.notes.push(`${n} grid points, ${m.outputs.length} distinct frames: the source has fewer frames than asked in places (${facts.fps.toFixed(3)} fps)`)
  }
  if (p.sheet) m.outputs.push(...(await sheetOf(m.outputs, dir, { width: p.sheetWidth })))
  return finish(m, t0)
}

// ---------------------------------------------------------------- scenes

/** `metadata=print` stdout → [{t, score}] */
export function parseSceneLines(lines: string[]): Array<{ t: number; score: number }> {
  const out: Array<{ t: number; score: number }> = []
  let t: number | null = null
  for (const l of lines) {
    const f = l.match(/^frame:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+)/)
    if (f) t = Number(f[1])
    const s = l.match(/^lavfi\.scene_score=([\d.]+)/)
    if (s && t !== null) {
      out.push({ t, score: Number(s[1]) })
      t = null
    }
  }
  return out
}

export async function scenes(p: Params<"scenes">): Promise<Manifest> {
  const t0 = performance.now()
  const win = p.from !== undefined || p.to !== undefined
    ? { start: p.from !== undefined ? parseTime(p.from) : 0, end: p.to !== undefined ? parseTime(p.to) : Infinity }
    : null
  const fetchWin = win && Number.isFinite(win.end) ? win : null
  const { r, facts } = await open(p.src, p.height, fetchWin, false)
  const start = win?.start ?? r.offset
  const end = Math.min(win?.end ?? Infinity, r.offset + facts.duration)
  const extract = p.extract ?? true
  const dir = extract || p.out ? outDir(p.out, "scenes", r.info.title || p.src, start) : null
  const ctx: Ctx = { r, facts, dir: dir ?? "", hw: p.hw ?? "auto", jobs: p.jobs ?? DEFAULT_JOBS, notes: [] }
  const m = manifestOf("scenes", p, ctx, dir)
  m.decode = decoderName(ctx.hw, end - start)
  const gpu = m.decode === "nvdec"
  const lines: string[] = []
  await runProc(
    "ffmpeg",
    [
      ...BASE, "-loglevel", "error", ...(gpu ? ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"] : []),
      "-ss", local(ctx, start).toFixed(6), "-t", (end - start).toFixed(6), "-i", r.file,
      "-an", "-sn", "-dn",
      "-vf", [
        gpu ? "scale_cuda=320:-2,hwdownload,format=nv12" : "scale=320:-2:flags=fast_bilinear",
        `select='gt(scene,${p.threshold ?? 0.3})'`,
        "metadata=print:file=-",
      ].join(","),
      "-fps_mode", "passthrough", "-f", "null", "-",
    ],
    { timeoutMs: 60 * 60_000, onStdoutLine: (l) => lines.push(l) },
  )
  let cuts = parseSceneLines(lines).map((c) => ({ t: start + c.t, score: c.score }))
  const max = p.max ?? 60
  if (cuts.length > max) {
    m.notes.push(`${cuts.length} cuts above threshold; kept the ${max} strongest`)
    cuts = [...cuts].sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.t - b.t)
  }
  const shots: Array<{ t: number; score: number | null }> = [{ t: start, score: null }, ...cuts]
  const fmt = p.format ?? "png"
  if (extract && dir) {
    const filters = lookFilters(p, facts)
    m.outputs = await pool(shots, ctx.jobs, async (s, i) => {
      const file = path.join(dir, `${String(i + 1).padStart(4, "0")}_t${stamp(s.t)}.${fmt}`)
      // the cut time is the frame's own pts: back off half a millisecond so rounding never skips it
      const actual = await grab(ctx, s.t, file, filters, fmt, p.quality, 0.0005)
      return describe(file, "frame", { requested: round6(s.t), t: round6(actual), tc: fmtTime(actual), score: s.score })
    })
    if (p.sheet) m.outputs.push(...(await sheetOf(m.outputs, dir, { width: p.sheetWidth })))
  } else {
    m.outputs = shots.map((s) => ({ kind: "frame", path: "", sha256: "", bytes: 0, t: round6(s.t), tc: fmtTime(s.t), score: s.score }))
  }
  return finish(m, t0)
}

// ---------------------------------------------------------------- clip

async function keyframesNear(ctx: Ctx, lt: number): Promise<number[]> {
  const a = Math.max(0, lt - 3)
  const { stdout } = await runProc(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time",
      "-of", "csv=p=0", "-read_intervals", `${a.toFixed(3)}%${(lt + 0.5).toFixed(3)}`, ctx.r.file],
    { timeoutMs: 60_000 },
  )
  return stdout.split("\n").map(Number).filter((n) => Number.isFinite(n)).map((n) => n - ctx.facts.startTime)
}

export async function clip(p: Params<"clip">): Promise<Manifest> {
  const t0 = performance.now()
  const ranges = p.ranges.map(parseRange)
  const win = { start: Math.min(...ranges.map((r) => r.start)), end: Math.max(...ranges.map((r) => r.end)) }
  const { r, facts } = await open(p.src, p.height, win, true)
  const dir = outDir(p.out, "clip", r.info.title || p.src, win.start)
  const ctx: Ctx = { r, facts, dir, hw: p.hw ?? "auto", jobs: p.jobs ?? DEFAULT_JOBS, notes: [] }
  const m = manifestOf("clip", p, ctx, dir)
  const filters = lookFilters(p, facts).filter((f) => !f.startsWith("setparams"))
  const nvenc = await nvencAvailable()
  const encoder = nvenc ? "h264_nvenc" : "libx264"
  const frameDur = 1 / (facts.fps || 30)
  m.outputs = await pool(ranges, ctx.jobs, async (rg, i) => {
    const ls = local(ctx, rg.start)
    const le = Math.min(local(ctx, rg.end), facts.duration)
    let mode: "copy" | "encode" = p.mode === "copy" ? "copy" : "encode"
    if ((p.mode ?? "auto") === "auto" && filters.length === 0) {
      const keys = await keyframesNear(ctx, ls)
      if (keys.some((k) => Math.abs(k - ls) < frameDur / 2)) mode = "copy"
    }
    const file = path.join(dir, `${String(i + 1).padStart(2, "0")}_${stamp(rg.start)}-${stamp(rg.end)}.mp4`)
    const head = [...BASE, "-loglevel", "error"]
    const io = ["-ss", ls.toFixed(6), "-to", le.toFixed(6), "-i", r.file, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"]
    if (mode === "copy") {
      await runProc("ffmpeg", [...head, ...io, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", file], { timeoutMs: 10 * 60_000 })
    } else {
      const venc = nvenc
        ? ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]
      await runProc(
        "ffmpeg",
        [...head, ...decodeArgs(ctx.hw, rg.end - rg.start), ...io, "-vf", [...filters, "format=yuv420p"].join(","), ...venc,
          "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", file],
        { timeoutMs: 30 * 60_000 },
      )
    }
    const out = await probeMedia(file)
    return describe(file, "clip", {
      start: rg.start, end: rg.end, mode, duration: round6(out.duration), width: out.width, height: out.height,
    })
  })
  m.decode = m.outputs.some((o) => o.mode === "encode") ? decoderName(ctx.hw, Math.max(...ranges.map((x) => x.end - x.start))) : null
  m.encode = m.outputs.some((o) => o.mode === "encode") ? encoder : m.outputs.length ? "copy" : null
  if (m.outputs.some((o) => o.mode === "copy")) {
    m.notes.push("copied clips start on a keyframe; their first frame is the asked start (mode=encode forces a re-encode)")
  }
  return finish(m, t0)
}

// ---------------------------------------------------------------- sheet

async function sheetOf(frames: Output[], dir: string, o: { width?: number; cols?: number; format?: ImageFormat }): Promise<Output[]> {
  const items = frames.filter((f) => f.kind === "frame" && f.path)
  if (!items.length) return []
  const w = o.width ?? 320
  const first = await probeMedia(items[0]!.path).catch(() => null)
  const aspect = first && first.width ? first.height / first.width : 9 / 16
  const h = Math.max(16, Math.round((w * aspect) / 2) * 2)
  const band = Math.max(16, Math.round(w / 14))
  const font = labelFont()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rhapsode-sheet-"))
  try {
    await pool(items, 8, async (f, i) => {
      const txt = path.join(tmp, `${i}.txt`)
      fs.writeFileSync(txt, f.t !== undefined ? `${fmtTime(f.t)}  #${i + 1}` : path.basename(f.path))
      await runProc("ffmpeg", [
        ...BASE, "-loglevel", "error", "-i", f.path,
        "-vf", [
          `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
          `pad=${w}:${h + band}:(ow-iw)/2:(${h}-ih)/2:color=0x101114`,
          `drawtext=textfile=${txt}:fontfile=${font}:fontsize=${Math.round(band * 0.62)}:fontcolor=0xe8e8e8:x=6:y=${h}+(${band}-th)/2:expansion=none`,
          "format=rgb24",
        ].join(","),
        "-frames:v", "1", "-update", "1", path.join(tmp, `${String(i + 1).padStart(5, "0")}.png`),
      ], { timeoutMs: 60_000 })
    })
    const cols = o.cols ?? Math.min(8, Math.max(1, Math.ceil(Math.sqrt(items.length))))
    const rows = Math.min(8, Math.ceil(items.length / cols))
    const fmt = o.format ?? "jpg"
    const pattern = path.join(dir, `sheet_%02d.${fmt}`)
    for (const f of fs.readdirSync(dir)) if (/^sheet_\d+\./.test(f)) fs.rmSync(path.join(dir, f))
    await runProc("ffmpeg", [
      ...BASE, "-loglevel", "error", "-framerate", "1", "-i", path.join(tmp, "%05d.png"),
      "-vf", `tile=${cols}x${rows}:padding=4:margin=4:color=0x101114,${imagePixFmt(fmt)}`,
      "-fps_mode", "passthrough", ...imageArgs(fmt, undefined), "-start_number", "1", pattern,
    ], { timeoutMs: 120_000 })
    const sheets = fs.readdirSync(dir).filter((f) => /^sheet_\d+\./.test(f)).sort()
    return Promise.all(sheets.map(async (f) => {
      const full = path.join(dir, f)
      const facts = await probeMedia(full)
      return describe(full, "sheet", { width: facts.width, height: facts.height })
    }))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export async function sheet(p: Params<"sheet">): Promise<Manifest> {
  const t0 = performance.now()
  let frames: Output[]
  let dir: string
  let prior: Manifest | null = null
  if (p.manifest) {
    prior = JSON.parse(fs.readFileSync(p.manifest, "utf8")) as Manifest
    frames = prior.outputs.filter((o) => o.kind === "frame")
    dir = p.out ? outDir(p.out, "sheet", "", null) : path.dirname(path.resolve(p.manifest))
  } else if (p.images?.length) {
    frames = p.images.map((f) => ({ kind: "frame", path: path.resolve(f), sha256: "", bytes: 0 }))
    dir = outDir(p.out, "sheet", path.basename(path.dirname(path.resolve(p.images[0]!))), null)
  } else throw new Error("give a manifest or images")
  const m = manifestOf("sheet", p, null, p.manifest && !p.out ? null : dir)
  m.source = prior?.source ?? null
  m.outputs = await sheetOf(frames, dir, { width: p.width, cols: p.cols, format: p.format })
  return finish(m, t0)
}

// ---------------------------------------------------------------- probe / fetch

export async function probe(p: Params<"probe">): Promise<Manifest> {
  const t0 = performance.now()
  if (isUrl(p.src)) {
    const info = await urlInfo(p.src)
    const m = manifestOf("probe", p, null, null)
    m.info = info
    m.cached = cachedEntries(info.key)
    return finish(m, t0)
  }
  const r = await resolveFile(p.src)
  const facts = await probeMedia(r.file)
  const m = manifestOf("probe", p, { r, facts }, null)
  m.decode = cudaAvailable() ? "nvdec" : "cpu"
  m.encode = (await nvencAvailable()) ? "h264_nvenc" : "libx264"
  return finish(m, t0)
}

export async function fetchOp(p: Params<"fetch">): Promise<Manifest> {
  const t0 = performance.now()
  if (!isUrl(p.src)) throw new Error("fetch takes a URL")
  const win = p.from !== undefined && p.to !== undefined ? parseRange({ from: p.from, to: p.to }) : null
  const { r, facts } = await open(p.src, p.height, win, p.audio ?? true)
  const m = manifestOf("fetch", p, { r, facts }, null)
  m.outputs = [{ kind: "media", path: r.file, sha256: r.sha256, bytes: fs.statSync(r.file).size, start: r.offset, duration: facts.duration, width: facts.width, height: facts.height }]
  return finish(m, t0)
}

export const ops: { [K in OpName]: (p: Params<K>) => Promise<Manifest> } = {
  probe, fetch: fetchOp, frames, strip, scenes, clip, sheet,
}

export function runOp<K extends OpName>(op: K, raw: unknown): Promise<Manifest> {
  const r = schemas[op].safeParse(raw)
  if (!r.success) return Promise.reject(new Error(z.prettifyError(r.error)))
  return ops[op](r.data as Params<K>)
}
