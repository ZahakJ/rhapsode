import { useEffect, useState } from "react"
import type { JobDto } from "../../shared/recipe.ts"
import { watchJob, stageLabel } from "../api/jobs.ts"

/**
 * Follows a job and paints a bar. onDone/onFail fire once. The bar goes
 * indeterminate (striped, sliding) while progress is null — sectioned
 * yt-dlp downloads report no percent, and we never fake one.
 */
export function JobProgress({
  job,
  onDone,
  onFail,
  compact = false,
}: {
  job: JobDto
  onDone: (result: unknown) => void
  onFail: (error: string) => void
  compact?: boolean
}) {
  const [progress, setProgress] = useState<number | null>(job.progress)
  const [stage, setStage] = useState<string | null>(job.stage)
  const [status, setStatus] = useState(job.status)

  useEffect(() => {
    if (job.status === "done") {
      onDone(job.result)
      return
    }
    if (job.status === "failed" || job.status === "cancelled") {
      onFail(job.error ?? job.status)
      return
    }
    const stop = watchJob(job.id, (ev) => {
      if (ev.type === "state") {
        setStatus(ev.job.status)
        setProgress(ev.job.progress)
        setStage(ev.job.stage)
      } else if (ev.type === "progress") {
        setProgress(ev.progress)
        setStage(ev.stage)
        setStatus("running")
      } else if (ev.type === "done") {
        setProgress(1)
        setStatus("done")
        onDone(ev.result)
      } else {
        setStatus("failed")
        onFail(ev.error)
      }
    })
    return stop
    // the callbacks are stable enough per job; re-subscribing on every render
    // would tear the stream down mid-flight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id])

  const label =
    status === "queued" ? "queued" : status === "done" ? "done" : stageLabel(stage, job.kind)
  const pct = progress === null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100)

  return (
    <div className={`rh-progress${compact ? " rh-progress--compact" : ""}`} role="progressbar"
      aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="rh-progress__row">
        <span className="rh-progress__label">{label}</span>
        <span className="rh-progress__pct mono">{pct === null ? "…" : `${pct}%`}</span>
      </div>
      <div className={`rh-progress__track${pct === null ? " rh-progress__track--indeterminate" : ""}`}>
        <div className="rh-progress__fill" style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  )
}
