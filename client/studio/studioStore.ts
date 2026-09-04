import { create } from "zustand"
import { z } from "zod"
import type { Recipe, SourceDto } from "../../shared/recipe.ts"
import {
  audioClipSchema,
  canvasSchema,
  cueSchema,
  trackSchema,
  sequenceDurationOf,
  sequenceSchema,
  visualClipSchema,
  type AudioClip,
  type Cue,
  type Sequence,
  type SequenceInput,
  type Track,
  type VisualClip,
  SEQ_MAX_SECONDS,
} from "../../shared/sequence.ts"
import { api } from "../api/client.ts"
import { clamp, round3 } from "../util/time.ts"

// The studio's one truth: a Sequence (already parsed, defaults filled), the
// sources it names, and the editing state around it. Every structural edit
// goes through `edit()` so undo/redo is a snapshot stack; live drags call
// `mutate()` after one `snapshot()` at pointer-down.

export type AnyClip = VisualClip | AudioClip | Cue
export type ClipboardItem = { kind: Track["kind"]; clip: AnyClip }
export type Panel = "inspector" | "subtitles" | "bin"

export const nid = (): string => Math.random().toString(36).slice(2, 9)

const DRAFT_KEY = "rhapsode:v1:studio"
const HISTORY_MAX = 120

// built by hand: the schema refuses an empty sequence, and a fresh project is exactly that
const blankSequence = (): Sequence => ({
  v: 1,
  canvas: canvasSchema.parse({}),
  tracks: [
    trackSchema.parse({ id: "vis1", kind: "visual", name: "video", clips: [] }),
    trackSchema.parse({ id: "aud1", kind: "audio", name: "music", clips: [] }),
    trackSchema.parse({ id: "txt1", kind: "text", name: "text", clips: [] }),
  ],
})

export type StudioState = {
  seq: Sequence
  title: string
  sources: Record<string, SourceDto>
  selected: string[]
  /** the clip the inspector shows (last selected) */
  primary: string | null
  selectedTrack: string | null
  playhead: number
  playing: boolean
  /** timeline pixels per second */
  zoom: number
  snap: boolean
  panel: Panel
  binSelection: string[]
  past: Sequence[]
  future: Sequence[]
  dirtySince: number

  // ——— sources ———
  addSources: (list: SourceDto[]) => void
  toggleBin: (id: string, multi: boolean) => void

  // ——— editing ———
  snapshot: () => void
  mutate: (fn: (seq: Sequence) => void) => void
  edit: (fn: (seq: Sequence) => void) => void
  undo: () => void
  redo: () => void
  setSequence: (seq: Sequence, title?: string, sources?: SourceDto[]) => void
  newProject: () => void

  addTrack: (kind: Track["kind"]) => string
  removeTrack: (trackId: string) => void
  moveTrack: (trackId: string, dir: -1 | 1) => void
  patchTrack: (trackId: string, p: Partial<{ name: string; muted: boolean }>) => void
  addClipFromSource: (source: SourceDto, opts?: { at?: number; trackId?: string; duration?: number }) => string | null
  addCue: (opts?: { at?: number; duration?: number; text?: string; trackId?: string }) => string | null
  patchClip: (clipId: string, p: Record<string, unknown>) => void
  moveClip: (clipId: string, at: number, trackId?: string) => void
  removeClips: (ids: string[]) => void
  duplicateClips: (ids: string[]) => void
  splitAt: (clipId: string, t: number) => void
  makeMontage: (sourceIds: string[], each: number, cross: number) => void
  fitMusic: (clipId: string) => void

  // ——— premiere-ish editing ———
  rippleDelete: (ids: string[]) => void
  rippleTrim: (clipId: string, t: number, side: "prev" | "next") => void
  nudge: (ids: string[], dt: number) => void
  moveSelectionTrack: (ids: string[], dir: -1 | 1) => void
  trackToEdge: (trackId: string, edge: "front" | "back") => void
  selectAllOnTrack: (trackId: string | null) => void
  copySelection: (ids: string[]) => ClipboardItem[]
  pasteAt: (items: ClipboardItem[], at: number, trackId?: string | null) => string[]
  editPoints: () => number[]
  setClipOrder: (trackId: string, toIndex: number) => void

  // ——— ui ———
  select: (id: string | null, additive?: boolean) => void
  selectTrack: (id: string | null) => void
  setPlayhead: (t: number) => void
  setPlaying: (p: boolean) => void
  setZoom: (z: number) => void
  setSnap: (s: boolean) => void
  setPanel: (p: Panel) => void
  setTitle: (t: string) => void
  setCanvas: (p: Partial<Sequence["canvas"]>) => void
  setDuration: (d: number | undefined) => void
}

