import { create } from "zustand"
import { z } from "zod"
import {
  audioSchema,
  captionSchema,
  modeSchema,
  outputSchema,
  outputDurationOf,
  recipeSchema,
  sourceIdSchema,
  type Caption,
  type Recipe,
  type RecipeInput,
  type SourceDto,
} from "../../shared/recipe.ts"
import { clamp, round1 } from "../util/time.ts"

// The composition being edited. Sources are full DTOs (the stage needs their
// proxy URLs and dimensions); everything else mirrors the recipe fields so
// toRecipe() is a straight projection.

export type Mode = Recipe["mode"]
export type Audio = Recipe["audio"]
export type Output = Recipe["output"]

export type ComposeState = {
  base: SourceDto | null
  overlay: SourceDto | null
  baseIn: number
  baseOut: number
  /** image base only; null = follow the clip */
  imageDuration: number | null
  ovIn: number
  ovOut: number
  at: number
  mode: Mode
  audio: Audio
  captions: Caption[]
  output: Output
  title: string
  /** which caption is selected on the stage */
  selectedCaption: number | null

  setBase: (s: SourceDto | null) => void
  setOverlay: (s: SourceDto | null) => void
  patch: (p: Partial<ComposeState>) => void
  setMode: (kind: Mode["kind"]) => void
  addCaption: (text?: string) => void
  updateCaption: (i: number, p: Partial<Caption>) => void
  removeCaption: (i: number) => void
  reset: () => void
  /** null when a required piece is missing */
  toRecipe: () => RecipeInput | null
  outputDuration: () => number
  loadRecipe: (recipe: Recipe, sources: SourceDto[]) => void
}

const DEFAULT_AUDIO: Audio = { base: "duck", overlay: "keep", baseGain: 1, overlayGain: 1 }
const DEFAULT_OUTPUT: Output = { aspect: "source", fit: "contain" }
const DEFAULT_MODE: Mode = { kind: "dub" }

const blank = {
  base: null,
  overlay: null,
  baseIn: 0,
  baseOut: 0,
  imageDuration: null,
  ovIn: 0,
  ovOut: 0,
  at: 0,
  mode: DEFAULT_MODE,
  audio: DEFAULT_AUDIO,
  captions: [] as Caption[],
  output: DEFAULT_OUTPUT,
  title: "",
  selectedCaption: null,
}

/** sensible first cut for a freshly picked source: up to 15 s from the start */
function defaultCut(s: SourceDto): { in: number; out: number } {
  const d = s.duration ?? 0
  return { in: 0, out: round1(Math.min(d, 15)) || d }
}

