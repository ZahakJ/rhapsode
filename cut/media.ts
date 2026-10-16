import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import { runProc } from "../server/proc.ts"

// ffprobe facts, GPU detection and the pure filter-chain builder every
// image-producing op shares.

export type MediaFacts = {
  duration: number
  width: number
  height: number
  fps: number
  vcodec: string | null
  hasAudio: boolean
  colorSpace: string | null
  pixFmt: string | null
  /** container start_time: keyframe pts from ffprobe are on this clock */
  startTime: number
}

export async function probeMedia(file: string): Promise<MediaFacts> {
  const { stdout } = await runProc(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { timeoutMs: 60_000 },
  )
  const j = JSON.parse(stdout) as {
    format?: { duration?: string; start_time?: string }
    streams?: Array<Record<string, unknown> & { codec_type?: string; disposition?: { attached_pic?: number } }>
  }
  const v = j.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic)
  if (!v) throw new Error("no video stream")
  const rate = (s: unknown) => {
    if (typeof s !== "string") return 0
    const [n, d] = s.split("/").map(Number)
    const r = d ? n! / d : n!
    return Number.isFinite(r) && r > 0 && r < 1000 ? r : 0
  }
  const str = (x: unknown) => (typeof x === "string" && x && x !== "unknown" ? x : null)
  return {
    duration: Number(j.format?.duration ?? v.duration ?? 0) || 0,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 30,
    vcodec: str(v.codec_name),
    hasAudio: !!j.streams?.some((s) => s.codec_type === "audio"),
    colorSpace: str(v.color_space),
    pixFmt: str(v.pix_fmt),
    startTime: Number(j.format?.start_time ?? 0) || 0,
  }
}

let cudaCache: boolean | null = null
/** NVDEC usable: ffmpeg built with cuda and an nvidia device node present */
export function cudaAvailable(): boolean {
  if (cudaCache !== null) return cudaCache
  try {
    const out = execFileSync("ffmpeg", ["-hide_banner", "-hwaccels"], { encoding: "utf8", timeout: 10_000 })
    cudaCache = /^\s*cuda\s*$/m.test(out) && fs.existsSync("/dev/nvidiactl")
  } catch {
    cudaCache = false
  }
  return cudaCache
}

let nvencCache: Promise<boolean> | null = null
export function nvencAvailable(): Promise<boolean> {
  nvencCache ??= runProc(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=256x256:d=0.2",
      "-c:v", "h264_nvenc", "-f", "null", "-"],
    { timeoutMs: 20_000 },
  ).then(() => true, () => false)
  return nvencCache
}

export type Hw = "auto" | "cuda" | "cpu"
/**
 * NVDEC pays ~0.3 s to start, a GPU→RAM copy per frame, and tops out near
 * 460 fps at 1080p on a single session. A 16-thread CPU decoder beat it on
 * every measured case (2 s strip: 0.9 s vs 1.9 s; scene scan of 3 min
 * 1080p60: 4.3 s vs 13.7 s; h264, hevc and av1 alike). So auto decodes on
 * the CPU and only falls to NVDEC on small machines; NVENC still encodes.
 */
export function useCuda(hw: Hw, _spanS: number): boolean {
  return hw === "cuda" || (hw === "auto" && os.availableParallelism() < 8 && cudaAvailable())
}
export function decodeArgs(hw: Hw, spanS: number): string[] {
  return useCuda(hw, spanS) ? ["-hwaccel", "cuda"] : []
}
export const decoderName = (hw: Hw, spanS: number) => (useCuda(hw, spanS) ? "nvdec" : "cpu")

export type Fit = "cover" | "contain" | "stretch"
export type Look = {
  /** pixels on the source: w:h:x:y */
  crop?: string | null
  /** "640x360", "640x" (width), "x360" (height) */
  size?: string | null
  fit?: Fit
}

export function parseSize(s: string): { w: number | null; h: number | null } {
  const m = s.trim().match(/^(\d+)?(?:x(\d+)?)?$/i)
  if (!m || (!m[1] && !m[2])) throw new Error(`bad size "${s}" (use 640x360, 640x or x360)`)
  const w = m[1] ? Number(m[1]) : null
  const h = m[2] ? Number(m[2]) : null
  for (const n of [w, h]) if (n !== null && (n < 8 || n > 8192)) throw new Error(`size out of range: ${s}`)
  return { w, h }
}

/**
 * Filters for a still/clip: tag untagged HD as BT.709 (otherwise RGB output
 * is converted with BT.601 and greens/reds shift), crop, then scale to the
 * target with lanczos. Even dims where a side is derived.
 */
export function lookFilters(look: Look, facts: Pick<MediaFacts, "colorSpace" | "height">): string[] {
  const f: string[] = []
  if (!facts.colorSpace && facts.height >= 720) f.push("setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709")
  if (look.crop) {
    const m = look.crop.trim().match(/^(\d+):(\d+):(\d+):(\d+)$/)
    if (!m) throw new Error(`bad crop "${look.crop}" (use w:h:x:y in source pixels)`)
    f.push(`crop=${m[1]}:${m[2]}:${m[3]}:${m[4]}`)
  }
  if (look.size) {
    const { w, h } = parseSize(look.size)
    if (w && h) {
      const fit = look.fit ?? "cover"
      if (fit === "cover") f.push(`scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${w}:${h}`)
      else if (fit === "contain")
        f.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`)
      else f.push(`scale=${w}:${h}:flags=lanczos`)
    } else if (w) f.push(`scale=${w}:-2:flags=lanczos`)
    else f.push(`scale=-2:${h}:flags=lanczos`)
  }
  return f
}

export type ImageFormat = "png" | "jpg" | "webp"
export function imageArgs(fmt: ImageFormat, quality: number | undefined): string[] {
  if (fmt === "jpg") return ["-q:v", String(quality ?? 3)]
  if (fmt === "webp") return ["-quality", String(quality ?? 90)]
  return ["-compression_level", "3"]
}
/** final pixel format so every op hands back the same thing */
export function imagePixFmt(fmt: ImageFormat): string {
  return fmt === "png" ? "format=rgb24" : fmt === "jpg" ? "format=yuvj444p" : "format=yuv420p"
}

/** showinfo "n: 3 pts: 3003 pts_time:0.1001" lines → [n, pts_time] */
export function parseShowinfo(line: string): { n: number; t: number } | null {
  const m = line.match(/showinfo.*\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+(?:e[-+]?\d+)?)/)
  return m ? { n: Number(m[1]), t: Number(m[2]) } : null
}

/** run async jobs with at most `limit` in flight; keeps order */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}
