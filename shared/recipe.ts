import { z } from "zod"

// The recipe is the single source of truth for a composition: the client
// edits it, the server validates it, graph.ts turns it into ffmpeg argv, and
// the share page stores it for remixing. Times are seconds on each source's
// own timeline (the proxy the browser scrubs and the original the render
// reads are derived from the same file, so they agree to the frame).

export const OUT_MAX_SECONDS = 180
export const MAX_CAPTIONS = 6
export const CAPTION_MAX_CHARS = 200
export const SOURCE_MAX_EDGE = 1920

export const CANVAS = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
} as const

export const sourceIdSchema = z.string().regex(/^[0-9a-f]{24}$/)
const secs = z.number().finite().min(0).max(4 * 3600)
const unit = z.number().finite().min(0).max(1)

/** A fractional rectangle of the source's display frame, applied before anything else. */
export const cropSchema = z
  .object({ x: unit, y: unit, w: z.number().min(0.05).max(1), h: z.number().min(0.05).max(1) })
  .refine((c) => c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, { message: "crop leaves the frame" })

/** Cheap ffmpeg edits, applied after the crop: quarter-turn rotation and a mirror. */
export const editSchema = z.object({
  crop: cropSchema.optional(),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  flipH: z.boolean().default(false),
})
export type Edit = z.infer<typeof editSchema>
export type Crop = z.infer<typeof cropSchema>

export const baseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("video"), source: sourceIdSchema, in: secs, out: secs, edit: editSchema.optional() }),
  z.object({
    kind: z.literal("image"),
    source: sourceIdSchema,
    // default: the overlay's length
    duration: z.number().positive().max(OUT_MAX_SECONDS).optional(),
    edit: editSchema.optional(),
  }),
])

export const overlaySchema = z.object({
  source: sourceIdSchema,
  in: secs,
  out: secs,
  /** offset into the OUTPUT timeline where the overlay starts */
  at: secs.default(0),
  edit: editSchema.optional(),
})

/** Display dimensions of a source after its edit (crop, then rotation). */
export function editedDims(src: { width: number; height: number }, edit?: Edit | null): { width: number; height: number } {
  let w = src.width
  let h = src.height
  if (edit?.crop) {
    w = Math.max(2, Math.floor((w * edit.crop.w) / 2) * 2)
    h = Math.max(2, Math.floor((h * edit.crop.h) / 2) * 2)
  }
  if (edit && (edit.rotate === 90 || edit.rotate === 270)) return { width: h, height: w }
  return { width: w, height: h }
}

export const audioSchema = z.object({
  base: z.enum(["keep", "mute", "duck"]).default("duck"),
  overlay: z.enum(["keep", "mute"]).default("keep"),
  baseGain: z.number().min(0).max(2).default(1),
  overlayGain: z.number().min(0).max(2).default(1),
})

export const pipBoxSchema = z.object({
  x: unit,
  y: unit,
  /** width as a fraction of the canvas; height follows the overlay's aspect */
  w: z.number().min(0.1).max(1),
})

export const modeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dub") }),
  z.object({ kind: z.literal("pip"), box: pipBoxSchema }),
  // dir = which side the OVERLAY lane takes
  z.object({ kind: z.literal("stack"), dir: z.enum(["top", "bottom", "left", "right"]) }),
])

export const captionSchema = z.object({
  text: z.string().trim().min(1).max(CAPTION_MAX_CHARS),
  x: unit.default(0.5),
  y: unit.default(0.85),
  /** font size as a fraction of the canvas height */
  size: z.number().min(0.02).max(0.2).default(0.07),
  align: z.enum(["left", "center", "right"]).default("center"),
  from: secs.optional(),
  to: secs.optional(),
})

export const outputSchema = z.object({
  aspect: z.enum(["source", "9:16", "1:1", "16:9"]).default("source"),
  /** contain pads with black, cover crops */
  fit: z.enum(["contain", "cover"]).default("contain"),
})

