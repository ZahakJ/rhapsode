import { z } from "zod"
import { editSchema, sourceIdSchema, type Edit } from "./recipe.ts"

// The studio model: a sequence of tracks. Visual tracks stack bottom→top,
// audio tracks mix, text tracks burn in. Every clip has its own input in the
// render, so the same source can appear as many times as you like. One pure
// builder (server/render/sequence.ts) turns this into one ffmpeg command.

export const SEQ_MAX_SECONDS = 600
export const SEQ_MAX_CLIPS = 80
export const SEQ_MAX_CUES = 400

const unit = z.number().finite().min(0).max(1)
const secs = z.number().finite().min(0).max(4 * 3600)
const id = z.string().min(1).max(40)

export const canvasSchema = z.object({
  aspect: z.enum(["16:9", "9:16", "1:1", "4:5", "source"]).default("16:9"),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).default(30),
  /** hex without # */
  background: z.string().regex(/^[0-9a-fA-F]{6}$/).default("000000"),
  /** 'source' aspect takes its shape from this source */
  sourceOf: sourceIdSchema.optional(),
})

/** A fractional box on the canvas: x,y top-left, w width; height follows the clip's aspect. */
export const boxSchema = z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1), w: z.number().min(0.02).max(3) })

/** Ken Burns: the visible window over the still at the start and at the end (fractions of the image). */
export const kenBurnsSchema = z.object({
  from: z.object({ x: unit, y: unit, w: z.number().min(0.1).max(1) }),
  to: z.object({ x: unit, y: unit, w: z.number().min(0.1).max(1) }),
})

/** Motion on top of the placement: offsets are fractions of the canvas, scale multiplies the placed size, rotation in degrees. */
export const transformSchema = z.object({
  x: z.number().min(-2).max(2).default(0),
  y: z.number().min(-2).max(2).default(0),
  scale: z.number().min(0.05).max(8).default(1),
  rotate: z.number().min(-360).max(360).default(0),
})

/** Picture adjustments, all neutral by default. */
export const lookSchema = z.object({
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(0).max(3).default(1),
  saturation: z.number().min(0).max(3).default(1),
  gamma: z.number().min(0.1).max(4).default(1),
  blur: z.number().min(0).max(50).default(0),
  vignette: z.number().min(0).max(1).default(0),
  grayscale: z.boolean().default(false),
})
export type Transform = z.infer<typeof transformSchema>
export type Look = z.infer<typeof lookSchema>

export const visualClipSchema = z.object({
  id,
  source: sourceIdSchema,
  /** where on the timeline it starts */
  at: secs,
  /** how long it shows; for video, defaults to out-in and is capped by it */
  duration: z.number().positive().max(SEQ_MAX_SECONDS),
  /** video only: where in the source it starts */
  in: secs.default(0),
  edit: editSchema.optional(),
  fit: z.enum(["contain", "cover", "free"]).default("contain"),
  /** used when fit is free */
  box: boxSchema.optional(),
  opacity: unit.default(1),
  fadeIn: z.number().min(0).max(10).default(0),
  fadeOut: z.number().min(0).max(10).default(0),
  kenBurns: kenBurnsSchema.optional(),
  transform: transformSchema.optional(),
  look: lookSchema.optional(),
  /** the video's own sound, 0 = silent */
  volume: z.number().min(0).max(2).default(1),
})

export const audioClipSchema = z.object({
  id,
  source: sourceIdSchema,
  at: secs,
  in: secs,
  out: secs,
  gain: z.number().min(0).max(3).default(1),
  fadeIn: z.number().min(0).max(30).default(0),
  fadeOut: z.number().min(0).max(30).default(0),
})

export const textStyleSchema = z.enum(["outline", "clean", "box"])

export const cueSchema = z.object({
  id,
  at: secs,
  duration: z.number().positive().max(SEQ_MAX_SECONDS),
  text: z.string().trim().min(1).max(300),
  /** the second line — a translation, a speaker name, anything */
  sub: z.string().trim().max(300).optional(),
  style: textStyleSchema.default("outline"),
  /** fraction of canvas height */
  size: z.number().min(0.02).max(0.2).default(0.055),
  x: unit.default(0.5),
  y: unit.default(0.88),
  align: z.enum(["left", "center", "right"]).default("center"),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/).default("ffffff"),
  subColor: z.string().regex(/^[0-9a-fA-F]{6}$/).default("ffd27a"),
})

export const trackSchema = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("visual"), name: z.string().max(40).default("video"), muted: z.boolean().default(false), clips: z.array(visualClipSchema) }),
  z.object({ id, kind: z.literal("audio"), name: z.string().max(40).default("audio"), muted: z.boolean().default(false), clips: z.array(audioClipSchema) }),
  z.object({ id, kind: z.literal("text"), name: z.string().max(40).default("text"), muted: z.boolean().default(false), clips: z.array(cueSchema) }),
])

