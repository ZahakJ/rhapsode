import { Hono } from "hono"
import type { Context } from "hono"
import { serveStatic } from "@hono/node-server/serve-static"
import { bodyLimit } from "hono/body-limit"
import fs from "node:fs"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { HealthDto } from "../shared/recipe.ts"
import type { Config } from "./config.ts"
import { Store } from "./store.ts"
import { requireKey } from "./auth.ts"
import { RateLimiter, rateLimit } from "./rateLimit.ts"
import { JobQueue } from "./jobs.ts"
import type { Encoder } from "./render/graph.ts"
import { makeFetchRunner } from "./sources/fetch.ts"
import { makeRenderRunner } from "./render/run.ts"
import { sourcesRoutes } from "./routes/sources.ts"
import { rendersRoutes } from "./routes/renders.ts"
import { jobsRoutes } from "./routes/jobs.ts"
import { mediaRoutes } from "./routes/media.ts"
import { storageRoutes } from "./routes/storage.ts"

export type AppDeps = {
  encoder: Encoder
  ytdlpVersion?: string | null
}

// createApp is listen-free so tests can drive app.request() directly.
export function createApp(config: Config, db: DatabaseSync, deps: AppDeps): { app: Hono; store: Store; queue: JobQueue } {
  const store = new Store(db, config.dataDir)
  const queue = new JobQueue(store, { keepFailed: config.keepFailedJobs })
  const encoder = () => deps.encoder
  queue.register("fetch", makeFetchRunner(store, config, encoder))
  queue.register("render", makeRenderRunner(store, config, encoder))

  const app = new Hono()

  // security headers on every response
  app.use("*", async (c, next) => {
    await next()
    const h = c.res.headers
    h.set("X-Content-Type-Options", "nosniff")
    h.set("Referrer-Policy", "strict-origin-when-cross-origin")
    h.set("Cross-Origin-Opener-Policy", "same-origin")
    // ignored over plain http; matters the moment the tunnel fronts this
    h.set("Strict-Transport-Security", "max-age=31536000")
    h.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
    const type = h.get("content-type") ?? ""
    if (type.includes("text/html")) {
      h.set(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "base-uri 'none'",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          // vite inlines small font subsets as data: URIs
          "font-src 'self' data:",
          // share pages carry a small inline <style>; the app css is external
          "style-src 'self' 'unsafe-inline'",
          "script-src 'self'",
          "connect-src 'self'",
        ].join("; "),
      )
    }
  })

  // per-IP rate limits: strict on the unauthenticated key oracle, its own
  // bucket for fetches (each one spawns yt-dlp), moderate on other writes,
  // generous on reads. Registered before the routes they guard.
  const rl = config.rateLimit
  if (rl) {
    const verify = rateLimit(new RateLimiter(rl.verifyKeyPerWindow, rl.windowMs), "verify-key")
    const fetchL = rateLimit(new RateLimiter(rl.fetchPerWindow, rl.windowMs), "fetch")
    const write = rateLimit(new RateLimiter(rl.writePerWindow, rl.windowMs), "write")
    const read = rateLimit(new RateLimiter(rl.readPerWindow, rl.windowMs), "read")
    app.use("/api/verify-key", verify)
    app.use("/api/*", (c, next) => {
      if (c.req.method === "GET") return read(c, next)
      if (c.req.method === "POST" && c.req.path === "/api/sources") return fetchL(c, next)
      return write(c, next)
    })
  }

  const gate = requireKey(config.inviteKey)

  app.get("/healthz", (c) => {
    const dto: HealthDto = { ok: true, encoder: deps.encoder, ytdlp: deps.ytdlpVersion ?? null }
    return c.json(dto)
  })
  app.post("/api/verify-key", gate, (c) => c.body(null, 204))

  app.use("/api/sources", gate)
  app.use("/api/sources/*", gate)
  app.post("/api/sources", bodyLimit({ maxSize: config.uploadMaxBytes }))
  app.route("/api/sources", sourcesRoutes(store, config, queue))
  app.route("/api/renders", rendersRoutes(store, config, queue, gate as never))
  app.route("/api/jobs", jobsRoutes(store, queue, gate))
  app.use("/api/storage", gate)
  app.use("/api/storage/*", gate)
  app.route("/api/storage", storageRoutes(store, config))
  app.route("/", mediaRoutes(store, config))

  // unmatched /api paths must never fall through to the SPA catch-all below,
  // or a typo'd client call parses index.html as JSON with a 200
  const apiNotFound = (c: Context) => c.json({ error: "not found" }, 404)
  app.all("/api", apiNotFound)
  app.all("/api/*", apiNotFound)

  // client bundle — hashed assets immutable, index no-cache (hash-routed SPA)
  const distDir = path.join(import.meta.dirname, "..", "dist")
  if (fs.existsSync(path.join(distDir, "index.html"))) {
    const indexHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8")
    app.use("/assets/*", async (c, next) => {
      await next()
      if (c.res.ok) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable")
    })
    app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), distDir) }))
    app.get("/", (c) => {
      c.header("Cache-Control", "no-cache")
      return c.html(indexHtml)
    })
    app.notFound((c) => {
      c.header("Cache-Control", "no-cache")
      return c.html(indexHtml, 200)
    })
  } else {
    app.get("/", (c) => c.text("rhapsode server up — client dist not built (dev mode uses vite)", 200))
  }

  return { app, store, queue }
}