export const duration = (seq: Sequence): number => sequenceDurationOf(seq)

export function findClip(seq: Sequence, id: string): { track: Track; clip: AnyClip; index: number } | null {
  for (const track of seq.tracks) {
    const index = (track.clips as AnyClip[]).findIndex((c) => c.id === id)
    if (index !== -1) return { track, clip: (track.clips as AnyClip[])[index]!, index }
  }
  return null
}

export function clipLength(track: Track, clip: AnyClip): number {
  if (track.kind === "audio") {
    const a = clip as AudioClip
    return a.out - a.in
  }
  return (clip as VisualClip | Cue).duration
}

const clone = (seq: Sequence): Sequence => JSON.parse(JSON.stringify(seq)) as Sequence

/** the studio treats a video source with sound as usable on audio tracks */
export const isAudioSource = (s: SourceDto): boolean => s.media === "audio" || (s.media === "video" && s.hasAudio)
export const isVisualSource = (s: SourceDto): boolean => s.media === "image" || (s.media === "video" && (s.width ?? 0) > 0)

export const useStudio = create<StudioState>()((set, get) => ({
  seq: blankSequence(),
  title: "",
  sources: {},
  selected: [],
  primary: null,
  selectedTrack: null,
  playhead: 0,
  playing: false,
  zoom: 60,
  snap: true,
  panel: "inspector",
  binSelection: [],
  past: [],
  future: [],
  dirtySince: 0,

  addSources: (list) =>
    set((s) => {
      const sources = { ...s.sources }
      for (const src of list) sources[src.id] = src
      return { sources }
    }),

  toggleBin: (id, multi) =>
    set((s) => {
      if (!multi) return { binSelection: s.binSelection.length === 1 && s.binSelection[0] === id ? [] : [id] }
      return { binSelection: s.binSelection.includes(id) ? s.binSelection.filter((x) => x !== id) : [...s.binSelection, id] }
    }),

  snapshot: () => set((s) => ({ past: [...s.past.slice(-HISTORY_MAX + 1), clone(s.seq)], future: [] })),

  mutate: (fn) =>
    set((s) => {
      const seq = clone(s.seq)
      fn(seq)
      return { seq, dirtySince: Date.now() }
    }),

  edit: (fn) => {
    get().snapshot()
    get().mutate(fn)
  },

  undo: () =>
    set((s) => {
      const prev = s.past.at(-1)
      if (!prev) return {}
      return { seq: prev, past: s.past.slice(0, -1), future: [clone(s.seq), ...s.future].slice(0, HISTORY_MAX), dirtySince: Date.now() }
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0]
      if (!next) return {}
      return { seq: next, future: s.future.slice(1), past: [...s.past, clone(s.seq)].slice(-HISTORY_MAX), dirtySince: Date.now() }
    }),

  setSequence: (seq, title, sources) =>
    set((s) => ({
      seq,
      title: title ?? s.title,
      sources: sources ? { ...s.sources, ...Object.fromEntries(sources.map((x) => [x.id, x])) } : s.sources,
      selected: [],
      primary: null,
      past: [],
      future: [],
      playhead: 0,
      dirtySince: Date.now(),
    })),

  newProject: () => {
    get().setSequence(blankSequence(), "")
    clearStudioDraft()
  },

  addTrack: (kind) => {
    const id = nid()
    const name = kind === "visual" ? "video" : kind === "audio" ? "audio" : "text"
    get().edit((seq) => {
      const count = seq.tracks.filter((t) => t.kind === kind).length
      const track = { id, kind, name: count ? `${name} ${count + 1}` : name, muted: false, clips: [] } as Track
      // visual tracks stack: a new one goes on top (end of the array); audio/text append too
      seq.tracks.push(track)
    })
    set({ selectedTrack: id })
    return id
  },

  removeTrack: (trackId) => {
    get().edit((seq) => {
      seq.tracks = seq.tracks.filter((t) => t.id !== trackId)
    })
    set((s) => ({ selectedTrack: s.selectedTrack === trackId ? null : s.selectedTrack, selected: [], primary: null }))
  },

  moveTrack: (trackId, dir) =>
    get().edit((seq) => {
      const i = seq.tracks.findIndex((t) => t.id === trackId)
      const j = i + dir
      if (i === -1 || j < 0 || j >= seq.tracks.length) return
      const [t] = seq.tracks.splice(i, 1)
      seq.tracks.splice(j, 0, t!)
    }),

  patchTrack: (trackId, p) =>
    get().edit((seq) => {
      const t = seq.tracks.find((x) => x.id === trackId)
      if (t) Object.assign(t, p)
    }),

  addClipFromSource: (source, opts = {}) => {
    const s = get()
    const at = round3(opts.at ?? s.playhead)
    let id: string | null = null
    s.edit((seq) => {
      const visual = isVisualSource(source)
      const audioOnly = !visual && isAudioSource(source)
      let track: Track | undefined = opts.trackId ? seq.tracks.find((t) => t.id === opts.trackId) : undefined
      if (track && ((track.kind === "visual" && !visual) || (track.kind === "audio" && !isAudioSource(source)) || track.kind === "text")) track = undefined
      if (!track) {
        const wantKind = audioOnly ? "audio" : "visual"
        // the topmost track of that kind with room at `at`, else a new one
        const candidates = seq.tracks.filter((t) => t.kind === wantKind)
        track = [...candidates].reverse().find((t) => !(t.clips as AnyClip[]).some((c) => overlaps(t, c, at, at + 0.001)))
        if (!track) {
          track = { id: nid(), kind: wantKind, name: wantKind === "audio" ? "audio" : "video", muted: false, clips: [] } as Track
          seq.tracks.push(track)
        }
      }
      id = nid()
      if (track.kind === "audio") {
        const len = Math.min(source.duration ?? 10, opts.duration ?? source.duration ?? 10)
        ;(track.clips as AudioClip[]).push(audioClipSchema.parse({ id, source: source.id, at, in: 0, out: round3(len), gain: 1 }))
      } else {
        const dur = source.media === "image" ? (opts.duration ?? 4) : Math.min(source.duration ?? 10, opts.duration ?? Math.min(source.duration ?? 10, 30))
        ;(track.clips as VisualClip[]).push(visualClipSchema.parse({ id, source: source.id, at, duration: round3(dur), in: 0 }))
      }
    })
    if (id) set({ selected: [id], primary: id })
    return id
  },

  addCue: (opts = {}) => {
    const s = get()
    let id: string | null = null
    let placedAt = s.playhead
    s.edit((seq) => {
      let track = opts.trackId ? seq.tracks.find((t) => t.id === opts.trackId && t.kind === "text") : undefined
      if (!track) track = seq.tracks.find((t) => t.kind === "text")
      if (!track) {
        track = { id: nid(), kind: "text", name: "text", muted: false, clips: [] }
        seq.tracks.push(track)
      }
      id = nid()
      const cues = track.clips as Cue[]
      // a cue already covering (or starting at) this time pushes the new one
      // to the end of whatever overlaps — so Enter, Enter, Enter chains cues
      let at = round3(opts.at ?? s.playhead)
      for (let i = 0; i < 100; i++) {
        const hit = cues.filter((c) => c.at <= at + 0.05 && c.at + c.duration > at)
        if (!hit.length) break
        at = round3(Math.max(...hit.map((c) => c.at + c.duration)))
      }
      placedAt = at
      cues.push(cueSchema.parse({ id, at, duration: opts.duration ?? 2.5, text: opts.text ?? "new line" }))
    })
    if (id) set({ selected: [id], primary: id, playhead: placedAt })
    return id
  },

  patchClip: (clipId, p) =>
    get().edit((seq) => {
      const f = findClip(seq, clipId)
      if (f) Object.assign(f.clip, p)
    }),

  moveClip: (clipId, at, trackId) =>
    get().mutate((seq) => {
      const f = findClip(seq, clipId)
      if (!f) return
      f.clip.at = round3(Math.max(0, at))
      if (trackId && trackId !== f.track.id) {
        const dest = seq.tracks.find((t) => t.id === trackId)
        if (!dest || dest.kind !== f.track.kind) return
        ;(f.track.clips as AnyClip[]).splice(f.index, 1)
        ;(dest.clips as AnyClip[]).push(f.clip)
      }
    }),

  removeClips: (ids) => {
    if (!ids.length) return
    get().edit((seq) => {
      for (const t of seq.tracks) (t as { clips: AnyClip[] }).clips = (t.clips as AnyClip[]).filter((c) => !ids.includes(c.id))
    })
    set({ selected: [], primary: null })
  },

  duplicateClips: (ids) => {
    const created: string[] = []
    get().edit((seq) => {
      for (const id of ids) {
        const f = findClip(seq, id)
        if (!f) continue
        const copy = JSON.parse(JSON.stringify(f.clip)) as AnyClip
        copy.id = nid()
        copy.at = round3(f.clip.at + clipLength(f.track, f.clip))
        ;(f.track.clips as AnyClip[]).push(copy)
        created.push(copy.id)
      }
    })
    if (created.length) set({ selected: created, primary: created.at(-1) ?? null })
  },

  splitAt: (clipId, t) => {
    const created: string[] = []
    get().edit((seq) => {
      const f = findClip(seq, clipId)
      if (!f) return
      const len = clipLength(f.track, f.clip)
      const off = t - f.clip.at
      if (off <= 0.05 || off >= len - 0.05) return
      const right = JSON.parse(JSON.stringify(f.clip)) as AnyClip
      right.id = nid()
      right.at = round3(t)
      if (f.track.kind === "audio") {
        const a = f.clip as AudioClip
        const b = right as AudioClip
        b.in = round3(a.in + off)
        a.out = round3(a.in + off)
        a.fadeOut = 0
        b.fadeIn = 0
      } else if (f.track.kind === "visual") {
        const a = f.clip as VisualClip
        const b = right as VisualClip
        b.in = round3(a.in + off)
        b.duration = round3(len - off)
        a.duration = round3(off)
        a.fadeOut = 0
        b.fadeIn = 0
        if (a.kenBurns) {
          // the window at the split becomes the end of the left and the start of the right
          const p = off / len
          const mid = {
            x: a.kenBurns.from.x + (a.kenBurns.to.x - a.kenBurns.from.x) * p,
            y: a.kenBurns.from.y + (a.kenBurns.to.y - a.kenBurns.from.y) * p,
            w: a.kenBurns.from.w + (a.kenBurns.to.w - a.kenBurns.from.w) * p,
          }
          b.kenBurns = { from: mid, to: a.kenBurns.to }
          a.kenBurns = { from: a.kenBurns.from, to: mid }
        }
      } else {
        const a = f.clip as Cue
        const b = right as Cue
        b.duration = round3(len - off)
        a.duration = round3(off)
      }
      ;(f.track.clips as AnyClip[]).push(right)
      created.push(right.id)
    })
    if (created.length) set({ selected: created, primary: created[0] ?? null })
  },

  makeMontage: (sourceIds, each, cross) => {
    const s = get()
    const start = s.playhead
    s.edit((seq) => {
      const track = { id: nid(), kind: "visual", name: "montage", muted: false, clips: [] } as Track
      let t = start
      sourceIds.forEach((sid, i) => {
        const src = s.sources[sid]
        if (!src) return
        const zoomIn = i % 2 === 0
        const kb = src.media === "image" ? (zoomIn ? KB_PRESETS.zoomIn : KB_PRESETS.zoomOut) : undefined
        ;(track.clips as VisualClip[]).push(
          visualClipSchema.parse({
            id: nid(),
            source: sid,
            at: round3(t),
            duration: round3(each),
            in: 0,
            fit: "cover",
            fadeIn: i === 0 ? 0 : cross,
            fadeOut: i === sourceIds.length - 1 ? 0 : cross,
            kenBurns: kb,
          }),
        )
        t += each - cross
      })
      seq.tracks.push(track)
    })
    set({ binSelection: [] })
  },

  fitMusic: (clipId) => {
    get().edit((seq) => {
      const f = findClip(seq, clipId)
      if (!f || f.track.kind !== "audio") return
      const a = f.clip as AudioClip
      const src = get().sources[a.source]
      const endWithout = Math.max(
        ...seq.tracks.flatMap((t) => (t.clips as AnyClip[]).filter((c) => c.id !== clipId).map((c) => c.at + clipLength(t, c))),
        0,
      )
      const want = Math.max(1, endWithout - a.at)
      a.out = round3(Math.min(a.in + want, src?.duration ?? a.in + want))
      a.fadeOut = Math.min(2, a.out - a.in)
    })
  },

  rippleDelete: (ids) => {
    if (!ids.length) return
    get().edit((seq) => {
      for (const t of seq.tracks) {
        const gone = (t.clips as AnyClip[]).filter((c) => ids.includes(c.id))
        if (!gone.length) continue
        ;(t as { clips: AnyClip[] }).clips = (t.clips as AnyClip[]).filter((c) => !ids.includes(c.id))
        // close each gap on that track, latest first so earlier shifts don't move the later ones twice
        for (const gc of gone.sort((a, b) => b.at - a.at)) {
          const len = clipLength(t, gc)
          for (const c of t.clips as AnyClip[]) if (c.at >= gc.at + len - 0.001) c.at = round3(c.at - len)
        }
      }
    })
    set({ selected: [], primary: null })
  },

  rippleTrim: (clipId, t, side) =>
    get().edit((seq) => {
      const f = findClip(seq, clipId)
      if (!f) return
      const len = clipLength(f.track, f.clip)
      const start = f.clip.at
      const end = start + len
      if (side === "prev") {
        // trim the head to the playhead and pull the clip (and everything after) back
        if (t <= start || t >= end - 0.1) return
        const cut = t - start
        if (f.track.kind === "audio") (f.clip as AudioClip).in = round3((f.clip as AudioClip).in + cut)
        else {
          ;(f.clip as VisualClip).duration = round3(len - cut)
          if ("in" in f.clip) (f.clip as VisualClip).in = round3((f.clip as VisualClip).in + cut)
        }
        for (const c of f.track.clips as AnyClip[]) if (c.at >= start + 0.001 || c.id === clipId) c.at = round3(c.at - (c.id === clipId ? 0 : cut))
      } else {
        if (t <= start + 0.1 || t >= end) return
        const cut = end - t
        if (f.track.kind === "audio") (f.clip as AudioClip).out = round3((f.clip as AudioClip).out - cut)
        else (f.clip as VisualClip).duration = round3(len - cut)
        for (const c of f.track.clips as AnyClip[]) if (c.at >= end - 0.001) c.at = round3(c.at - cut)
      }
    }),

  nudge: (ids, dt) => {
    if (!ids.length) return
    get().edit((seq) => {
      for (const t of seq.tracks) for (const c of t.clips as AnyClip[]) if (ids.includes(c.id)) c.at = round3(Math.max(0, c.at + dt))
    })
  },

  moveSelectionTrack: (ids, dir) =>
    get().edit((seq) => {
      for (const id of ids) {
        const f = findClip(seq, id)
        if (!f) continue
        const same = seq.tracks.filter((t) => t.kind === f.track.kind)
        const i = same.indexOf(f.track)
        const dest = same[i + dir]
        if (!dest) continue
        ;(f.track.clips as AnyClip[]).splice(f.index, 1)
        ;(dest.clips as AnyClip[]).push(f.clip)
      }
    }),

  trackToEdge: (trackId, edge) =>
    get().edit((seq) => {
      const i = seq.tracks.findIndex((t) => t.id === trackId)
      if (i === -1) return
      const [t] = seq.tracks.splice(i, 1)
      if (edge === "front") seq.tracks.push(t!)
      else seq.tracks.unshift(t!)
    }),

  selectAllOnTrack: (trackId) =>
    set((s) => {
      const tracks = trackId ? s.seq.tracks.filter((t) => t.id === trackId) : s.seq.tracks
      const ids = tracks.flatMap((t) => (t.clips as AnyClip[]).map((c) => c.id))
      return { selected: ids, primary: ids.at(-1) ?? null }
    }),

  copySelection: (ids) => {
    const seq = get().seq
    const items: ClipboardItem[] = []
    for (const t of seq.tracks) for (const c of t.clips as AnyClip[]) if (ids.includes(c.id)) items.push({ kind: t.kind, clip: JSON.parse(JSON.stringify(c)) as AnyClip })
    return items
  },

  pasteAt: (items, at, trackId) => {
    if (!items.length) return []
    const created: string[] = []
    const base = Math.min(...items.map((i) => i.clip.at))
    get().edit((seq) => {
      for (const it of items) {
        let track = trackId ? seq.tracks.find((t) => t.id === trackId && t.kind === it.kind) : undefined
        if (!track) track = [...seq.tracks].reverse().find((t) => t.kind === it.kind)
        if (!track) {
          track = { id: nid(), kind: it.kind, name: it.kind === "visual" ? "video" : it.kind, muted: false, clips: [] } as Track
          seq.tracks.push(track)
        }
        const copy = JSON.parse(JSON.stringify(it.clip)) as AnyClip
        copy.id = nid()
        copy.at = round3(Math.max(0, at + (it.clip.at - base)))
        ;(track.clips as AnyClip[]).push(copy)
        created.push(copy.id)
      }
    })
    set({ selected: created, primary: created.at(-1) ?? null })
    return created
  },

  editPoints: () => {
    const seq = get().seq
    const pts = new Set<number>([0])
    for (const t of seq.tracks) for (const c of t.clips as AnyClip[]) {
      pts.add(round3(c.at))
      pts.add(round3(c.at + clipLength(t, c)))
    }
    return [...pts].sort((a, b) => a - b)
  },

  setClipOrder: (trackId, toIndex) =>
    get().edit((seq) => {
      const i = seq.tracks.findIndex((t) => t.id === trackId)
      if (i === -1) return
      const [t] = seq.tracks.splice(i, 1)
      seq.tracks.splice(Math.max(0, Math.min(seq.tracks.length, toIndex)), 0, t!)
    }),

  select: (id, additive = false) =>
    set((s) => {
      if (id === null) return { selected: [], primary: null }
      if (!additive) return { selected: [id], primary: id, panel: s.panel === "bin" ? "inspector" : s.panel }
      const has = s.selected.includes(id)
      const selected = has ? s.selected.filter((x) => x !== id) : [...s.selected, id]
      return { selected, primary: has ? (selected.at(-1) ?? null) : id }
    }),
  selectTrack: (id) => set({ selectedTrack: id }),
  setPlayhead: (t) => set((s) => ({ playhead: clamp(round3(t), 0, Math.max(0, duration(s.seq))) })),
  setPlaying: (playing) => set({ playing }),
  setZoom: (z) => set({ zoom: clamp(z, 6, 600) }),
  setSnap: (snap) => set({ snap }),
  setPanel: (panel) => set({ panel }),
  setTitle: (title) => set({ title, dirtySince: Date.now() }),
  setCanvas: (p) => get().edit((seq) => Object.assign(seq.canvas, p)),
  setDuration: (d) => get().edit((seq) => (seq.duration = d)),
}))

