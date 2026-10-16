import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runProc } from "../server/proc.ts"

// Where a cut reads from: a local file, or a URL that yt-dlp fetches once
// into a cache. A URL is resolved to its video id once (index.json), so the
// same link never costs a second metadata call; downloads are kept per
// (window, max height, with/without audio) and any cached file that covers
// the asked window at an equal or higher height is reused.

export const CACHE_DIR =
  process.env.RHAPSODE_CUT_CACHE ??
  path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "rhapsode", "cut")

const PLAYER_CLIENTS = process.env.YTDLP_PLAYER_CLIENTS ?? "mweb,web_embedded,android"
/** seconds fetched either side of the asked window: keyframe slack + room for nearby frames */
const PAD = 2

export type SourceInfo = {
  kind: "url" | "file"
  url: string | null
  key: string
  id: string | null
  extractor: string | null
  title: string
  uploader: string | null
  channelUrl: string | null
  uploadDate: string | null
  duration: number | null
  /** tallest format the site lists (null when unknown) */
  height: number | null
  webpageUrl: string | null
}

export type CacheEntry = {
  file: string
  /** source seconds the file starts at; null = whole video */
  start: number | null
  end: number | null
  /** the yt-dlp height cap it was fetched with */
  maxHeight: number
  /** height actually delivered (YouTube sometimes serves only 360p) */
  height: number
  audio: boolean
  bytes: number
  sha256: string
  fetchedAt: string
}

export type Resolved = {
  info: SourceInfo
  /** local media file to read */
  file: string
  /** source time at the file's t=0 */
  offset: number
  sha256: string
  cache: { hit: boolean; entry: CacheEntry | null; fetchMs: number }
}

export const isUrl = (s: string) => /^https?:\/\//i.test(s)

function readJson<T>(p: string, dflt: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T
  } catch {
    return dflt
  }
}

function writeJson(p: string, v: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2))
  fs.renameSync(tmp, p)
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256")
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) h.update(chunk as Buffer)
  return h.digest("hex")
}

function safeKey(s: string) {
  return s.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120)
}

function ytEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? os.homedir(), LANG: "C.UTF-8" }
}

const COMMON = [
  "--extractor-args", `youtube:player_client=${PLAYER_CLIENTS}`,
  "--no-playlist",
  "--socket-timeout", "20",
  "--extractor-retries", "2",
  "--no-warnings",
]

/** URL → info, from the index when this URL was seen before. */
export async function urlInfo(url: string): Promise<SourceInfo> {
  const index = readJson<Record<string, string>>(path.join(CACHE_DIR, "index.json"), {})
  const known = index[url]
  if (known) {
    const info = readJson<SourceInfo | null>(path.join(CACHE_DIR, known, "info.json"), null)
    if (info) return info
  }
  const { stdout } = await runProc("yt-dlp", [...COMMON, "--dump-single-json", "--skip-download", "--", url], {
    env: ytEnv(),
    timeoutMs: 90_000,
    stderrKeep: 4096,
  })
  const j = JSON.parse(stdout) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" && v ? v : null)
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
  if (j.is_live === true) throw new Error("live streams are not supported")
  const extractor = str(j.extractor_key) ?? str(j.extractor) ?? "web"
  const id = str(j.id)
  const key = safeKey(`${extractor}-${id ?? crypto.createHash("sha1").update(url).digest("hex").slice(0, 12)}`)
  const info: SourceInfo = {
    kind: "url",
    url,
    key,
    id,
    extractor,
    title: str(j.title) ?? "",
    uploader: str(j.uploader) ?? str(j.channel),
    channelUrl: str(j.channel_url) ?? str(j.uploader_url),
    uploadDate: str(j.upload_date),
    duration: num(j.duration),
    height: num(j.height),
    webpageUrl: str(j.webpage_url) ?? url,
  }
  writeJson(path.join(CACHE_DIR, key, "info.json"), info)
  const idx = readJson<Record<string, string>>(path.join(CACHE_DIR, "index.json"), {})
  idx[url] = key
  if (info.webpageUrl) idx[info.webpageUrl] = key
  writeJson(path.join(CACHE_DIR, "index.json"), idx)
  return info
}

export function cachedEntries(key: string): CacheEntry[] {
  const dir = path.join(CACHE_DIR, key)
  return readJson<CacheEntry[]>(path.join(dir, "entries.json"), []).filter((e) => fs.existsSync(path.join(dir, e.file)))
}

/** smallest cached file that covers [start,end] at ≥ maxHeight (and has audio when asked) */
export function findCovering(
  entries: CacheEntry[],
  want: { start: number | null; end: number | null; maxHeight: number; audio: boolean },
  /** the source's own tallest format; entries below min(asked, this) are degraded and skipped */
  sourceHeight: number | null = null,
): CacheEntry | null {
  const floor = Math.min(want.maxHeight, sourceHeight ?? want.maxHeight)
  const ok = entries.filter((e) => {
    if (e.maxHeight < want.maxHeight) return false
    if ((e.height ?? 0) < floor) return false
    if (want.audio && !e.audio) return false
    if (e.start === null) return true
    if (want.start === null || want.end === null) return false
    return e.start <= want.start && (e.end ?? Infinity) >= want.end
  })
  ok.sort((a, b) => a.maxHeight - b.maxHeight || a.bytes - b.bytes)
  return ok[0] ?? null
}

