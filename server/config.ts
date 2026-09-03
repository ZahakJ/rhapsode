import path from "node:path"

/** per-IP request caps, counted over windowMs */
export type RateLimitConfig = {
  verifyKeyPerWindow: number
  fetchPerWindow: number
  writePerWindow: number
  readPerWindow: number
  windowMs: number
}

export type Config = {
  host: string
  port: number
  publicOrigin: string
  dataDir: string
  /** empty string means creation is disabled (auth always fails) */
  inviteKey: string
  dev: boolean
  /** null turns the limiter off entirely (RATE_LIMIT=0; tests) */
  rateLimit: RateLimitConfig | null
  /** forced encoder, or null for boot-time detection */
  renderEncoder: "h264_nvenc" | "libx264" | null
  fontPath: string
  fetchWholeMaxS: number
  fetchWindowS: number
  fetchAbsMaxS: number
  fetchTimeoutMs: number
  fetchDiskCapBytes: number
  uploadMaxBytes: number
  diskCapBytes: number
  outMaxS: number
  keepFailedJobs: boolean
  /** hours a source survives unreferenced before the sweep takes it */
  sourceTtlHours: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8013)
  const enc = env.RENDER_ENCODER
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    // deliberately generic: a fresh clone must not emit OG tags pointing at
    // someone else's domain. Set PUBLIC_ORIGIN in .env for real deploys.
    publicOrigin: env.PUBLIC_ORIGIN ?? `http://localhost:${port}`,
    dataDir: env.DATA_DIR ?? path.join(import.meta.dirname, "..", "data"),
    inviteKey: env.INVITE_KEY ?? "",
    dev: env.NODE_ENV !== "production",
    rateLimit:
      env.RATE_LIMIT === "0"
        ? null
        : {
            verifyKeyPerWindow: num(env.RATE_LIMIT_VERIFY, 10),
            fetchPerWindow: num(env.RATE_LIMIT_FETCH, 10),
            writePerWindow: num(env.RATE_LIMIT_WRITE, 30),
            readPerWindow: num(env.RATE_LIMIT_READ, 120),
            windowMs: num(env.RATE_LIMIT_WINDOW_MS, 60_000),
          },
    renderEncoder: enc === "h264_nvenc" || enc === "libx264" ? enc : null,
    fontPath: env.FONT_PATH ?? path.join(import.meta.dirname, "render", "fonts", "Anton-Regular.ttf"),
    fetchWholeMaxS: num(env.FETCH_WHOLE_MAX_S, 900),
    fetchWindowS: num(env.FETCH_WINDOW_S, 900),
    fetchAbsMaxS: num(env.FETCH_ABS_MAX_S, 4 * 3600),
    fetchTimeoutMs: num(env.FETCH_TIMEOUT_MS, 15 * 60_000),
    fetchDiskCapBytes: num(env.FETCH_DISK_CAP_BYTES, 3 * 1024 ** 3),
    uploadMaxBytes: num(env.UPLOAD_MAX_BYTES, 512 * 1024 ** 2),
    diskCapBytes: num(env.DISK_CAP_BYTES, 20 * 1024 ** 3),
    outMaxS: num(env.OUT_MAX_S, 180),
    keepFailedJobs: env.JOB_KEEP_FAILED === "1",
    sourceTtlHours: num(env.SOURCE_TTL_HOURS, 24 * 7),
  }
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