export const KB_PRESETS = {
  none: undefined,
  zoomIn: { from: { x: 0, y: 0, w: 1 }, to: { x: 0.1, y: 0.1, w: 0.8 } },
  zoomOut: { from: { x: 0.1, y: 0.1, w: 0.8 }, to: { x: 0, y: 0, w: 1 } },
  panRight: { from: { x: 0, y: 0.05, w: 0.85 }, to: { x: 0.15, y: 0.05, w: 0.85 } },
  panLeft: { from: { x: 0.15, y: 0.05, w: 0.85 }, to: { x: 0, y: 0.05, w: 0.85 } },
} as const

function overlaps(track: Track, clip: AnyClip, a: number, b: number): boolean {
  const s = clip.at
  const e = clip.at + clipLength(track, clip)
  return s < b && e > a
}

/** where the sequence ends, ignoring an explicit duration */
export function contentEnd(seq: Sequence): number {
  let end = 0
  for (const t of seq.tracks) for (const c of t.clips as AnyClip[]) end = Math.max(end, c.at + clipLength(t, c))
  return end
}

// ——— validation ———

export const NEUTRAL_LOOK = { brightness: 0, contrast: 1, saturation: 1, gamma: 1, blur: 0, vignette: 0, grayscale: false }
export function isNeutralLook(l: Partial<typeof NEUTRAL_LOOK> | undefined | null): boolean {
  if (!l) return true
  return (Object.keys(NEUTRAL_LOOK) as Array<keyof typeof NEUTRAL_LOOK>).every((k) => (l[k] ?? NEUTRAL_LOOK[k]) === NEUTRAL_LOOK[k])
}

