import { Hono } from "hono"
import { z } from "zod"
import { createRenderSchema, type Recipe, type RenderPage } from "../../shared/recipe.ts"
import { createSequenceRenderSchema, sequenceDurationOf, type Sequence } from "../../shared/sequence.ts"
import type { Config } from "../config.ts"
import type { JobQueue } from "../jobs.ts"
import { payloadSources, type RenderPayload } from "../render/run.ts"
import type { SourceRow, Store } from "../store.ts"

export function rendersRoutes(store: Store, config: Config, queue: JobQueue, requireKey: (c: never, next: never) => Promise<unknown>): Hono {
  const r = new Hono()
  const gate = requireKey as unknown as Parameters<typeof r.use>[1]

  const bodySchema = z.union([createRenderSchema, createSequenceRenderSchema])

  r.post("/", gate, async (c) => {
    const raw = await c.req.json().catch(() => null)
    const parsed = bodySchema.safeParse(raw)
    if (!parsed.success) return c.json({ error: firstIssue(parsed.error, raw) }, 422)
    const body = parsed.data
    const payload: RenderPayload =
      "recipe" in body ? { slug: "", title: body.title ?? "", recipe: body.recipe } : { slug: "", title: body.title ?? "", sequence: body.sequence }
    const problem = payload.recipe ? crossCheck(store, payload.recipe, config) : crossCheckSequence(store, payload.sequence!, config)
    if (problem) return c.json({ error: problem }, 422)
    if (store.totalBytes() > config.diskCapBytes || store.renderBytes() > config.renderCapBytes)
      return c.json({ error: "the render budget is full — delete some renders first" }, 507)
    if (queue.pendingCount("render") >= config.maxPendingRenders)
      return c.json({ error: "too many renders queued — try again in a moment" }, 429)

    store.touchSources(payloadSources(payload))
    payload.slug = store.reserveSlug()
    const job = queue.enqueue("render", payload)
    return c.json({ job: store.jobDto(job), slug: payload.slug }, 202)
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
    const stored = parseStored(row.recipe_json)
    const ids = payloadSources({ slug: row.slug, title: row.title, ...stored })
    const sources = ids.map((id) => store.sourceById(id)).filter((s): s is SourceRow => !!s && s.status === "ready")
    if (sources.length < ids.length) return c.json({ error: "a source of this render was swept — add it again", ...stored }, 404)
    return c.json({ ...stored, title: row.title, sources: sources.map((s) => store.sourceDto(s)) })
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
  if (ov.media === "image") return "the clip on top must be a video or a sound"
  if (ov.media === "audio" && recipe.mode.kind !== "dub") return "a sound can only be dubbed — switch to dub"
  if (recipe.base.kind === "video") {
    if (base.media !== "video") return "the base is an image, not a video"
    if (recipe.base.out > (base.duration ?? 0) + 0.05) return "base out point is past the end"
    if (recipe.base.out - recipe.base.in > config.outMaxS) return `renders are capped at ${config.outMaxS}s`
  } else if (base.media !== "image") return "the base is a video, not an image"
  if (recipe.overlay.out > (ov.duration ?? 0) + 0.05) return "clip out point is past the end"
  if (recipe.mode.kind === "dub" && ov.has_audio !== 1) return "a dub needs a clip with sound"
  return null
}

/** recipe_json holds either a bare v1 recipe (early renders) or {recipe} | {sequence}. */
export function parseStored(json: string): { recipe?: Recipe; sequence?: Sequence } {
  const j = JSON.parse(json) as Record<string, unknown>
  if (j.sequence) return { sequence: j.sequence as Sequence }
  if (j.recipe) return { recipe: j.recipe as Recipe }
  return { recipe: j as unknown as Recipe }
}

function firstIssue(err: z.ZodError, raw: unknown): string {
  // a union error lists both branches; report the branch the body was aiming for
  const wantSeq = !!(raw && typeof raw === "object" && "sequence" in (raw as object))
  const flat = err.issues.flatMap((i) =>
    "errors" in i && Array.isArray((i as { errors?: unknown }).errors) ? (i as { errors: z.ZodIssue[][] }).errors.flat() : [i],
  )
  const pick = flat.find((i) => (wantSeq ? i.path[0] === "sequence" : i.path[0] === "recipe")) ?? flat[0]
  return pick ? `${pick.path.join(".")}: ${pick.message}` : "invalid body"
}

export function crossCheckSequence(store: Store, seq: Sequence, config: Config): string | null {
  if (sequenceDurationOf(seq) > config.seqMaxS) return `sequences are capped at ${config.seqMaxS}s`
  if (seq.canvas.aspect === "source") {
    const s = seq.canvas.sourceOf ? store.sourceById(seq.canvas.sourceOf) : null
    if (!s || s.status !== "ready") return "the canvas source is not ready"
  }
  for (const t of seq.tracks) {
    if (t.kind === "text") continue
    if (t.kind === "audio") {
      for (const c of t.clips) {
        const s = store.sourceById(c.source)
        if (!s || s.status !== "ready") return `a clip's source is not ready (${c.id})`
        if (s.has_audio !== 1) return `${s.title || c.id} has no sound`
        if (c.out > (s.duration ?? 0) + 0.05) return `${s.title || c.id}: out point is past the end`
      }
    } else {
      for (const c of t.clips) {
        const s = store.sourceById(c.source)
        if (!s || s.status !== "ready") return `a clip's source is not ready (${c.id})`
        if (s.media === "audio") return `${s.title || c.id} is a sound — put it on an audio track`
        if (s.media === "video" && c.in >= (s.duration ?? 0)) return `${s.title || c.id}: in point is past the end`
      }
    }
  }
  return null
}