/** yt-dlp argv for one download; pure so the tests can pin it */
export function downloadArgs(
  url: string,
  dir: string,
  name: string,
  o: { start: number | null; end: number | null; maxHeight: number; audio: boolean },
): string[] {
  const args = [
    ...COMMON,
    "--retries", "3",
    "--fragment-retries", "3",
    "--no-mtime",
    "--no-part",
    // best ≤ maxHeight, then highest frame rate, then h264 (NVDEC + stream copy friendly)
    "-S", `res:${o.maxHeight},fps,vcodec:h264,acodec:m4a`,
    "-f", o.audio ? "bv*+ba/b" : "bv*/b",
    "--merge-output-format", "mp4",
    "-P", dir,
    "-o", `${name}.%(ext)s`,
  ]
  if (o.start !== null && o.end !== null) args.push("--download-sections", `*${o.start.toFixed(3)}-${o.end.toFixed(3)}`)
  args.push("--", url)
  return args
}

export async function resolveSource(
  src: string,
  want: { start?: number | null; end?: number | null; maxHeight?: number; audio?: boolean } = {},
): Promise<Resolved> {
  if (!isUrl(src)) return resolveFile(src)
  const maxHeight = want.maxHeight ?? 1080
  const audio = want.audio ?? false
  const info = await urlInfo(src)
  const dir = path.join(CACHE_DIR, info.key)
  const dur = info.duration
  // a window → fetch only that section (padded); no window or most of the video → whole thing
  let start: number | null = null
  let end: number | null = null
  if (want.start != null && want.end != null) {
    start = Math.max(0, want.start - PAD)
    end = want.end + PAD
    if (dur) end = Math.min(end, dur)
    if (dur && (end - start) / dur > 0.8) {
      start = null
      end = null
    }
  }
  const hit = findCovering(cachedEntries(info.key), {
    start: want.start ?? null,
    end: want.end ?? null,
    maxHeight,
    audio,
  }, info.height)
  if (hit) {
    return {
      info,
      file: path.join(dir, hit.file),
      offset: hit.start ?? 0,
      sha256: hit.sha256,
      cache: { hit: true, entry: hit, fetchMs: 0 },
    }
  }
  const name = `${start === null ? "full" : `s${start.toFixed(3)}-${end!.toFixed(3)}`}-h${maxHeight}${audio ? "" : "-noaudio"}`
  fs.mkdirSync(dir, { recursive: true })
  const target = Math.min(maxHeight, info.height ?? maxHeight)
  const t0 = performance.now()
  // YouTube sometimes answers a session with only 360p, or 403s ffmpeg's
  // sectioned fetch; a fresh attempt usually gets the real formats.
  let file: string | null = null
  let height = 0
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3 && height < target; attempt++) {
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${name}.`)) fs.rmSync(path.join(dir, f), { force: true })
    try {
      await runProc("yt-dlp", downloadArgs(info.webpageUrl ?? src, dir, name, { start, end, maxHeight, audio }), {
        env: ytEnv(),
        timeoutMs: 30 * 60_000,
        stderrKeep: 4096,
      })
    } catch (err) {
      lastErr = err
      continue
    }
    const got = fs.readdirSync(dir).find((f) => f.startsWith(`${name}.`) && !f.endsWith(".part") && !/\.f\d+\./.test(f))
    if (!got) continue
    const h = await videoHeight(path.join(dir, got))
    if (h > height) {
      // park the best so far where the next attempt's cleanup cannot reach it
      if (file) fs.rmSync(path.join(dir, `${name}~best`), { force: true })
      fs.renameSync(path.join(dir, got), path.join(dir, `${name}~best`))
      file = got
      height = h
    }
  }
  const fetchMs = Math.round(performance.now() - t0)
  if (!file) throw lastErr instanceof Error ? lastErr : new Error("yt-dlp produced no file")
  fs.renameSync(path.join(dir, `${name}~best`), path.join(dir, file))
  const full = path.join(dir, file)
  const entry: CacheEntry = {
    file,
    start,
    end,
    maxHeight,
    height,
    audio,
    bytes: fs.statSync(full).size,
    sha256: await sha256File(full),
    fetchedAt: new Date().toISOString(),
  }
  const entries = cachedEntries(info.key).filter((e) => e.file !== file)
  entries.push(entry)
  writeJson(path.join(dir, "entries.json"), entries)
  return { info, file: full, offset: start ?? 0, sha256: entry.sha256, cache: { hit: false, entry, fetchMs } }
}

async function videoHeight(file: string): Promise<number> {
  try {
    const { stdout } = await runProc("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", file], { timeoutMs: 30_000 })
    return Number(stdout.trim()) || 0
  } catch {
    return 0
  }
}

/** local file: hash once per (path, size, mtime) */
export async function resolveFile(src: string): Promise<Resolved> {
  const file = path.resolve(src)
  const st = fs.statSync(file)
  if (!st.isFile()) throw new Error(`not a file: ${src}`)
  const hashes = path.join(CACHE_DIR, "file-hashes.json")
  const memo = readJson<Record<string, string>>(hashes, {})
  const k = `${file}|${st.size}|${st.mtimeMs}`
  let sha = memo[k]
  if (!sha) {
    sha = await sha256File(file)
    memo[k] = sha
    try {
      writeJson(hashes, memo)
    } catch {
      /* read-only cache is fine */
    }
  }
  const info: SourceInfo = {
    kind: "file",
    url: null,
    key: safeKey(path.basename(file, path.extname(file))),
    id: null,
    extractor: null,
    title: path.basename(file),
    uploader: null,
    channelUrl: null,
    uploadDate: null,
    duration: null,
    height: null,
    webpageUrl: null,
  }
  return { info, file, offset: 0, sha256: sha, cache: { hit: true, entry: null, fetchMs: 0 } }
}