/** transform/look go over the wire only when they do something */
export function stripNeutral(seq: Sequence): Sequence {
  const out = JSON.parse(JSON.stringify(seq)) as Sequence
  for (const t of out.tracks)
    if (t.kind === "visual")
      for (const c of t.clips) {
        const tr = c.transform
        if (!tr || (Math.abs(tr.x) < 1e-6 && Math.abs(tr.y) < 1e-6 && Math.abs(tr.scale - 1) < 1e-6 && Math.abs(tr.rotate) < 1e-6)) delete c.transform
        if (isNeutralLook(c.look)) delete c.look
      }
  return out
}

export function validateSequence(seqIn: Sequence, sources: Record<string, SourceDto>): { ok: true; sequence: SequenceInput } | { ok: false; error: string; clipId?: string } {
  const seq = stripNeutral(seqIn)
  const parsed = sequenceSchema.safeParse(seq)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    let clipId: string | undefined
    if (issue && issue.path[0] === "tracks" && typeof issue.path[1] === "number" && issue.path[2] === "clips" && typeof issue.path[3] === "number") {
      clipId = (seq.tracks[issue.path[1]]?.clips as AnyClip[] | undefined)?.[issue.path[3]]?.id
    }
    return { ok: false, error: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid sequence", clipId }
  }
  if (contentEnd(seq) === 0) return { ok: false, error: "the timeline is empty — add a clip" }
  for (const t of seq.tracks) {
    if (t.kind === "text") continue
    for (const c of t.clips as AnyClip[]) {
      const src = sources[(c as VisualClip).source]
      if (!src) return { ok: false, error: "a clip points at a source that is gone — re-add it", clipId: c.id }
      if (src.status !== "ready") return { ok: false, error: `"${src.title}" is still preparing`, clipId: c.id }
      if (t.kind === "audio" && !src.hasAudio) return { ok: false, error: `"${src.title}" has no sound`, clipId: c.id }
      if (t.kind === "visual" && src.media === "video" && (c as VisualClip).in >= (src.duration ?? 0)) return { ok: false, error: "a clip starts past the end of its source", clipId: c.id }
    }
  }
  if (duration(seq) > SEQ_MAX_SECONDS) return { ok: false, error: `sequences are capped at ${SEQ_MAX_SECONDS}s` }
  return { ok: true, sequence: parsed.data }
}

