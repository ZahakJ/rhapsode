import type { SourceDto } from "../../shared/recipe.ts"
import { stageLabel } from "../api/jobs.ts"
import { toast } from "./Toasts.tsx"
import { stemEntry, takeOf, useStems, type Stems, type Take } from "../store/stemsStore.ts"

/**
 * "take: everything · vocals · music" for one source. Picking a half splits
 * the source on first use (Demucs, on the server) and shows the job under
 * the switch until the stem exists; after that it is instant. Shared by the
 * compose sound panel and the studio inspector.
 */
export function StemTake({
  source,
  value,
  onChange,
  onStems,
  label = "take",
  block = true,
}: {
  /** the parent — a video or a sound with a voice in it */
  source: SourceDto
  /** the stem currently taken, or null for the file's own sound */
  value: SourceDto | null
  onChange: (stem: SourceDto | null) => void
  /** both halves, the moment they are known (the studio drops them in the bin) */
  onStems?: (stems: Stems) => void
  label?: string
  block?: boolean
}) {
  const entry = useStems((s) => stemEntry(s.byParent, source.id))
  const ensure = useStems((s) => s.ensure)
  const take = takeOf(value)
  const running = entry.status === "running"
  const wanted = running ? pendingTake.get(source.id) ?? null : null

  const pick = (t: Take) => {
    if (t === "all") {
      pendingTake.delete(source.id)
      onChange(null)
      return
    }
    if (entry.status === "ready") {
      onChange(entry.stems[t])
      return
    }
    pendingTake.set(source.id, t)
    ensure(source.id)
      .then((stems) => {
        onStems?.(stems)
        // the user may have changed their mind while it ran
        const still = pendingTake.get(source.id)
        pendingTake.delete(source.id)
        if (still && still !== "all") onChange(stems[still])
      })
      .catch((e) => {
        pendingTake.delete(source.id)
        toast(e instanceof Error ? e.message : "could not split that", "danger")
      })
  }

  const options: Array<{ v: Take; l: string }> = [
    { v: "all", l: "everything" },
    { v: "vocals", l: "vocals" },
    { v: "music", l: "music" },
  ]
  const pct = running && entry.progress !== null ? Math.round(entry.progress * 100) : null
  return (
    <div className={`rh-seg rh-take${block ? " rh-seg--block" : ""}`}>
      <span className="rh-seg__label">{label}</span>
      <div className="ms-seg" role="group" aria-label={`${label} from ${source.title || "source"}`}>
        {options.map((o) => {
          const active = wanted ? o.v === wanted : o.v === take
          return (
            <button
              key={o.v}
              type="button"
              className={`ms-seg__opt${active ? " ms-seg__opt--active" : ""}${wanted && o.v === wanted ? " ms-seg__opt--busy" : ""}`}
              onClick={() => pick(o.v)}
              disabled={running && o.v !== "all"}
              title={o.v === "all" ? "the file's own sound" : o.v === "vocals" ? "just the voice — split by Demucs" : "everything but the voice — split by Demucs"}
            >
              {o.l}
            </button>
          )
        })}
      </div>
      {running && (
        <div className="rh-progress rh-progress--compact rh-take__job" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
          <div className="rh-progress__row">
            <span className="rh-progress__label">{entry.job.status === "queued" ? "queued for the GPU" : stageLabel(entry.stage, "separate")}</span>
            <span className="rh-progress__pct mono">{pct === null ? "…" : `${pct}%`}</span>
          </div>
          <div className={`rh-progress__track${pct === null ? " rh-progress__track--indeterminate" : ""}`}>
            <div className="rh-progress__fill" style={pct === null ? undefined : { width: `${pct}%` }} />
          </div>
        </div>
      )}
      {entry.status === "failed" && <span className="rh-hint rh-take__err">{entry.error}</span>}
    </div>
  )
}

/** which half each parent's switch is waiting on, across re-renders and views */
const pendingTake = new Map<string, Take>()