export const sequenceSchema = z
  .object({
    v: z.literal(1),
    canvas: canvasSchema.default({ aspect: "16:9", fps: 30, background: "000000" }),
    /** explicit length; default = the end of the last clip */
    duration: z.number().positive().max(SEQ_MAX_SECONDS).optional(),
    tracks: z.array(trackSchema).min(1).max(12),
  })
  .superRefine((s, ctx) => {
    const D = sequenceDurationOf(s)
    if (D <= 0) ctx.addIssue({ code: "custom", path: ["tracks"], message: "the sequence is empty" })
    if (D > SEQ_MAX_SECONDS) ctx.addIssue({ code: "custom", path: ["duration"], message: `sequences are capped at ${SEQ_MAX_SECONDS}s` })
    let clips = 0
    let cues = 0
    const ids = new Set<string>()
    s.tracks.forEach((t, ti) => {
      if (ids.has(t.id)) ctx.addIssue({ code: "custom", path: ["tracks", ti, "id"], message: "duplicate id" })
      ids.add(t.id)
      const seen = (cid: string, ci: number) => {
        if (ids.has(cid)) ctx.addIssue({ code: "custom", path: ["tracks", ti, "clips", ci, "id"], message: "duplicate id" })
        ids.add(cid)
      }
      if (t.kind === "text") {
        t.clips.forEach((c, ci) => {
          seen(c.id, ci)
          cues++
        })
      } else if (t.kind === "audio") {
        t.clips.forEach((c, ci) => {
          seen(c.id, ci)
          clips++
          if (c.out <= c.in) ctx.addIssue({ code: "custom", path: ["tracks", ti, "clips", ci, "out"], message: "out must exceed in" })
        })
      } else {
        t.clips.forEach((c, ci) => {
          seen(c.id, ci)
          clips++
          if (c.fit === "free" && !c.box) ctx.addIssue({ code: "custom", path: ["tracks", ti, "clips", ci, "box"], message: "free placement needs a box" })
        })
      }
    })
    if (clips > SEQ_MAX_CLIPS) ctx.addIssue({ code: "custom", path: ["tracks"], message: `at most ${SEQ_MAX_CLIPS} clips` })
    if (cues > SEQ_MAX_CUES) ctx.addIssue({ code: "custom", path: ["tracks"], message: `at most ${SEQ_MAX_CUES} text cues` })
    if (s.canvas.aspect === "source" && !s.canvas.sourceOf) ctx.addIssue({ code: "custom", path: ["canvas", "sourceOf"], message: "source aspect needs sourceOf" })
  })

export type Sequence = z.infer<typeof sequenceSchema>
export type SequenceInput = z.input<typeof sequenceSchema>
export type Track = z.infer<typeof trackSchema>
export type VisualClip = z.infer<typeof visualClipSchema>
export type AudioClip = z.infer<typeof audioClipSchema>
export type Cue = z.infer<typeof cueSchema>
export type TextStyle = z.infer<typeof textStyleSchema>
export type { Edit }

type SeqShape = { duration?: number; tracks: Array<{ kind: string; clips: Array<{ at: number; duration?: number; in?: number; out?: number }> }> }

/** Explicit duration, else the end of the last clip on any track. */
export function sequenceDurationOf(s: SeqShape): number {
  if (s.duration) return s.duration
  let end = 0
  for (const t of s.tracks)
    for (const c of t.clips) {
      const len = c.duration ?? (c.out !== undefined && c.in !== undefined ? c.out - c.in : 0)
      end = Math.max(end, c.at + len)
    }
  return end
}

export const createSequenceRenderSchema = z.object({
  sequence: sequenceSchema,
  title: z.string().trim().max(120).optional(),
})

// ——— SRT ———

export type SrtCue = { index: number; from: number; to: number; text: string }

export function parseSrt(text: string): SrtCue[] {
  const out: SrtCue[] = []
  const blocks = text.replace(/\r/g, "").split(/\n\n+/)
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim() !== "")
    if (lines.length < 2) continue
    let i = 0
    if (/^\d+$/.test(lines[0]!.trim())) i = 1
    const m = lines[i]?.match(/(\d+):(\d\d):(\d\d)[,.](\d{1,3})\s*-->\s*(\d+):(\d\d):(\d\d)[,.](\d{1,3})/)
    if (!m) continue
    const t = (h: string, mm: string, s: string, ms: string) => Number(h) * 3600 + Number(mm) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000
    const from = t(m[1]!, m[2]!, m[3]!, m[4]!)
    const to = t(m[5]!, m[6]!, m[7]!, m[8]!)
    const body = lines
      .slice(i + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .trim()
    if (to > from && body) out.push({ index: out.length + 1, from, to, text: body })
  }
  return out
}

export function formatSrt(cues: Array<{ from: number; to: number; text: string }>): string {
  const ts = (s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    const ms = Math.round((s - Math.floor(s)) * 1000)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`
  }
  return cues
    .slice()
    .sort((a, b) => a.from - b.from)
    .map((c, i) => `${i + 1}\n${ts(c.from)} --> ${ts(c.to)}\n${c.text}\n`)
    .join("\n")
}