// ——— persistence ———

const draftSchema = z.object({ title: z.string(), sequence: z.unknown(), savedAt: z.number() })

export function saveStudioDraft(): void {
  const s = useStudio.getState()
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: s.title, sequence: s.seq, savedAt: Date.now() }))
  } catch {
    /* quota / private mode */
  }
}

export function clearStudioDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch {
    /* ignore */
  }
}

/** Restore the draft; sources are re-resolved so a swept one drops its clips. */
export async function restoreStudioDraft(): Promise<boolean> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(DRAFT_KEY)
  } catch {
    return false
  }
  if (!raw) return false
  const d = draftSchema.safeParse(JSON.parse(raw))
  if (!d.success) return false
  const parsed = sequenceSchema.safeParse(d.data.sequence)
  if (!parsed.success) return false
  const seq = parsed.data
  const ids = new Set<string>()
  for (const t of seq.tracks) if (t.kind !== "text") for (const c of t.clips as VisualClip[]) ids.add(c.source)
  const resolved = await Promise.all(
    [...ids].map((id) => api.getSource(id).then((x) => (x.status === "ready" ? x : null)).catch(() => null)),
  )
  const live = new Set(resolved.filter((x): x is SourceDto => !!x).map((x) => x.id))
  for (const t of seq.tracks) if (t.kind !== "text") (t as { clips: AnyClip[] }).clips = (t.clips as VisualClip[]).filter((c) => live.has(c.source))
  useStudio.getState().setSequence(seq, d.data.title, resolved.filter((x): x is SourceDto => !!x))
  return true
}

