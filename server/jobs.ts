import { EventEmitter } from "node:events"
import fs from "node:fs"
import type { JobDto, JobKind } from "../shared/recipe.ts"
import type { JobRow, Store } from "./store.ts"

// In-process, lane-limited queue. One process serves this box, so sqlite rows
// are the durable record and an EventEmitter is the live fan-out; a restart
// fails whatever was mid-flight (the client re-submits — payloads are small).

export type JobCtx = {
  jobDir: string
  signal: AbortSignal
  /** null progress = indeterminate (keep the stage, show a spinner) */
  progress: (p: number | null, stage?: string) => void
}

export type JobRunner = (payload: unknown, ctx: JobCtx, job: JobRow) => Promise<unknown>

export type JobEvent =
  | { type: "state"; job: JobDto }
  | { type: "progress"; progress: number | null; stage: string | null }
  | { type: "done"; result: unknown }
  | { type: "failed"; error: string }

type Lane = { limit: number; running: number; queue: string[] }

export class JobQueue {
  private store: Store
  private runners = new Map<JobKind, JobRunner>()
  private lanes: Record<JobKind, Lane>
  private aborts = new Map<string, AbortController>()
  private events = new EventEmitter()
  private keepFailed: boolean
  private lastPersist = new Map<string, number>()

  constructor(store: Store, opts: { lanes?: Partial<Record<JobKind, number>>; keepFailed?: boolean } = {}) {
    this.store = store
    this.keepFailed = opts.keepFailed ?? false
    this.lanes = {
      fetch: { limit: opts.lanes?.fetch ?? 2, running: 0, queue: [] },
      render: { limit: opts.lanes?.render ?? 1, running: 0, queue: [] },
    }
    this.events.setMaxListeners(0)
  }

  register(kind: JobKind, runner: JobRunner): void {
    this.runners.set(kind, runner)
  }

  /** rows left queued/running by a previous process can never finish */
  recoverAtBoot(): number {
    return this.store.failStaleJobs("server restarted").length
  }

  pendingCount(kind: JobKind): number {
    const lane = this.lanes[kind]
    return lane.queue.length + lane.running
  }

  enqueue(kind: JobKind, payload: unknown): JobRow {
    if (!this.runners.has(kind)) throw new Error(`no runner for ${kind}`)
    const job = this.store.insertJob(kind, payload)
    this.lanes[kind].queue.push(job.id)
    queueMicrotask(() => this.pump(kind))
    return job
  }

  cancel(id: string): boolean {
    const job = this.store.jobById(id)
    if (!job) return false
    if (job.status === "queued") {
      const lane = this.lanes[job.kind]
      lane.queue = lane.queue.filter((q) => q !== id)
      this.finish(job, "cancelled", { error: "cancelled" })
      return true
    }
    if (job.status === "running") {
      this.aborts.get(id)?.abort()
      return true
    }
    return false
  }

  subscribe(id: string, fn: (ev: JobEvent) => void): () => void {
    this.events.on(id, fn)
    return () => this.events.off(id, fn)
  }

  private pump(kind: JobKind): void {
    const lane = this.lanes[kind]
    while (lane.running < lane.limit && lane.queue.length > 0) {
      const id = lane.queue.shift()!
      const job = this.store.jobById(id)
      if (!job || job.status !== "queued") continue
      lane.running++
      void this.run(job).finally(() => {
        lane.running--
        this.pump(kind)
      })
    }
  }

  private async run(job: JobRow): Promise<void> {
    const runner = this.runners.get(job.kind)!
    const ac = new AbortController()
    this.aborts.set(job.id, ac)
    const jobDir = this.store.jobDir(job.id)
    fs.mkdirSync(jobDir, { recursive: true })
    this.store.updateJob(job.id, { status: "running", started_at: Date.now(), progress: null, stage: null })
    this.emitState(job.id)
    const ctx: JobCtx = {
      jobDir,
      signal: ac.signal,
      progress: (p, stage) => this.progress(job.id, p, stage),
    }
    let payload: unknown
    try {
      payload = JSON.parse(job.payload_json)
    } catch {
      payload = null
    }
    try {
      const result = await runner(payload, ctx, job)
      this.finish(job, "done", { result })
      fs.rmSync(jobDir, { recursive: true, force: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = ac.signal.aborted ? "cancelled" : "failed"
      this.finish(job, status, { error: msg })
      if (!this.keepFailed) fs.rmSync(jobDir, { recursive: true, force: true })
      if (status === "failed") console.warn(`[rhapsode] job ${job.kind}/${job.id} failed: ${msg}`)
    } finally {
      this.aborts.delete(job.id)
      this.lastPersist.delete(job.id)
    }
  }

  private progress(id: string, p: number | null, stage?: string): void {
    const patch: Partial<JobRow> = { progress: p }
    if (stage !== undefined) patch.stage = stage
    const now = Date.now()
    const last = this.lastPersist.get(id) ?? 0
    // live listeners get every tick; sqlite gets one every 500 ms and on stage changes
    if (stage !== undefined || now - last > 500) {
      this.store.updateJob(id, patch)
      this.lastPersist.set(id, now)
    }
    const row = stage === undefined ? this.store.jobById(id) : null
    this.events.emit(id, { type: "progress", progress: p, stage: stage ?? row?.stage ?? null } satisfies JobEvent)
  }

  private finish(job: JobRow, status: "done" | "failed" | "cancelled", extra: { result?: unknown; error?: string }): void {
    this.store.updateJob(job.id, {
      status,
      finished_at: Date.now(),
      progress: status === "done" ? 1 : null,
      result_json: extra.result === undefined ? null : JSON.stringify(extra.result),
      error: extra.error ?? null,
    })
    this.emitState(job.id)
    if (status === "done") this.events.emit(job.id, { type: "done", result: extra.result } satisfies JobEvent)
    else this.events.emit(job.id, { type: "failed", error: extra.error ?? status } satisfies JobEvent)
  }

  private emitState(id: string): void {
    const row = this.store.jobById(id)
    if (row) this.events.emit(id, { type: "state", job: this.store.jobDto(row) } satisfies JobEvent)
  }
}