export const useCompose = create<ComposeState>()((set, get) => ({
  ...blank,

  setBase: (s) => {
    if (!s) return set({ base: null, baseIn: 0, baseOut: 0, imageDuration: null })
    if (s.media === "video") {
      const c = defaultCut(s)
      set({ base: s, baseIn: c.in, baseOut: c.out, imageDuration: null, at: 0 })
    } else {
      set({ base: s, baseIn: 0, baseOut: 0, imageDuration: null, at: 0 })
    }
  },
  setOverlay: (s) => {
    if (!s) return set({ overlay: null, ovIn: 0, ovOut: 0 })
    const c = defaultCut(s)
    set({ overlay: s, ovIn: c.in, ovOut: c.out })
  },
  patch: (p) => set(p),
  setMode: (kind) => {
    const cur = get().mode
    if (cur.kind === kind) return
    if (kind === "dub") set({ mode: { kind: "dub" } })
    else if (kind === "pip") set({ mode: { kind: "pip", box: { x: 0.6, y: 0.05, w: 0.35 } } })
    else set({ mode: { kind: "stack", dir: "bottom" } })
  },
  addCaption: (text = "your headline") => {
    const caps = get().captions
    if (caps.length >= 6) return
    const cap = captionSchema.parse({ text, y: caps.length ? 0.15 + caps.length * 0.12 : 0.85 })
    set({ captions: [...caps, cap], selectedCaption: caps.length })
  },
  updateCaption: (i, p) =>
    set((s) => ({ captions: s.captions.map((c, j) => (j === i ? { ...c, ...p } : c)) })),
  removeCaption: (i) =>
    set((s) => ({
      captions: s.captions.filter((_, j) => j !== i),
      selectedCaption: null,
    })),
  reset: () => set({ ...blank }),

  outputDuration: () => {
    const s = get()
    if (!s.base) return 0
    return outputDurationOf({
      base:
        s.base.media === "video"
          ? { kind: "video", source: s.base.id, in: s.baseIn, out: s.baseOut }
          : { kind: "image", source: s.base.id, duration: s.imageDuration ?? undefined },
      overlay: { in: s.ovIn, out: s.ovOut, at: s.at },
    })
  },

  toRecipe: () => {
    const s = get()
    if (!s.base || !s.overlay) return null
    const base: RecipeInput["base"] =
      s.base.media === "video"
        ? { kind: "video", source: s.base.id, in: s.baseIn, out: s.baseOut }
        : { kind: "image", source: s.base.id, ...(s.imageDuration ? { duration: s.imageDuration } : {}) }
    return {
      v: 1,
      base,
      overlay: { source: s.overlay.id, in: s.ovIn, out: s.ovOut, at: s.at },
      mode: s.mode,
      audio: s.audio,
      captions: s.captions,
      output: s.output,
    }
  },

  loadRecipe: (recipe, sources) => {
    const byId = new Map(sources.map((x) => [x.id, x]))
    const base = byId.get(recipe.base.source) ?? null
    const overlay = byId.get(recipe.overlay.source) ?? null
    set({
      ...blank,
      base,
      overlay,
      baseIn: recipe.base.kind === "video" ? recipe.base.in : 0,
      baseOut: recipe.base.kind === "video" ? recipe.base.out : 0,
      imageDuration: recipe.base.kind === "image" ? (recipe.base.duration ?? null) : null,
      ovIn: recipe.overlay.in,
      ovOut: recipe.overlay.out,
      at: recipe.overlay.at,
      mode: recipe.mode,
      audio: recipe.audio,
      captions: recipe.captions,
      output: recipe.output,
    })
  },
}))

// ——— draft persistence: rhapsode:v1:draft ———

const DRAFT_KEY = "rhapsode:v1:draft"

const draftSchema = z.object({
  baseId: sourceIdSchema.nullable(),
  overlayId: sourceIdSchema.nullable(),
  baseIn: z.number(),
  baseOut: z.number(),
  imageDuration: z.number().nullable(),
  ovIn: z.number(),
  ovOut: z.number(),
  at: z.number(),
  mode: modeSchema,
  audio: audioSchema,
  captions: z.array(captionSchema),
  output: outputSchema,
  title: z.string(),
})
export type Draft = z.infer<typeof draftSchema>

export function saveDraft(): void {
  const s = useCompose.getState()
  const draft: Draft = {
    baseId: s.base?.id ?? null,
    overlayId: s.overlay?.id ?? null,
    baseIn: s.baseIn,
    baseOut: s.baseOut,
    imageDuration: s.imageDuration,
    ovIn: s.ovIn,
    ovOut: s.ovOut,
    at: s.at,
    mode: s.mode,
    audio: s.audio,
    captions: s.captions,
    output: s.output,
    title: s.title,
  }
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    /* quota / private mode */
  }
}

export function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed = draftSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch {
    /* ignore */
  }
}

/** Apply a draft whose sources have been re-resolved against the server. */
export function applyDraft(draft: Draft, base: SourceDto | null, overlay: SourceDto | null): void {
  useCompose.setState({
    ...blank,
    base,
    overlay,
    baseIn: base?.media === "video" ? clamp(draft.baseIn, 0, base.duration ?? 0) : 0,
    baseOut: base?.media === "video" ? clamp(draft.baseOut, 0, base.duration ?? 0) : 0,
    imageDuration: base?.media === "image" ? draft.imageDuration : null,
    ovIn: overlay ? clamp(draft.ovIn, 0, overlay.duration ?? 0) : 0,
    ovOut: overlay ? clamp(draft.ovOut, 0, overlay.duration ?? 0) : 0,
    at: draft.at,
    mode: draft.mode,
    audio: draft.audio,
    captions: draft.captions,
    output: draft.output,
    title: draft.title,
  })
}

/** Validate the current state the way the server will. */
export function validateRecipe(): { ok: true; recipe: RecipeInput } | { ok: false; error: string } {
  const r = useCompose.getState().toRecipe()
  if (!r) return { ok: false, error: "pick a base and a clip first" }
  const parsed = recipeSchema.safeParse(r)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid recipe" }
  }
  return { ok: true, recipe: r }
}
