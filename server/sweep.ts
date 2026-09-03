import fs from "node:fs"
import path from "node:path"
import type { Config } from "./config.ts"
import type { Store } from "./store.ts"

// Sources are a cache (re-fetchable, or re-uploadable); renders are the
// product and never swept. Runs at boot and hourly.

export function sweep(store: Store, config: Config): { sources: number; jobs: number; evicted: number } {
  let sources = 0
  for (const s of store.staleSources(config.sourceTtlHours * 3600_000)) {
    store.deleteSource(s.id)
    sources++
  }
  const active = new Set(store.activeJobs().map((j) => j.id))
  try {
    for (const d of fs.readdirSync(store.jobsDir)) {
      if (!active.has(d)) fs.rmSync(path.join(store.jobsDir, d), { recursive: true, force: true })
    }
    for (const d of fs.readdirSync(store.tmpDir)) fs.rmSync(path.join(store.tmpDir, d), { recursive: true, force: true })
  } catch {
    /* dirs missing */
  }
  const jobs = store.deleteOldJobs(7 * 24 * 3600_000)
  let evicted = 0
  if (store.totalBytes() > config.diskCapBytes) {
    for (const s of store.unreferencedSourcesOldestFirst()) {
      if (store.totalBytes() <= config.diskCapBytes) break
      store.deleteSource(s.id)
      evicted++
    }
  }
  return { sources, jobs, evicted }
}

export function startSweeper(store: Store, config: Config, intervalMs = 3600_000): () => void {
  const tick = () => {
    try {
      const r = sweep(store, config)
      if (r.sources || r.jobs || r.evicted) console.log(`[rhapsode] sweep: ${r.sources} sources, ${r.jobs} jobs, ${r.evicted} evicted`)
    } catch (err) {
      console.warn(`[rhapsode] sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  tick()
  const t = setInterval(tick, intervalMs)
  t.unref()
  return () => clearInterval(t)
}
