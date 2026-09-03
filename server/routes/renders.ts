import { Hono } from "hono"
import { createRenderSchema, type Recipe, type RenderPage } from "../../shared/recipe.ts"
import type { Config } from "../config.ts"
import type { JobQueue } from "../jobs.ts"
import type { RenderPayload } from "../render/run.ts"
import type { SourceRow, Store } from "../store.ts"

export function rendersRoutes(store: Store, config: Config, queue: JobQueue, requireKey: (c: never, next: never) => Promise<unknown>): Hono {
  const r = new Hono()
  const gate = requireKey as unknown as Parameters<typeof r.use>[1]

  r.post("/", gate, async (c) => {
    const parsed = createRenderSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return c.json({ error: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid recipe" }, 422)
    }
    const { recipe, title } = parsed.data
    const problem = crossCheck(store, recipe, config)
    if (problem) return c.json({ error: problem }, 422)
    if (store.totalBytes() > config.diskCapBytes) return c.json({ error: "the disk is full — delete some renders" }, 507)

    store.touchSources([recipe.base.source, recipe.overlay.source])
    const slug = store.reserveSlug()
    const payload: RenderPayload = { slug, title: title ?? "", recipe }
    const job = queue.enqueue("render", payload)
    return c.json({ job: store.jobDto(job), slug }, 202)
  })

  r.get("/", (c) => {
    const limit = Math.min(60, Math.max(1, Number(c.req.query("limit") ?? 24) || 24))
    const { rows, nextCursor } = store.listRenders(c.req.query("cursor") ?? null, limit)
    const page: RenderPage = { items: rows.map((row) => store.renderDto(row)), nextCursor }
    return c.json(page)
  })

  r.get("/:slug", (c) => {
    const row = store.renderBySlug(c.req.param("slug"))
    if (!row) return c.json({ error: "not found" }, 404)
    return c.json(store.renderDto(row))
  })

  r.get("/:slug/recipe", gate, (c) => {
    const row = store.renderBySlug(c.req.param("slug"))
    if (!row) return c.json({ error: "not found" }, 404)
    const recipe = JSON.parse(row.recipe_json) as Recipe
    const sources = [recipe.base.source, recipe.overlay.source]
      .map((id) => store.sourceById(id))
      .filter((s): s is SourceRow => !!s && s.status === "ready")
    if (sources.length < 2) return c.json({ error: "a source of this render was swept — add it again", recipe }, 404)
    return c.json({ recipe, title: row.title, sources: sources.map((s) => store.sourceDto(s)) })
  })

  r.delete("/:slug", gate, (c) => {
    if (!store.deleteRender(c.req.param("slug"))) return c.json({ error: "not found" }, 404)
    return c.body(null, 204)
  })

  return r
}

/** The checks that need the database: the schema already proved the shape. */
export function crossCheck(store: Store, recipe: Recipe, config: Config): string | null {
  const base = store.sourceById(recipe.base.source)
  const ov = store.sourceById(recipe.overlay.source)
  if (!base || base.status !== "ready") return "the base source is not ready"
  if (!ov || ov.status !== "ready") return "the clip source is not ready"
  if (ov.media !== "video") return "the clip on top must be a video"
  if (recipe.base.kind === "video") {
    if (base.media !== "video") return "the base is an image, not a video"
    if (recipe.base.out > (base.duration ?? 0) + 0.05) return "base out point is past the end"
    if (recipe.base.out - recipe.base.in > config.outMaxS) return `renders are capped at ${config.outMaxS}s`
  } else if (base.media !== "image") return "the base is a video, not an image"
  if (recipe.overlay.out > (ov.duration ?? 0) + 0.05) return "clip out point is past the end"
  if (recipe.mode.kind === "dub" && ov.has_audio !== 1) return "a dub needs a clip with sound"
  return null
}
