import fs from "node:fs"
import path from "node:path"
import { runProc } from "../proc.ts"

// yt-dlp, argv only. The generic extractor is off so only hosts a
// site-specific extractor recognises are ever contacted; the URL itself has
// already passed the ssrf gate before anything here runs.

// YouTube binds format URLs to the player client that produced them and
// refuses ffmpeg's follow-up fetch for some (android_vr, its 2026 default:
// HTTP 403 on every sectioned download). These three answer both the native
// downloader and ffmpeg, and still expose 1080p avc1 + m4a. Override with
// YTDLP_PLAYER_CLIENTS when YouTube moves again.
const PLAYER_CLIENTS = process.env.YTDLP_PLAYER_CLIENTS ?? "mweb,web_embedded,android"

const COMMON = [
  "--no-cache-dir",
  "--extractor-args", `youtube:player_client=${PLAYER_CLIENTS}`,
  "--no-playlist",
  "--use-extractors", "default,-generic",
  "--socket-timeout", "20",
  "--extractor-retries", "2",
  "--no-warnings",
]

export type UrlMeta = {
  title: string
  duration: number | null
  width: number | null
  height: number | null
  isLive: boolean
  extractor: string
  webpageUrl: string
}

function env(jobDir: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: jobDir, TMPDIR: jobDir, LANG: "C.UTF-8" }
}

export async function ytMetadata(url: string, jobDir: string, signal?: AbortSignal): Promise<UrlMeta> {
  fs.mkdirSync(jobDir, { recursive: true })
  const { stdout } = await runProc("yt-dlp", [...COMMON, "--dump-single-json", "--skip-download", "--", url], {
    cwd: jobDir,
    env: env(jobDir),
    timeoutMs: 60_000,
    signal,
  })
  const j = JSON.parse(stdout) as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
  return {
    title: typeof j.title === "string" ? j.title : "",
    duration: num(j.duration),
    width: num(j.width),
    height: num(j.height),
    isLive: j.is_live === true,
    extractor: typeof j.extractor === "string" ? j.extractor : "",
    webpageUrl: typeof j.webpage_url === "string" ? j.webpage_url : url,
  }
}

export type DownloadOpts = {
  /** absolute seconds on the original; omitted = whole video */
  window?: { start: number; end: number }
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
  /** percent 0..1, or null when yt-dlp cannot say (sectioned downloads) */
  onProgress?: (p: number | null, bytesOnDisk: number) => void
}

/** Downloads ≤1080p into jobDir/orig.<ext>; returns the file path. */
export async function ytDownload(url: string, jobDir: string, opts: DownloadOpts): Promise<string> {
  fs.mkdirSync(jobDir, { recursive: true })
  const args = [
    ...COMMON,
    "--retries", "3",
    "--fragment-retries", "3",
    "--no-mtime",
    "--no-part",
    "--no-continue",
    "-f", "bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
    "--merge-output-format", "mp4",
    "--max-filesize", String(opts.maxBytes),
    "--newline",
    "--progress",
    "--progress-template", "download:RH %(progress._percent_str)s",
    "-P", jobDir,
    "-o", "orig.%(ext)s",
  ]
  if (opts.window) {
    args.push("--download-sections", `*${opts.window.start.toFixed(2)}-${opts.window.end.toFixed(2)}`)
  }
  args.push("--", url)

  const ac = new AbortController()
  const onOuter = () => ac.abort()
  opts.signal?.addEventListener("abort", onOuter, { once: true })
  let overCap = false
  const bytesOnDisk = () => {
    let total = 0
    try {
      for (const f of fs.readdirSync(jobDir)) {
        try {
          total += fs.statSync(path.join(jobDir, f)).size
        } catch {
          /* mid-rename */
        }
      }
    } catch {
      /* dir gone */
    }
    return total
  }
  // --max-filesize is advisory for streamed/sectioned formats: police the dir
  const watchdog = setInterval(() => {
    const b = bytesOnDisk()
    if (b > opts.maxBytes) {
      overCap = true
      ac.abort()
    } else if (opts.window) opts.onProgress?.(null, b)
  }, 1000)
  try {
    await runProc("yt-dlp", args, {
      cwd: jobDir,
      env: env(jobDir),
      timeoutMs: opts.timeoutMs,
      signal: ac.signal,
      onStdoutLine: (line) => {
        const m = line.match(/^RH\s+([\d.]+)%/)
        if (m && !opts.window) opts.onProgress?.(Math.min(0.999, Number(m[1]) / 100), 0)
      },
    })
  } catch (err) {
    if (overCap) throw new Error("the download exceeded the size cap")
    throw err
  } finally {
    clearInterval(watchdog)
    opts.signal?.removeEventListener("abort", onOuter)
  }
  const file = fs.readdirSync(jobDir).find((f) => f.startsWith("orig."))
  if (!file) throw new Error("yt-dlp produced no file")
  return path.join(jobDir, file)
}
