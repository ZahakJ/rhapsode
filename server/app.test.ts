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
    // a stand-in demucs: same CLI surface, writes the two halves with ffmpeg and
    // redraws a tqdm-style bar on stderr the way the real one does
    const fakeDemucs = path.join(fx, "demucs")
    fs.writeFileSync(
      fakeDemucs,
      [
        "#!/bin/sh",
        "out=; name=htdemucs; track=",
        'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift;; -n) name=$2; shift;; --filename) shift;; --two-stems=*) ;; *) track=$1;; esac; shift; done',
        'mkdir -p "$out/$name"',
        'printf "  0%%|          | 0/10\r 50%%|#####     | 5/10\r" >&2',
        'ffmpeg -hide_banner -loglevel error -y -i "$track" -af "highpass=f=800" "$out/$name/vocals.wav" || exit 1',
        'ffmpeg -hide_banner -loglevel error -y -i "$track" -af "lowpass=f=800" "$out/$name/no_vocals.wav" || exit 1',
        'printf "100%%|##########| 10/10\n" >&2',
      ].join("\n"),
      { mode: 0o755 },
    )
    const config = loadConfig({ DATA_DIR: dataDir, INVITE_KEY: KEY, RATE_LIMIT: "0", RENDER_ENCODER: "libx264", PUBLIC_ORIGIN: "https://r.test", DEMUCS_BIN: fakeDemucs })
    db = openDb(":memory:")
    ;({ app, queue } = createApp(config, db, { encoder: "libx264", ytdlpVersion: "test", stems: true }))
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

  it("serves originals to Pro and gives every recipe its sequence form", async () => {
    expect((await app.request(`/api/sources/${base.id}/original`)).status).toBe(401)
    const orig = await app.request(`/api/sources/${base.id}/original`, { headers: H })
    expect(orig.status).toBe(200)
    expect(Buffer.from(await orig.arrayBuffer()).equals(baseMp4)).toBe(true)
    const rec = await app.request(`/api/renders/${render.slug}/recipe`, { headers: H })
    expect(rec.status).toBe(200)
    const body = (await rec.json()) as { recipe?: unknown; asSequence?: { v: number; tracks: Array<{ kind: string }> } }
    expect(body.recipe).toBeTruthy()
    expect(body.asSequence?.v).toBe(1)
    expect(body.asSequence?.tracks.map((t) => t.kind)).toEqual(["visual", "visual", "text"])
  })

  it("publishes a finished MP4 from Pro as a share link", async () => {
    const pub = (buf: Uint8Array<ArrayBuffer>, key = KEY) =>
      app.request("/api/renders/publish?title=from%20pro", { method: "POST", headers: { "x-rhapsode-key": key, "content-type": "video/mp4" }, body: buf })
    expect((await pub(new Uint8Array(baseMp4), "wrong-key-wrong-key")).status).toBe(401)
    expect((await pub(new Uint8Array(png))).status).toBe(415)
    const res = await pub(new Uint8Array(baseMp4))
    expect(res.status).toBe(201)
    const { render: r, shareUrl } = (await res.json()) as { render: RenderDto; shareUrl: string }
    expect(r.origin).toBe("pro")
    expect(r.title).toBe("from pro")
    expect(r.width).toBe(320)
    expect(shareUrl).toBe(`https://r.test/m/${r.slug}`)
    const page = await app.request(`/m/${r.slug}`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("from pro")
    const mp4 = await app.request(`/m/${r.slug}.mp4`)
    expect(Buffer.from(await mp4.arrayBuffer()).equals(baseMp4)).toBe(true)
    // a Pro render has no recipe to remix
    expect((await app.request(`/api/renders/${r.slug}/recipe`, { headers: H })).status).toBe(409)
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

  it("renders a studio sequence: photo montage, overlapping clip, music, bilingual cues", async () => {
    // the image was deleted by the remix test above — bring it back
    const re = (await (await upload(png, "img2.png")).json()) as { source: SourceDto; job: JobDto }
    expect((await waitJob(re.job.id)).status).toBe("done")
    img = (await (await app.request(`/api/sources/${re.source.id}`, { headers: H })).json()) as SourceDto
    const sequence = {
      v: 1,
      canvas: { aspect: "9:16", background: "111111" },
      tracks: [
        { id: "v1", kind: "visual", clips: [
          { id: "p1", source: img.id, at: 0, duration: 1.5, fadeOut: 0.4, kenBurns: { from: { x: 0, y: 0, w: 1 }, to: { x: 0.2, y: 0.2, w: 0.6 } } },
          { id: "c1", source: base.id, at: 1.1, duration: 1.4, in: 0.2, fadeIn: 0.4 },
        ] },
        { id: "v2", kind: "visual", clips: [{ id: "c2", source: ov.id, at: 1.5, duration: 1, fit: "free", box: { x: 0.5, y: 0.1, w: 0.4 }, opacity: 0.85, volume: 0 }] },
        { id: "a1", kind: "audio", clips: [{ id: "m1", source: ov.id, at: 0, in: 0, out: 2, gain: 0.6, fadeOut: 0.5 }] },
        { id: "t1", kind: "text", clips: [{ id: "x1", at: 0.2, duration: 2, text: "montage", sub: "مونتاج", style: "box" }] },
      ],
    }
    const res = await app.request("/api/renders", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ sequence, title: "studio" }) })
    expect(res.status, await res.clone().text()).toBe(202)
    const { job, slug } = (await res.json()) as { job: JobDto; slug: string }
    const done = await waitJob(job.id)
    expect(done.status, done.error ?? "").toBe("done")
    const r = done.result as RenderDto
    expect(r.width).toBe(1080)
    expect(r.height).toBe(1920)
    expect(r.duration).toBeGreaterThan(2.4)
    expect(r.duration).toBeLessThan(2.6)
    const remix = (await (await app.request(`/api/renders/${slug}/recipe`, { headers: H })).json()) as { sequence?: { tracks: unknown[] }; recipe?: unknown; sources: SourceDto[] }
    expect(remix.sequence?.tracks).toHaveLength(4)
    expect(remix.recipe).toBeUndefined()
    expect(remix.sources.map((s) => s.id).sort()).toEqual([img.id, base.id, ov.id].sort())
    // a bad sequence explains itself in sequence terms
    const bad = await app.request("/api/renders", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ sequence: { v: 1, tracks: [{ id: "t", kind: "visual", clips: [{ id: "t", source: img.id, at: 0, duration: 1 }] }] } }) })
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as { error: string }).error).toContain("sequence")
  })

  it("accepts audio-only uploads and uses them as dub sound and studio music", async () => {
    const fx = path.join(dataDir, "fx")
    execFileSync("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=330:d=3", "-c:a", "pcm_s16le", `${fx}/tone.wav`], { stdio: "pipe" })
    const res = await upload(fs.readFileSync(`${fx}/tone.wav`), "tone.wav")
    expect(res.status, await res.clone().text()).toBe(202)
    const { source, job } = (await res.json()) as { source: SourceDto; job: JobDto }
    expect(source.media).toBe("audio")
    const done = await waitJob(job.id)
    expect(done.status, done.error ?? "").toBe("done")
    const snd = (await (await app.request(`/api/sources/${source.id}`, { headers: H })).json()) as SourceDto
    expect(snd.media).toBe("audio")
    expect(snd.hasAudio).toBe(true)
    expect(snd.duration).toBeGreaterThan(2.9)
    expect(snd.proxyUrl).toBe(`/s/${snd.id}/proxy.m4a`)
    expect((await app.request(snd.proxyUrl!)).headers.get("content-type")).toBe("audio/mp4")
    expect((await app.request(snd.thumbUrl!)).status).toBe(200)

    // a sound can be the clip on top of a photo — dub only
    const post = (body: unknown) => app.request("/api/renders", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) })
    const pip = await post({ recipe: { v: 1, base: { kind: "image", source: img.id }, overlay: { source: snd.id, in: 0, out: 2 }, mode: { kind: "pip", box: { x: 0, y: 0, w: 0.5 } } } })
    expect(pip.status).toBe(422)
    const dub = await post({ recipe: { v: 1, base: { kind: "image", source: img.id }, overlay: { source: snd.id, in: 0.5, out: 2 } } })
    expect(dub.status, await dub.clone().text()).toBe(202)
    const dj = await waitJob(((await dub.json()) as { job: JobDto }).job.id)
    expect(dj.status, dj.error ?? "").toBe("done")
    expect((dj.result as RenderDto).duration).toBeGreaterThan(1.4)

    // and music on a studio audio track; never on a visual track
    const onVisual = await post({ sequence: { v: 1, tracks: [{ id: "v", kind: "visual", clips: [{ id: "c", source: snd.id, at: 0, duration: 1 }] }] } })
    expect(onVisual.status).toBe(422)
    const seq = await post({ sequence: { v: 1, tracks: [
      { id: "v", kind: "visual", clips: [{ id: "c", source: img.id, at: 0, duration: 1.2 }] },
      { id: "a", kind: "audio", clips: [{ id: "m", source: snd.id, at: 0, in: 0, out: 1.2, fadeOut: 0.3 }] },
    ] } })
    expect(seq.status, await seq.clone().text()).toBe(202)
    const sj = await waitJob(((await seq.json()) as { job: JobDto }).job.id)
    expect(sj.status, sj.error ?? "").toBe("done")
  })

  it("splits a source into vocals + music stems and renders with them", async () => {
    const post = (body: unknown) => app.request("/api/renders", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) })
    const split = (id: string) => app.request(`/api/sources/${id}/stems`, { method: "POST", headers: H })
    expect((await app.request(`/api/sources/${base.id}/stems`, { method: "POST" })).status).toBe(401)
    expect((await split(img.id)).status).toBe(422)

    const r1 = await split(base.id)
    expect(r1.status, await r1.clone().text()).toBe(202)
    const made = (await r1.json()) as { stems: SourceDto[]; job: JobDto }
    expect(made.stems.map((s) => s.stem).sort()).toEqual(["music", "vocals"])
    expect(made.stems.every((s) => s.status === "pending" && s.kind === "stem" && s.parentId === base.id)).toBe(true)
    // asking again mid-flight hands back the same job, not a second one
    const again = (await (await split(base.id)).json()) as { stems: SourceDto[]; job: JobDto }
    expect(again.job.id).toBe(made.job.id)
    const job = await waitJob(made.job.id)
    expect(job.status, job.error ?? "").toBe("done")
    expect(job.progress).toBe(1)
    const stems = (job.result as SourceDto[]).sort((a, b) => a.stem!.localeCompare(b.stem!))
    expect(stems.map((s) => s.stem)).toEqual(["music", "vocals"])
    for (const s of stems) {
      const fresh = (await (await app.request(`/api/sources/${s.id}`, { headers: H })).json()) as SourceDto
      expect(fresh.status).toBe("ready")
      expect(fresh.media).toBe("audio")
      expect(fresh.hasAudio).toBe(true)
      expect(fresh.parentId).toBe(base.id)
      expect(fresh.title).toBe(`${s.stem} · base`)
      expect(fresh.duration).toBeGreaterThan(1.9)
      expect(fresh.proxyUrl).toBe(`/s/${s.id}/proxy.m4a`)
      expect((await app.request(fresh.thumbUrl!)).status).toBe(200)
    }
    // ready stems are reused, never re-split; a stem cannot be split further
    const r2 = await split(base.id)
    expect(r2.status).toBe(200)
    const reused = (await r2.json()) as { stems: SourceDto[]; job: null }
    expect(reused.job).toBeNull()
    expect(reused.stems.map((s) => s.id).sort()).toEqual(stems.map((s) => s.id).sort())
    expect((await split(stems[0]!.id)).status).toBe(422)
    const vocals = stems.find((s) => s.stem === "vocals")!
    const music = stems.find((s) => s.stem === "music")!

    // simple mode: the base lane takes its vocals; a stem from another parent is refused
    const wrong = await post({ recipe: { v: 1, base: { kind: "video", source: base.id, in: 0, out: 1.5 }, overlay: { source: ov.id, in: 0, out: 1 }, audio: { overlayFrom: vocals.id } } })
    expect(wrong.status).toBe(422)
    expect(((await wrong.json()) as { error: string }).error).toMatch(/different source/)
    const ok = await post({ recipe: { v: 1, base: { kind: "video", source: base.id, in: 0, out: 1.5 }, overlay: { source: ov.id, in: 0, out: 1 }, audio: { base: "keep", baseFrom: vocals.id } } })
    expect(ok.status, await ok.clone().text()).toBe(202)
    const { job: rj, slug } = (await ok.json()) as { job: JobDto; slug: string }
    const rdone = await waitJob(rj.id)
    expect(rdone.status, rdone.error ?? "").toBe("done")
    // the stem is a source of the render: the remix bundle carries it and it survives a sweep
    const bundle = (await (await app.request(`/api/renders/${slug}/recipe`, { headers: H })).json()) as { sources: SourceDto[] }
    expect(bundle.sources.map((s) => s.id)).toContain(vocals.id)
    expect((await app.request(`/api/sources/${vocals.id}`, { method: "DELETE", headers: H })).status).toBe(409)

    // studio: a clip's sound from its music stem
    const seqBad = await post({ sequence: { v: 1, tracks: [{ id: "v", kind: "visual", clips: [{ id: "c", source: ov.id, at: 0, duration: 1, soundFrom: music.id }] }] } })
    expect(seqBad.status).toBe(422)
    const seq = await post({ sequence: { v: 1, tracks: [{ id: "v", kind: "visual", clips: [{ id: "c", source: base.id, at: 0, duration: 1.2, in: 0.3, soundFrom: music.id }] }] } })
    expect(seq.status, await seq.clone().text()).toBe(202)
    const sj = await waitJob(((await seq.json()) as { job: JobDto }).job.id)
    expect(sj.status, sj.error ?? "").toBe("done")
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
