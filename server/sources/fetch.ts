import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { Config } from "../config.ts"
import type { JobCtx } from "../jobs.ts"
import type { Encoder } from "../render/graph.ts"
import type { Store } from "../store.ts"
import { ffprobe } from "./probe.ts"
import { makeImageProxy, makeThumb, makeVideoProxy } from "./proxy.ts"
import { ytDownload } from "./url.ts"

// The fetch job: bring the original into sources/<id>/, probe it, derive the
// proxy + thumb, flip the row to ready. URL and upload share everything past
// the download step.

export type FetchPayload = { sourceId: string }

export function makeFetchRunner(store: Store, config: Config, encoder: () => Encoder) {
  return async (payload: unknown, ctx: JobCtx) => {
    const { sourceId } = payload as FetchPayload
    const row = store.sourceById(sourceId)
    if (!row) throw new Error("source vanished")
    try {
      const dir = store.sourceDir(row.id)
      fs.mkdirSync(dir, { recursive: true })
      let origPath: string
      let ext = row.ext

      if (row.kind === "url") {
        ctx.progress(0, "download")
        const window =
          row.window_start !== null && row.window_end !== null ? { start: row.window_start, end: row.window_end } : undefined
        const got = await ytDownload(row.url!, ctx.jobDir, {
          window,
          maxBytes: config.fetchDiskCapBytes,
          timeoutMs: config.fetchTimeoutMs,
          signal: ctx.signal,
          onProgress: (p) => ctx.progress(p === null ? null : 0.05 + 0.55 * p),
        })
        ext = path.extname(got).slice(1) || "mp4"
        origPath = path.join(dir, `orig.${ext}`)
        fs.renameSync(got, origPath)
        store.updateSource(row.id, { ext })
      } else {
        origPath = store.origPath(row)
      }

      ctx.progress(null, "probe")
      const probe = await ffprobe(origPath, ctx.signal)
      if (probe.media === "video" && probe.duration > config.fetchAbsMaxS) throw new Error("video is too long")
      if (probe.media === "image" && Math.max(probe.width, probe.height) > 8000) throw new Error("image is too large")
      if (probe.media !== row.media) store.updateSource(row.id, { media: probe.media })

      ctx.progress(0, "proxy")
      const base = row.kind === "url" ? 0.6 : 0
      const span = row.kind === "url" ? 0.37 : 0.95
      if (probe.media === "video") {
        await makeVideoProxy(origPath, path.join(dir, "proxy.mp4"), probe, {
          encoder: encoder(),
          signal: ctx.signal,
          onProgress: (p) => ctx.progress(base + span * p),
        })
      } else {
        await makeImageProxy(origPath, path.join(dir, "proxy.jpg"), ctx.signal)
      }
      ctx.progress(0.98, "thumb")
      await makeThumb(origPath, path.join(dir, "thumb.jpg"), probe, ctx.signal)

      const sha = row.sha256 ?? (await sha256File(origPath))
      const bytes = dirBytes(dir)
      store.updateSource(row.id, {
        status: "ready",
        media: probe.media,
        duration: probe.media === "video" ? probe.duration : null,
        width: probe.width,
        height: probe.height,
        fps: probe.media === "video" ? probe.fps : null,
        has_audio: probe.hasAudio ? 1 : 0,
        sha256: sha,
        bytes,
        error: null,
        last_used_at: Date.now(),
      })
      ctx.progress(1, "ready")
      return store.sourceDto(store.sourceById(row.id)!)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      store.updateSource(row.id, { status: "failed", error: msg })
      throw err
    }
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256")
    fs.createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject)
  })
}

export function dirBytes(dir: string): number {
  let total = 0
  try {
    for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size
  } catch {
    /* gone */
  }
  return total
}
