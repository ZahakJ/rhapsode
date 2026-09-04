import { Hono } from "hono"
import type { Context } from "hono"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createSourceUrlSchema } from "../../shared/recipe.ts"
import type { Config } from "../config.ts"
import type { JobQueue } from "../jobs.ts"
import { sniff } from "../sniff.ts"
import { newId, type Store } from "../store.ts"
import { assertPublicHost, parseSourceUrl, UrlRejected } from "../sources/ssrf.ts"
import { ytMetadata } from "../sources/url.ts"

export function sourcesRoutes(store: Store, config: Config, queue: JobQueue): Hono {
  const r = new Hono()

  r.post("/", async (c) => {
    if (store.totalBytes() > config.diskCapBytes) return c.json({ error: "the disk is full — delete some renders" }, 507)
    if (queue.pendingCount("fetch") >= config.maxPendingFetches) return c.json({ error: "too many fetches in flight, try again shortly" }, 429)
    const type = c.req.header("content-type") ?? ""
    if (type.includes("application/json")) return createFromUrl(c)
    return createFromUpload(c)
  })

  async function createFromUrl(c: Context) {
    const parsed = createSourceUrlSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "expected {url, around?}" }, 422)
    let url: URL
    try {
      url = parseSourceUrl(parsed.data.url)
      await assertPublicHost(url)
    } catch (err) {
      return c.json({ error: err instanceof UrlRejected ? err.message : "link refused" }, 422)
    }
    const scratch = path.join(store.tmpDir, `meta-${newId()}`)
    let meta
    try {
      meta = await ytMetadata(url.toString(), scratch)
    } catch (err) {
      return c.json({ error: `could not read that link: ${err instanceof Error ? err.message : String(err)}` }, 422)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
    if (meta.isLive) return c.json({ error: "live streams cannot be clipped" }, 422)
    if (meta.duration === null) return c.json({ error: "that link has no duration — is it a video?" }, 422)
    if (meta.duration > config.fetchAbsMaxS) return c.json({ error: "that video is too long" }, 422)

    let windowStart: number | null = null
    let windowEnd: number | null = null
    if (meta.duration > config.fetchWholeMaxS) {
      if (parsed.data.around === undefined)
        return c.json({ error: "needs around", duration: meta.duration, title: meta.title }, 409)
      const around = Math.min(parsed.data.around, meta.duration)
      windowStart = Math.max(0, around - config.fetchWindowS / 3)
      windowEnd = Math.min(meta.duration, windowStart + config.fetchWindowS)
    }
    const id = newId()
    const job = queue.enqueue("fetch", { sourceId: id })
    const row = store.insertSource({
      id,
      kind: "url",
      media: "video",
      url: meta.webpageUrl,
      title: meta.title,
      ext: "mp4",
      duration: windowStart !== null ? windowEnd! - windowStart : meta.duration,
      windowStart,
      windowEnd,
      jobId: job.id,
    })
    return c.json({ source: store.sourceDto(row), job: store.jobDto(job) }, 202)
  }

  async function createFromUpload(c: Context) {
    const body = c.req.raw.body
    if (!body) return c.json({ error: "empty body" }, 400)
    const declared = Number(c.req.header("content-length") ?? 0)
    if (declared > config.uploadMaxBytes) return c.json({ error: "file too big" }, 413)
    const filename = decodeURIComponent(c.req.header("x-filename") ?? "").slice(0, 120)

    const id = newId()
    const dir = store.sourceDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, "upload.bin")
    const hash = crypto.createHash("sha256")
    let head = Buffer.alloc(0)
    let total = 0
    let sniffed: ReturnType<typeof sniff> = null
    let rejected: { status: 413 | 415; error: string } | null = null
    const reader = Readable.fromWeb(body as never)
    try {
      await pipeline(
        reader,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            total += chunk.length
            if (total > config.uploadMaxBytes) {
              rejected = { status: 413, error: "file too big" }
              throw new Error("too big")
            }
            if (!sniffed) {
              head = Buffer.concat([head, chunk])
              if (head.length >= 4096 || total === declared) {
                sniffed = sniff(head)
                if (!sniffed) {
                  rejected = { status: 415, error: "unsupported file — video (mp4, mov, webm), audio (mp3, m4a, wav, ogg, flac) or a jpg/png/webp" }
                  throw new Error("unsupported")
                }
              }
            }
            hash.update(chunk)
            yield chunk
          }
          if (!sniffed) {
            sniffed = sniff(head)
            if (!sniffed) {
              rejected = { status: 415, error: "unsupported file — video (mp4, mov, webm), audio (mp3, m4a, wav, ogg, flac) or a jpg/png/webp" }
              throw new Error("unsupported")
            }
          }
        },
        fs.createWriteStream(tmp),
      )
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true })
      // assigned inside the generator, which TS's narrowing cannot see
      const rej = rejected as { status: 413 | 415; error: string } | null
      if (rej) return c.json({ error: rej.error }, rej.status)
      return c.json({ error: `upload failed: ${err instanceof Error ? err.message : String(err)}` }, 400)
    }
    const sha = hash.digest("hex")
    const existing = store.readySourceBySha(sha)
    if (existing) {
      fs.rmSync(dir, { recursive: true, force: true })
      store.touchSources([existing.id])
      return c.json({ source: store.sourceDto(existing), job: null }, 200)
    }
    const info = sniffed!
    fs.renameSync(tmp, path.join(dir, `orig.${info.ext}`))
    const job = queue.enqueue("fetch", { sourceId: id })
    const row = store.insertSource({
      id,
      kind: "upload",
      media: info.kind,
      title: filename.replace(/\.[^.]+$/, ""),
      ext: info.ext,
      sha256: sha,
      bytes: total,
      jobId: job.id,
    })
    return c.json({ source: store.sourceDto(row), job: store.jobDto(job) }, 202)
  }

  r.get("/", (c) => c.json(store.listReadySources(50).map((s) => store.sourceDto(s))))

  r.get("/:id", (c) => {
    const row = store.sourceById(c.req.param("id"))
    if (!row) return c.json({ error: "not found" }, 404)
    return c.json(store.sourceDto(row))
  })

  r.delete("/:id", (c) => {
    const row = store.sourceById(c.req.param("id"))
    if (!row) return c.json({ error: "not found" }, 404)
    if (store.sourceRenderCount(row.id) > 0) return c.json({ error: "a render still uses this source" }, 409)
    if (row.status === "pending" && row.job_id) queue.cancel(row.job_id)
    store.deleteSource(row.id)
    return c.body(null, 204)
  })

  return r
}
