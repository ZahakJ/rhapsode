import type { JobDto } from "../../shared/recipe.ts"
import { api } from "./client.ts"

export type JobEvent =
  | { type: "state"; job: JobDto }
  | { type: "progress"; progress: number | null; stage: string | null }
  | { type: "done"; result: unknown }
  | { type: "failed"; error: string }

/**
 * Follow a job to its end. SSE first (`state`/`progress`/`done`/`failed`
 * events from /api/jobs/:id/events); if the stream errors before a terminal
 * event, fall back to polling GET /api/jobs/:id every 1.5 s. Returns a stop
 * function; the callback never fires after stop.
 */
export function watchJob(id: string, onEvent: (ev: JobEvent) => void): () => void {
  let stopped = false
  let done = false
  let es: EventSource | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  const emit = (ev: JobEvent) => {
    if (stopped || done) return
    if (ev.type === "done" || ev.type === "failed") done = true
    onEvent(ev)
    if (done) cleanup()
  }

  const cleanup = () => {
    if (es) {
      es.close()
      es = null
    }
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  const poll = async () => {
    if (stopped || done) return
    try {
      const job = await api.getJob(id)
      emit({ type: "state", job })
      if (job.status === "done") emit({ type: "done", result: job.result })
      else if (job.status === "failed" || job.status === "cancelled")
        emit({ type: "failed", error: job.error ?? job.status })
      else emit({ type: "progress", progress: job.progress, stage: job.stage })
    } catch {
      /* transient — try again */
    }
    if (!stopped && !done) pollTimer = setTimeout(() => void poll(), 1500)
  }

  const parse = <T,>(e: MessageEvent): T | null => {
    try {
      return JSON.parse(String(e.data)) as T
    } catch {
      return null
    }
  }

  if (typeof EventSource !== "undefined") {
    try {
      es = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`)
      es.addEventListener("state", (e) => {
        const job = parse<JobDto>(e as MessageEvent)
        if (job) emit({ type: "state", job })
      })
      es.addEventListener("progress", (e) => {
        const p = parse<{ progress: number | null; stage: string | null }>(e as MessageEvent)
        if (p) emit({ type: "progress", progress: p.progress ?? null, stage: p.stage ?? null })
      })
      es.addEventListener("done", (e) => {
        const p = parse<{ result: unknown }>(e as MessageEvent)
        emit({ type: "done", result: p?.result })
      })
      es.addEventListener("failed", (e) => {
        const p = parse<{ error: string }>(e as MessageEvent)
        emit({ type: "failed", error: p?.error ?? "failed" })
      })
      es.onerror = () => {
        // the stream died before a terminal event (backgrounded phone,
        // proxy hiccup) — switch to polling for the rest
        if (es) {
          es.close()
          es = null
        }
        if (!stopped && !done && !pollTimer) pollTimer = setTimeout(() => void poll(), 500)
      }
    } catch {
      void poll()
    }
  } else {
    void poll()
  }

  return () => {
    stopped = true
    cleanup()
  }
}

/** Human label for a job stage. */
export function stageLabel(stage: string | null | undefined, kind: "fetch" | "render"): string {
  switch (stage) {
    case "metadata":
      return "reading the page"
    case "download":
      return "downloading"
    case "probe":
      return "inspecting"
    case "proxy":
      return "preparing the preview"
    case "thumb":
      return "snapshot"
    case "ready":
      return "ready"
    case "render":
    case "encode":
      return "rendering"
    case "poster":
      return "poster frame"
    default:
      return kind === "fetch" ? "fetching" : "rendering"
  }
}
