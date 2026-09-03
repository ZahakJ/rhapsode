import { runProc, parseProgressLine } from "../proc.ts"
import type { Encoder } from "../render/graph.ts"
import type { Probe } from "./probe.ts"

// Every source, URL or upload, gets one browser-scrubbable proxy transcoded
// locally: it normalises HEVC/VP9/AV1, variable frame rate, rotation and edit
// lists into an h264/aac mp4 with a keyframe every 2 s. Always transcode —
// the "skip if already fine" branch is exactly where phone videos bite.

export const PROXY_MAX_EDGE = 854
export const THUMB_HEIGHT = 360

export type ProxyOpts = {
  encoder: Encoder
  signal?: AbortSignal
  onProgress?: (p: number) => void
  timeoutMs?: number
}

export async function makeVideoProxy(src: string, out: string, probe: Probe, opts: ProxyOpts): Promise<void> {
  const landscape = probe.width >= probe.height
  const edge = Math.min(PROXY_MAX_EDGE, landscape ? probe.width : probe.height)
  const scale = landscape ? `scale=${edge}:-2:flags=bicubic` : `scale=-2:${edge}:flags=bicubic`
  const vf = `${scale},scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p`
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-y", "-progress", "pipe:1", "-i", src]
  args.push("-map", "0:v:0", "-map", "0:a:0?", "-vf", vf)
  if (opts.encoder === "h264_nvenc") {
    args.push("-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "28", "-b:v", "0", "-profile:v", "main", "-g", "60")
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-profile:v", "main", "-g", "60")
  }
  args.push("-c:a", "aac", "-b:a", "96k", "-ac", "2", "-ar", "48000", "-sn", "-dn", "-map_metadata", "-1", "-movflags", "+faststart", out)
  const dur = probe.duration || 1
  await runProc("ffmpeg", args, {
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    signal: opts.signal,
    onStdoutLine: (line) => {
      const p = parseProgressLine(line)
      if (p.outTimeS !== undefined) opts.onProgress?.(Math.min(0.99, p.outTimeS / dur))
      if (p.end) opts.onProgress?.(1)
    },
  })
}

export async function makeImageProxy(src: string, out: string, signal?: AbortSignal): Promise<void> {
  await runProc(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", src, "-frames:v", "1",
      "-vf", "scale='min(1280,iw)':-2,format=yuvj420p", "-q:v", "3", out],
    { timeoutMs: 60_000, signal },
  )
}

export async function makeThumb(src: string, out: string, probe: Probe, signal?: AbortSignal): Promise<void> {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
  if (probe.media === "video") args.push("-ss", String(Math.min(1, probe.duration / 3)))
  args.push("-i", src, "-frames:v", "1", "-vf", `scale=-2:${THUMB_HEIGHT},format=yuvj420p`, "-q:v", "4", out)
  await runProc("ffmpeg", args, { timeoutMs: 60_000, signal })
}

/** Poster for a finished render, ≤1280 wide. */
export async function makePoster(src: string, out: string, duration: number, signal?: AbortSignal): Promise<void> {
  await runProc(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", String(Math.min(1, duration / 3)), "-i", src,
      "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2,format=yuvj420p", "-q:v", "3", out],
    { timeoutMs: 60_000, signal },
  )
}
