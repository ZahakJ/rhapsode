import { create } from "zustand"
import type { JobDto, SourceDto, StemKind } from "../../shared/recipe.ts"
import { api, ApiError } from "../api/client.ts"
import { watchJob } from "../api/jobs.ts"

// Stems, keyed by the source they were split from. Both the compose page and
// the studio ask the same question — "give me the vocals of X" — so the
// answer (and the job making it) lives in one place. Seeded from any source
// list that comes back from the server; ensure() splits on demand.

export type Stems = Record<StemKind, SourceDto>

export type StemEntry =
  | { status: "idle" }
  | { status: "running"; job: JobDto; progress: number | null; stage: string | null }
  | { status: "ready"; stems: Stems }
  | { status: "failed"; error: string }

type StemsState = {
  byParent: Record<string, StemEntry>
  /** learn about ready stems from a list of sources */
  seed: (sources: SourceDto[]) => void
  /** both halves of a parent — split now if they do not exist yet */
  ensure: (parentId: string) => Promise<Stems>
}

const IDLE: StemEntry = { status: "idle" }
const inflight = new Map<string, Promise<Stems>>()

function pair(list: SourceDto[]): Stems | null {
  const vocals = list.find((s) => s.stem === "vocals" && s.status === "ready")
  const music = list.find((s) => s.stem === "music" && s.status === "ready")
  return vocals && music ? { vocals, music } : null
}

export const useStems = create<StemsState>()((set, get) => ({
  byParent: {},

  seed: (sources) => {
    const grouped = new Map<string, SourceDto[]>()
    for (const s of sources) if (s.parentId && s.stem) grouped.set(s.parentId, [...(grouped.get(s.parentId) ?? []), s])
    if (!grouped.size) return
    set((st) => {
      const byParent = { ...st.byParent }
      for (const [pid, list] of grouped) {
        const stems = pair(list)
        if (stems && byParent[pid]?.status !== "running") byParent[pid] = { status: "ready", stems }
      }
      return { byParent }
    })
  },

  ensure: (parentId) => {
    const cur = get().byParent[parentId]
    if (cur?.status === "ready") return Promise.resolve(cur.stems)
    const live = inflight.get(parentId)
    if (live) return live
    const put = (entry: StemEntry) => set((st) => ({ byParent: { ...st.byParent, [parentId]: entry } }))
    const p = (async () => {
      try {
        const res = await api.splitStems(parentId)
        const settle = (list: SourceDto[]) => {
          const stems = pair(list)
          if (!stems) throw new Error("the split came back incomplete")
          put({ status: "ready", stems })
          return stems
        }
        if (!res.job) return settle(res.stems)
        put({ status: "running", job: res.job, progress: res.job.progress, stage: res.job.stage })
        const result = await new Promise<unknown>((resolve, reject) => {
          watchJob(res.job!.id, (ev) => {
            if (ev.type === "progress") put({ status: "running", job: res.job!, progress: ev.progress, stage: ev.stage })
            else if (ev.type === "state" && (ev.job.status === "running" || ev.job.status === "queued")) put({ status: "running", job: ev.job, progress: ev.job.progress, stage: ev.job.stage })
            else if (ev.type === "done") resolve(ev.result)
            else if (ev.type === "failed") reject(new Error(ev.error))
          })
        })
        const list = Array.isArray(result) ? (result as SourceDto[]) : []
        // the job result carries the fresh rows; fall back to asking for each
        const fresh = pair(list) ? list : await Promise.all(res.stems.map((s) => api.getSource(s.id)))
        return settle(fresh)
      } catch (e) {
        const msg =
          e instanceof ApiError && e.status === 503
            ? "stem separation is not set up on this server"
            : e instanceof Error
              ? e.message
              : "could not split that"
        put({ status: "failed", error: msg })
        throw new Error(msg)
      } finally {
        inflight.delete(parentId)
      }
    })()
    inflight.set(parentId, p)
    return p
  },
}))

export const stemEntry = (byParent: Record<string, StemEntry>, parentId: string | undefined | null): StemEntry =>
  (parentId ? byParent[parentId] : undefined) ?? IDLE

/** "vocals" / "music" / "all" — what a lane is taking from its source */
export type Take = StemKind | "all"
export const takeOf = (stem: SourceDto | null | undefined): Take => stem?.stem ?? "all"
