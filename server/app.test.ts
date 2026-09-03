import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { openDb } from "./db.ts"
import type { JobDto, RenderDto, SourceDto } from "../shared/recipe.ts"

// Drives the real pipeline end to end: raw-body upload → fetch job (ffprobe +
// proxy) → render job (ffmpeg) → share page + Range. Skips without ffmpeg.

const KEY = "test-key-long-enough"
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const d = hasFfmpeg ? describe : describe.skip

d("app (integration)", () => {
  let dataDir: string
  let app: ReturnType<typeof createApp>["app"]
  let queue: ReturnType<typeof createApp>["queue"]
  let db: ReturnType<typeof openDb>
  let baseMp4: Buffer
  let ovMp4: Buffer
  let png: Buffer

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rhapsode-test-"))
    const fx = path.join(dataDir, "fx")
    fs.mkdirSync(fx)
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args], { stdio: "pipe" })
    ff(["-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", "2", `${fx}/base.mp4`])
    ff(["-f", "lavfi", "-i", "testsrc=s=160x120:r=25:d=2", "-f", "lavfi", "-i", "sine=f=880:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-t", "2", `${fx}/ov.mp4`])
    ff(["-f", "lavfi", "-i", "color=c=red:s=300x200", "-frames:v", "1", `${fx}/img.png`])
    baseMp4 = fs.readFileSync(`${fx}/base.mp4`)
    ovMp4 = fs.readFileSync(`${fx}/ov.mp4`)
    png = fs.readFileSync(`${fx}/img.png`)
    const config = loadConfig({ DATA_DIR: dataDir, INVITE_KEY: KEY, RATE_LIMIT: "0", RENDER_ENCODER: "libx264", PUBLIC_ORIGIN: "https://r.test" })
    db = openDb(":memory:")
    ;({ app, queue } = createApp(config, db, { encoder: "libx264", ytdlpVersion: "test" }))
  })

  afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const H = { "x-rhapsode-key": KEY }
  const upload = (buf: Buffer, name: string, key = KEY) =>
    app.request("/api/sources", {
      method: "POST",
      headers: { "x-rhapsode-key": key, "content-type": "application/octet-stream", "x-filename": name, "content-length": String(buf.length) },
      body: new Uint8Array(buf),
    })

  async function waitJob(id: string): Promise<JobDto> {
    for (let i = 0; i < 600; i++) {
      const res = await app.request(`/api/jobs/${id}`, { headers: H })
      const job = (await res.json()) as JobDto
      if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return job
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error("job never finished")
  }

  let base: SourceDto
  let ov: SourceDto
  let img: SourceDto

  it("gates writes and serves health", async () => {
    expect((await app.request("/healthz")).status).toBe(200)
    expect((await upload(baseMp4, "x.mp4", "wrong")).status).toBe(401)
    expect((await app.request("/api/sources", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401)
    expect((await app.request("/api/renders", { method: "POST", body: "{}" })).status).toBe(401)
    expect((await app.request("/api/nope")).status).toBe(404)
  })

  it("rejects unsupported uploads and private links", async () => {
    const res = await upload(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "x.svg")
    expect(res.status).toBe(415)
    for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://10.0.0.1/x", "file:///etc/passwd", "http://localhost/"]) {
      const r = await app.request("/api/sources", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ url }) })
      expect(r.status, url).toBe(422)
    }
  })

  it("uploads and readies sources through the fetch job", async () => {
    const r1 = await upload(baseMp4, "base.mp4")
    expect(r1.status).toBe(202)
    const b1 = (await r1.json()) as { source: SourceDto; job: JobDto }
    expect(b1.source.status).toBe("pending")
    const j1 = await waitJob(b1.job.id)
    expect(j1.status, j1.error ?? "").toBe("done")
    base = (await (await app.request(`/api/sources/${b1.source.id}`, { headers: H })).json()) as SourceDto
    expect(base.status).toBe("ready")
    expect(base.media).toBe("video")
    expect(base.hasAudio).toBe(true)
    expect(base.duration).toBeGreaterThan(1.9)
    expect(base.width).toBe(320)
    expect(base.proxyUrl).toBe(`/s/${base.id}/proxy.mp4`)

    const r2 = await upload(ovMp4, "ov.mp4")
    const b2 = (await r2.json()) as { source: SourceDto; job: JobDto }
    expect((await waitJob(b2.job.id)).status).toBe("done")
    ov = (await (await app.request(`/api/sources/${b2.source.id}`, { headers: H })).json()) as SourceDto

    const r3 = await upload(png, "img.png")
    const b3 = (await r3.json()) as { source: SourceDto; job: JobDto }
    expect((await waitJob(b3.job.id)).status).toBe("done")
    img = (await (await app.request(`/api/sources/${b3.source.id}`, { headers: H })).json()) as SourceDto
    expect(img.media).toBe("image")
    expect(img.proxyUrl).toBe(`/s/${img.id}/proxy.jpg`)

    // proxies are served with Range support, thumbs exist
    const proxy = await app.request(base.proxyUrl!, { headers: { range: "bytes=0-99" } })
    expect(proxy.status).toBe(206)
    expect(proxy.headers.get("content-range")).toMatch(/^bytes 0-99\//)
    expect((await app.request(base.thumbUrl!)).status).toBe(200)
    const list = (await (await app.request("/api/sources", { headers: H })).json()) as SourceDto[]
    expect(list.map((s) => s.id).sort()).toEqual([base.id, ov.id, img.id].sort())
  })

  it("dedups an identical upload", async () => {
    const res = await upload(baseMp4, "again.mp4")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { source: SourceDto; job: null }
    expect(body.source.id).toBe(base.id)
    expect(body.job).toBeNull()
  })

  it("rejects recipes that fail the cross-checks", async () => {
    const post = (recipe: unknown) =>
      app.request("/api/renders", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ recipe }) })
    expect((await post({ v: 1, base: { kind: "video", source: base.id, in: 0, out: 5 }, overlay: { source: ov.id, in: 0, out: 1 } })).status).toBe(422)
    expect((await post({ v: 1, base: { kind: "video", source: base.id, in: 0, out: 1 }, overlay: { source: img.id, in: 0, out: 1 } })).status).toBe(422)
    expect((await post({ v: 1, base: { kind: "video", source: "0".repeat(24), in: 0, out: 1 }, overlay: { source: ov.id, in: 0, out: 1 } })).status).toBe(422)
    expect((await post({ v: 1, base: { kind: "image", source: base.id }, overlay: { source: ov.id, in: 0, out: 1 } })).status).toBe(422)
  })

  let render: RenderDto
  it("renders a pip over a video and serves the share page", async () => {
    const recipe = {
      v: 1,
      base: { kind: "video", source: base.id, in: 0.2, out: 1.7 },
      overlay: { source: ov.id, in: 0, out: 1, at: 0.3 },
      mode: { kind: "pip", box: { x: 0.55, y: 0.05, w: 0.4 } },
      captions: [{ text: "smoke: 100%" }],
      output: { aspect: "9:16" },
    }
    const res = await app.request("/api/renders", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ recipe, title: "test render" }) })
    expect(res.status).toBe(202)
    const { job, slug } = (await res.json()) as { job: JobDto; slug: string }
    expect(slug).toMatch(/^[a-z]+-[a-z]+/)
    const done = await waitJob(job.id)
    expect(done.status, done.error ?? "").toBe("done")
    render = done.result as RenderDto
    expect(render.slug).toBe(slug)
    expect(render.width).toBe(1080)
    expect(render.height).toBe(1920)
    expect(render.duration).toBeGreaterThan(1.4)
    expect(render.duration).toBeLessThan(1.6)

    const pub = await app.request(`/api/renders/${slug}`)
    expect(pub.status).toBe(200)
    const page = await app.request(`/m/${slug}`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain(`<meta property="og:video" content="https://r.test/m/${slug}.mp4">`)
    expect(html).toContain(`og:image" content="https://r.test/m/${slug}.jpg"`)
    expect(html).toContain("test render")
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'")

    const mp4 = await app.request(`/m/${slug}.mp4`, { headers: { range: "bytes=0-3" } })
    expect(mp4.status).toBe(206)
    expect(mp4.headers.get("cache-control")).toContain("immutable")
    expect((await app.request(`/m/${slug}.jpg`)).headers.get("content-type")).toBe("image/jpeg")
    expect((await app.request(`/m/${slug}.webm`)).status).toBe(404)

    const wall = (await (await app.request("/api/renders")).json()) as { items: RenderDto[]; nextCursor: string | null }
    expect(wall.items[0]?.slug).toBe(slug)
  })

  it("renders a dub over an image, then remix + delete", async () => {
    const recipe = { v: 1, base: { kind: "image", source: img.id, duration: 1.2 }, overlay: { source: ov.id, in: 0.5, out: 1.5 }, audio: { base: "mute" } }
    const res = await app.request("/api/renders", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ recipe }) })
    const { job, slug } = (await res.json()) as { job: JobDto; slug: string }
    const done = await waitJob(job.id)
    expect(done.status, done.error ?? "").toBe("done")
    const r = done.result as RenderDto
    expect(r.width).toBe(300)
    expect(r.height).toBe(200)

    expect((await app.request(`/api/renders/${slug}/recipe`)).status).toBe(401)
    const remix = (await (await app.request(`/api/renders/${slug}/recipe`, { headers: H })).json()) as { recipe: { base: { kind: string } }; sources: SourceDto[] }
    expect(remix.recipe.base.kind).toBe("image")
    expect(remix.sources).toHaveLength(2)

    // a referenced source cannot be deleted
    expect((await app.request(`/api/sources/${img.id}`, { method: "DELETE", headers: H })).status).toBe(409)
    expect((await app.request(`/api/renders/${slug}`, { method: "DELETE", headers: H })).status).toBe(204)
    expect((await app.request(`/api/renders/${slug}`)).status).toBe(404)
    expect((await app.request(`/m/${slug}.mp4`)).status).toBe(404)
    expect((await app.request(`/api/sources/${img.id}`, { method: "DELETE", headers: H })).status).toBe(204)
  })

  it("reports storage and sweeps unreferenced sources on demand", async () => {
    expect((await app.request("/api/storage")).status).toBe(401)
    const before = (await (await app.request("/api/storage", { headers: H })).json()) as { usedBytes: number; sources: { count: number; unreferenced: number }; renders: { count: number } }
    expect(before.usedBytes).toBeGreaterThan(0)
    expect(before.sources.count).toBeGreaterThan(0)
    const res = await app.request("/api/storage/sweep", { method: "POST", headers: H })
    expect(res.status).toBe(200)
    const after = (await res.json()) as { freedBytes: number; storage: { sources: { unreferenced: number } } }
    expect(after.storage.sources.unreferenced).toBe(0)
    // the sources the pip render still references survived
    expect((await app.request(`/api/sources/${base.id}`, { headers: H })).status).toBe(200)
    expect((await app.request(`/api/sources/${ov.id}`, { headers: H })).status).toBe(200)
  })

  it("refuses renders over the budget and over the queue cap", async () => {
    const recipe = { v: 1, base: { kind: "video", source: base.id, in: 0, out: 1 }, overlay: { source: ov.id, in: 0, out: 1 } }
    const post = (a: typeof app) =>
      a.request("/api/renders", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ recipe }) })
    // same database, a 1-byte render budget: the pip render already on disk trips it
    const capped = loadConfig({ DATA_DIR: dataDir, INVITE_KEY: KEY, RATE_LIMIT: "0", RENDER_ENCODER: "libx264", RENDER_CAP_BYTES: "1" })
    expect((await post(createApp(capped, db, { encoder: "libx264" }).app)).status).toBe(507)
    // a queue that admits nothing
    const full = loadConfig({ DATA_DIR: dataDir, INVITE_KEY: KEY, RATE_LIMIT: "0", RENDER_ENCODER: "libx264", MAX_PENDING_RENDERS: "1" })
    const { app: narrow } = createApp(full, db, { encoder: "libx264" })
    const first = await post(narrow)
    expect(first.status).toBe(202)
    expect((await post(narrow)).status).toBe(429)
    const { job } = (await first.json()) as { job: JobDto }
    await waitJob(job.id)
  })

  it("streams job events over SSE", async () => {
    const recipe = { v: 1, base: { kind: "video", source: base.id, in: 0, out: 1 }, overlay: { source: ov.id, in: 0, out: 1 } }
    const res = await app.request("/api/renders", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ recipe }) })
    const { job } = (await res.json()) as { job: JobDto }
    const sse = await app.request(`/api/jobs/${job.id}/events`)
    expect(sse.status).toBe(200)
    expect(sse.headers.get("content-type")).toContain("text/event-stream")
    const text = await sse.text()
    expect(text).toContain("event: state")
    expect(text).toContain("event: done")
    expect(text).toMatch(/"slug":"[a-z-]+"/)
    expect(queue.pendingCount("render")).toBe(0)
  })
})
