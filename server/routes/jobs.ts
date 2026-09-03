import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { JobQueue, JobEvent } from "../jobs.ts"
import type { Store } from "../store.ts"

const PING_MS = 15_000

export function jobsRoutes(store: Store, queue: JobQueue, gate: Parameters<Hono["use"]>[1]): Hono {
  const r = new Hono()

  r.get("/:id", gate, (c) => {
    const row = store.jobById(c.req.param("id"))
    if (!row) return c.json({ error: "not found" }, 404)
    return c.json(store.jobDto(row))
  })

  r.delete("/:id", gate, (c) => {
    if (!queue.cancel(c.req.param("id"))) return c.json({ error: "not cancellable" }, 409)
    return c.body(null, 204)
  })

  // EventSource cannot set headers, so this is id-gated only — a 96-bit id
  // that leaks nothing but progress numbers.
  r.get("/:id/events", (c) => {
    const id = c.req.param("id")
    const row = store.jobById(id)
    if (!row) return c.json({ error: "not found" }, 404)
    c.header("Cache-Control", "no-cache")
    c.header("X-Accel-Buffering", "no")
    return streamSSE(c, async (stream) => {
      let done = false
      let resolveDone: () => void = () => {}
      const finished = new Promise<void>((res) => (resolveDone = res))
      const send = async (ev: JobEvent) => {
        if (done) return
        if (ev.type === "state") await stream.writeSSE({ event: "state", data: JSON.stringify(ev.job) })
        else if (ev.type === "progress") await stream.writeSSE({ event: "progress", data: JSON.stringify({ progress: ev.progress, stage: ev.stage }) })
        else if (ev.type === "done") {
          await stream.writeSSE({ event: "done", data: JSON.stringify({ result: ev.result }) })
          finish()
        } else {
          await stream.writeSSE({ event: "failed", data: JSON.stringify({ error: ev.error }) })
          finish()
        }
      }
      const finish = () => {
        if (done) return
        done = true
        unsub()
        clearInterval(ping)
        resolveDone()
      }
      const unsub = queue.subscribe(id, (ev) => void send(ev))
      const ping = setInterval(() => void stream.write(": ping\n\n"), PING_MS)
      stream.onAbort(finish)

      const current = store.jobById(id)!
      await stream.writeSSE({ event: "state", data: JSON.stringify(store.jobDto(current)) })
      if (current.status === "done") await send({ type: "done", result: store.jobDto(current).result })
      else if (current.status === "failed" || current.status === "cancelled") await send({ type: "failed", error: current.error ?? current.status })
      await finished
    })
  })

  return r
}