// ——— from the simple mode ———

/** The two-piece recipe as a sequence: base on track 1, the clip on track 2 (or the music track for a dub). */
export function sequenceFromRecipe(recipe: Recipe, base: SourceDto, overlay: SourceDto): Sequence {
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
      },
    ],
  })
  if (recipe.mode.kind === "dub") {
    tracks.push({
      id: "aud1",
      kind: "audio",
      name: "dub",
      clips: [{ id: nid(), source: overlay.id, at: recipe.overlay.at, in: recipe.overlay.in, out: round3(recipe.overlay.in + ovLen), gain: recipe.audio.overlay === "mute" ? 0 : recipe.audio.overlayGain }],
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

/** Text cues on one track never overlap: nudge `cue` to the nearest free edge of whatever it lands on. */
export function resolveCueOverlap(cues: Cue[], cue: Cue): void {
  for (let i = 0; i < 20; i++) {
    const hit = cues.find((c) => c.id !== cue.id && c.at < cue.at + cue.duration && c.at + cue.duration > cue.at && c.at + c.duration > cue.at)
    if (!hit) return
    const mine = cue.at + cue.duration / 2
    const theirs = hit.at + hit.duration / 2
    cue.at = round3(mine >= theirs ? hit.at + hit.duration : Math.max(0, hit.at - cue.duration))
  }
}
