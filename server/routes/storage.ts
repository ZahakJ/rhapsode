import { Hono } from "hono"
import type { StorageDto } from "../../shared/recipe.ts"
import type { Config } from "../config.ts"
import type { Store } from "../store.ts"
import { sweep } from "../sweep.ts"

// The disk is somebody's desktop. Show what is on it and let the key holder
// clear the cache on demand; the caps in config are the hard ceiling.

export function storageRoutes(store: Store, config: Config): Hono {
  const r = new Hono()

  const dto = (): StorageDto => {
    const s = store.storageStats()
    return {
      usedBytes: s.sources.bytes + s.renders.bytes,
      capBytes: config.diskCapBytes,
      renderCapBytes: config.renderCapBytes,
      sources: s.sources,
      renders: s.renders,
      activeJobs: s.jobs.active,
      sourceTtlHours: config.sourceTtlHours,
    }
  }

  r.get("/", (c) => c.json(dto()))

  // delete every source no render references, regardless of age
  r.post("/sweep", (c) => {
    const before = store.storageStats()
    for (const s of store.unreferencedSourcesOldestFirst()) {
      if (s.status === "pending") continue
      store.deleteSource(s.id)
    }
    sweep(store, config)
    const after = dto()
    return c.json({ freedBytes: before.sources.bytes + before.renders.bytes - after.usedBytes, storage: after })
  })

  return r
}
