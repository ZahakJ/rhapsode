import { create } from "zustand"
import type { JobDto, SourceDto } from "../../shared/recipe.ts"
import { api, ApiError } from "../api/client.ts"
import { useAuth } from "../store/authStore.ts"
import { useCompose } from "../store/composeStore.ts"
import { toast } from "../components/Toasts.tsx"

// Getting a file or a link INTO a slot, from anywhere: the picker's buttons,
// a paste, a drop, the phone's clipboard. One store per slot so the picker
// can show whatever is in flight, whoever started it.

export type Slot = "base" | "overlay"

export type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; pct: number; label: string }
  | { kind: "job"; job: JobDto; source: SourceDto }
  | { kind: "around"; url: string; duration: number; title: string }

type IngestState = {
  base: Phase
  overlay: Phase
  setPhase: (slot: Slot, phase: Phase) => void
  ingestFile: (slot: Slot, file: File) => Promise<void>
  ingestUrl: (slot: Slot, url: string, around?: number) => Promise<void>
  cancel: (slot: Slot) => void
  /** a source is ready — hand it to the composition */
  finish: (slot: Slot, source: SourceDto) => void
}

const aborts: Record<Slot, AbortController | null> = { base: null, overlay: null }

export function slotAccepts(slot: Slot, file: File): boolean {
  if (file.type.startsWith("video/")) return true
  if (file.type.startsWith("image/")) return slot === "base"
  // some browsers hand over files with an empty type (mov, drag from finder)
  return !file.type && slot === "base"
}

/** where a file should go, given what is already there */
export function routeFile(file: File): Slot | null {
  const c = useCompose.getState()
  if (file.type.startsWith("image/")) return "base"
  if (file.type.startsWith("video/")) {
    if (!c.base) return "base"
    if (!c.overlay) return "overlay"
    return "overlay"
  }
  return null
}

export function routeUrl(): Slot | null {
  const c = useCompose.getState()
  if (!c.base) return "base"
  if (!c.overlay) return "overlay"
  return null
}

export function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text.trim())
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

export const useIngest = create<IngestState>()((set, get) => ({
  base: { kind: "idle" },
  overlay: { kind: "idle" },

  setPhase: (slot, phase) => set({ [slot]: phase } as Partial<IngestState>),

  finish: (slot, source) => {
    const c = useCompose.getState()
    if (slot === "base") c.setBase(source)
    else c.setOverlay(source)
    set({ [slot]: { kind: "idle" } } as Partial<IngestState>)
  },

  cancel: (slot) => {
    aborts[slot]?.abort()
    aborts[slot] = null
    set({ [slot]: { kind: "idle" } } as Partial<IngestState>)
  },

  ingestFile: async (slot, file) => {
    if (!useAuth.getState().verified) {
      toast("enter the invite key first (top right)", "warn")
      return
    }
    if (!slotAccepts(slot, file)) {
      toast(slot === "overlay" ? "the clip on top has to be a video" : "that file type is not supported", "warn")
      return
    }
    const ctl = new AbortController()
    aborts[slot] = ctl
    get().setPhase(slot, { kind: "uploading", pct: 0, label: "uploading" })
    try {
      const res = await api.uploadSource(file, (pct) => get().setPhase(slot, { kind: "uploading", pct, label: "uploading" }), ctl.signal)
      handleCreated(slot, res)
    } catch (e) {
      if (ctl.signal.aborted) return
      toast(e instanceof Error ? e.message : "upload failed", "danger")
      get().setPhase(slot, { kind: "idle" })
    } finally {
      aborts[slot] = null
    }
  },

  ingestUrl: async (slot, url, around) => {
    if (!useAuth.getState().verified) {
      toast("enter the invite key first (top right)", "warn")
      return
    }
    const u = url.trim()
    if (!isHttpUrl(u)) {
      toast("that is not a link", "warn")
      return
    }
    get().setPhase(slot, { kind: "uploading", pct: 0, label: "asking the site" })
    try {
      const res = await api.createUrlSource(u, around)
      handleCreated(slot, res)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        get().setPhase(slot, {
          kind: "around",
          url: u,
          duration: typeof e.body.duration === "number" ? e.body.duration : 0,
          title: typeof e.body.title === "string" ? e.body.title : u,
        })
        return
      }
      toast(e instanceof Error ? e.message : "could not fetch that link", "danger")
      get().setPhase(slot, { kind: "idle" })
    }
  },
}))

function handleCreated(slot: Slot, res: { source: SourceDto; job: JobDto | null }): void {
  const st = useIngest.getState()
  if (res.source.status === "ready" || !res.job) {
    st.finish(slot, res.source)
    toast("already here — reused it")
  } else {
    st.setPhase(slot, { kind: "job", job: res.job, source: res.source })
  }
}