export const recipeSchema = z
  .object({
    v: z.literal(1),
    base: baseSchema,
    overlay: overlaySchema,
    mode: modeSchema.default({ kind: "dub" }),
    audio: audioSchema.default({ base: "duck", overlay: "keep", baseGain: 1, overlayGain: 1 }),
    captions: z.array(captionSchema).max(MAX_CAPTIONS).default([]),
    output: outputSchema.default({ aspect: "source", fit: "contain" }),
  })
  .superRefine((r, ctx) => {
    const ovLen = r.overlay.out - r.overlay.in
    if (ovLen <= 0) ctx.addIssue({ code: "custom", path: ["overlay", "out"], message: "out must exceed in" })
    const D = outputDurationOf(r)
    if (D <= 0) ctx.addIssue({ code: "custom", path: ["base"], message: "empty base span" })
    if (D > OUT_MAX_SECONDS)
      ctx.addIssue({ code: "custom", path: ["base"], message: `output exceeds ${OUT_MAX_SECONDS}s` })
    if (ovLen > OUT_MAX_SECONDS)
      ctx.addIssue({ code: "custom", path: ["overlay"], message: `overlay exceeds ${OUT_MAX_SECONDS}s` })
    if (D > 0 && r.overlay.at >= D)
      ctx.addIssue({ code: "custom", path: ["overlay", "at"], message: "overlay starts after the base ends" })
    if (r.mode.kind === "pip" && r.mode.box.x + r.mode.box.w > 1.0001)
      ctx.addIssue({ code: "custom", path: ["mode", "box"], message: "box overflows the canvas" })
    for (const [i, c] of r.captions.entries()) {
      if (c.from !== undefined && c.to !== undefined && c.to <= c.from)
        ctx.addIssue({ code: "custom", path: ["captions", i, "to"], message: "to must exceed from" })
    }
  })

export type Recipe = z.infer<typeof recipeSchema>
export type RecipeInput = z.input<typeof recipeSchema>
export type Caption = z.infer<typeof captionSchema>
export type PipBox = z.infer<typeof pipBoxSchema>

type RecipeShape = {
  base: z.infer<typeof baseSchema>
  overlay: { in: number; out: number; at: number }
}

/** Output length in seconds: the base cut, or for an image base its duration (default: overlay length). */
export function outputDurationOf(r: RecipeShape): number {
  const ovLen = r.overlay.out - r.overlay.in
  if (r.base.kind === "video") return r.base.out - r.base.in
  return r.base.duration ?? ovLen
}

// ——— DTOs ———

export type SourceKind = "url" | "upload"
export type SourceMedia = "video" | "image"
export type SourceStatus = "pending" | "ready" | "failed"

export type SourceDto = {
  id: string
  kind: SourceKind
  media: SourceMedia
  status: SourceStatus
  title: string
  url: string | null
  duration: number | null
  width: number | null
  height: number | null
  fps: number | null
  hasAudio: boolean
  windowStart: number | null
  windowEnd: number | null
  error: string | null
  jobId: string | null
  proxyUrl: string | null
  thumbUrl: string | null
  createdAt: number
}

export type RenderDto = {
  slug: string
  title: string
  duration: number
  width: number
  height: number
  bytes: number
  url: string
  posterUrl: string
  shareUrl: string
  createdAt: number
}

export type RenderPage = { items: RenderDto[]; nextCursor: string | null }

export type JobKind = "fetch" | "render"
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled"

export type JobDto = {
  id: string
  kind: JobKind
  status: JobStatus
  stage: string | null
  /** 0..1, or null while indeterminate */
  progress: number | null
  error: string | null
  result: unknown
  createdAt: number
}

export const createSourceUrlSchema = z.object({
  url: z.string().min(1).max(2048),
  /** seconds — required when the video is longer than the whole-fetch limit */
  around: z.number().finite().min(0).optional(),
})

export const createRenderSchema = z.object({
  recipe: recipeSchema,
  title: z.string().trim().max(120).optional(),
})

export type HealthDto = {
  ok: true
  encoder: string
  ytdlp: string | null
}

export type StorageDto = {
  usedBytes: number
  capBytes: number
  renderCapBytes: number
  sources: { count: number; bytes: number; unreferenced: number; unreferencedBytes: number }
  renders: { count: number; bytes: number }
  activeJobs: number
  sourceTtlHours: number
}
