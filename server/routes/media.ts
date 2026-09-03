import { Hono } from "hono"
import fs from "node:fs"
import { Readable } from "node:stream"
import type { Store } from "../store.ts"
import type { Config } from "../config.ts"
import { renderSharePage } from "../share.ts"

// /m/<slug>        → HTML share page (OG tags)
// /m/<slug>.mp4    → the render, Range-capable, immutable
// /m/<slug>.jpg    → its poster
// /s/<id>/<file>   → source proxies + thumbs (id-gated: <video src> sends no headers)

const SOURCE_FILES: Record<string, string> = {
  "proxy.mp4": "video/mp4",
  "proxy.jpg": "image/jpeg",
  "thumb.jpg": "image/jpeg",
}

export function mediaRoutes(store: Store, config: Config): Hono {
  const r = new Hono()

  r.get("/m/:name", (c) => {
    const name = c.req.param("name")
    const dot = name.lastIndexOf(".")
    if (dot === -1) {
      const row = store.renderBySlug(name)
      if (!row) return c.text("not found", 404)
      c.header("Cache-Control", "no-cache")
      return c.html(renderSharePage(store.renderDto(row), config.publicOrigin))
    }
    const slug = name.slice(0, dot)
    const ext = name.slice(dot + 1)
    const row = store.renderBySlug(slug)
    if (!row || (ext !== "mp4" && ext !== "jpg")) return c.text("not found", 404)
    return serveFile(c.req.header("range"), store.renderPath(slug, ext), ext === "mp4" ? "video/mp4" : "image/jpeg", "public, max-age=31536000, immutable")
  })

  r.get("/s/:id/:file", (c) => {
    const id = c.req.param("id")
    const file = c.req.param("file")
    const mime = SOURCE_FILES[file]
    if (!mime || !/^[0-9a-f]{24}$/.test(id)) return c.text("not found", 404)
    const row = store.sourceById(id)
    if (!row || row.status !== "ready") return c.text("not found", 404)
    return serveFile(c.req.header("range"), store.sourceFile(id, file), mime, "private, max-age=86400")
  })

  return r
}

export function serveFile(range: string | undefined, filePath: string, mime: string, cache: string): Response {
  let size: number
  try {
    size = fs.statSync(filePath).size
  } catch {
    return new Response("gone", { status: 404 })
  }

  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cache,
  }

  const m = range?.match(/^bytes=(\d*)-(\d*)$/)
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (!m[1] && m[2]) end = size - 1
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } })
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`
    headers["Content-Length"] = String(end - start + 1)
    const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream
    return new Response(stream, { status: 206, headers })
  }

  headers["Content-Length"] = String(size)
  const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream
  return new Response(stream, { status: 200, headers })
}
