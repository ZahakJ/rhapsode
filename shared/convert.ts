import type { Recipe, SourceDto } from "./recipe.ts"
import { sequenceSchema, type Sequence, type SequenceInput } from "./sequence.ts"

// Simple-mode recipes as studio sequences. Shared: the studio opens a
// compose draft this way, and the server hands Rhapsode Pro a sequence for
// any render, whichever mode made it.

const nid = (): string => Math.random().toString(36).slice(2, 9)
const round3 = (n: number): number => Math.round(n * 1000) / 1000

/** The two-piece recipe as a sequence: base on track 1, the clip on track 2 (or the music track for a dub). */
export function sequenceFromRecipe(recipe: Recipe, base: Pick<SourceDto, "id">, overlay: Pick<SourceDto, "id">): Sequence {
  const D = recipe.base.kind === "video" ? recipe.base.out - recipe.base.in : (recipe.base.duration ?? recipe.overlay.out - recipe.overlay.in)
  const ovLen = Math.min(recipe.overlay.out - recipe.overlay.in, D - recipe.overlay.at)
  const tracks: SequenceInput["tracks"] = []
  tracks.push({
    id: "vis1",
    kind: "visual",
    name: "base",
    clips: [
      {
        id: nid(),
        source: base.id,
        at: 0,
        duration: round3(D),
        in: recipe.base.kind === "video" ? recipe.base.in : 0,
        fit: recipe.output.fit,
        edit: recipe.base.edit,
        volume: recipe.base.kind === "video" ? (recipe.audio.base === "mute" ? 0 : recipe.audio.baseGain * (recipe.audio.base === "duck" ? 0.35 : 1)) : 1,
        soundFrom: recipe.base.kind === "video" ? recipe.audio.baseFrom : undefined,
      },
    ],
  })
  if (recipe.mode.kind === "dub") {
    // a stem shares its parent's timeline, so it can simply BE the dub's source
    tracks.push({
      id: "aud1",
      kind: "audio",
      name: "dub",
      clips: [{ id: nid(), source: recipe.audio.overlayFrom ?? overlay.id, at: recipe.overlay.at, in: recipe.overlay.in, out: round3(recipe.overlay.in + ovLen), gain: recipe.audio.overlay === "mute" ? 0 : recipe.audio.overlayGain }],
    })
  } else {
    const pip = recipe.mode.kind === "pip"
    const pipBox = recipe.mode.kind === "pip" ? recipe.mode.box : undefined
    tracks.push({
      id: "vis2",
      kind: "visual",
      name: "clip",
      clips: [
        {
          id: nid(),
          source: overlay.id,
          at: recipe.overlay.at,
          duration: round3(ovLen),
          in: recipe.overlay.in,
          fit: pip ? "free" : "contain",
          box: pip ? pipBox : undefined,
          edit: recipe.overlay.edit,
          volume: recipe.audio.overlay === "mute" ? 0 : recipe.audio.overlayGain,
          soundFrom: recipe.audio.overlayFrom,
        },
      ],
    })
  }
  if (recipe.captions.length) {
    tracks.push({
      id: "txt1",
      kind: "text",
      name: "captions",
      clips: recipe.captions.map((c) => ({
        id: nid(),
        at: c.from ?? 0,
        duration: round3(Math.max(0.5, (c.to ?? D) - (c.from ?? 0))),
        text: c.text,
        size: c.size,
        x: c.x,
        y: c.y,
        align: c.align,
        style: "outline" as const,
      })),
    })
  }
  const aspect = recipe.output.aspect === "source" ? "source" : recipe.output.aspect
  return sequenceSchema.parse({ v: 1, canvas: { aspect, sourceOf: aspect === "source" ? base.id : undefined, fps: 30, background: "000000" }, tracks })
}

