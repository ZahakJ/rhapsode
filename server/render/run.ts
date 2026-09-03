import fs from "node:fs"
import path from "node:path"
import type { Recipe } from "../../shared/recipe.ts"
import type { Config } from "../config.ts"
import type { JobCtx } from "../jobs.ts"
import { parseProgressLine, runProc } from "../proc.ts"
import { ffprobe } from "../sources/probe.ts"
import { makePoster } from "../sources/proxy.ts"
import type { Store } from "../store.ts"
import { buildArgs, type Encoder, type SourceInfo } from "./graph.ts"

export type RenderPayload = { slug: string; title: string; recipe: Recipe }

export function sourceInfo(store: Store, id: string): SourceInfo | null {
  const row = store.sourceById(id)
  if (!row || row.status !== "ready") return null
  return {
    id: row.id,
    path: store.origPath(row),
    media: row.media,
    duration: row.duration ?? 0,
    width: row.width ?? 0,
    height: row.height ?? 0,
    fps: row.fps ?? 30,
    hasAudio: row.has_audio === 1,
  }
}

export function makeRenderRunner(store: Store, config: Config, encoder: () => Encoder) {
  return async (payload: unknown, ctx: JobCtx, job: { id: string }) => {
    const { slug, title, recipe } = payload as RenderPayload
    try {
      const sources: Record<string, SourceInfo> = {}
      for (const id of [recipe.base.source, recipe.overlay.source]) {
        const info = sourceInfo(store, id)
        if (!info) throw new Error("a source is no longer available")
        sources[id] = info
      }
      const outPath = path.join(ctx.jobDir, "out.mp4")
      const built = buildArgs({ recipe, sources, jobDir: ctx.jobDir, fontPath: config.fontPath, encoder: encoder(), outPath })
      for (const f of built.captionFiles) fs.writeFileSync(f.path, f.text, "utf8")

      ctx.progress(0, "render")
      await runProc("ffmpeg", built.args, {
        timeoutMs: 30 * 60_000,
        signal: ctx.signal,
        onStdoutLine: (line) => {
          const p = parseProgressLine(line)
          if (p.outTimeS !== undefined) ctx.progress(Math.min(0.97, p.outTimeS / built.duration))
        },
      })

      ctx.progress(0.98, "poster")
      const posterPath = path.join(ctx.jobDir, "poster.jpg")
      await makePoster(outPath, posterPath, built.duration, ctx.signal)
      const probe = await ffprobe(outPath, ctx.signal)

      fs.renameSync(outPath, store.renderPath(slug, "mp4"))
      fs.renameSync(posterPath, store.renderPath(slug, "jpg"))
      const row = store.insertRender({
        slug,
        title,
        recipeJson: JSON.stringify(recipe),
        duration: probe.duration || built.duration,
        width: probe.width || built.width,
        height: probe.height || built.height,
        bytes: fs.statSync(store.renderPath(slug, "mp4")).size + fs.statSync(store.renderPath(slug, "jpg")).size,
        jobId: job.id,
        sourceIds: [recipe.base.source, recipe.overlay.source],
      })
      ctx.progress(1, "done")
      return store.renderDto(row)
    } catch (err) {
      store.releaseSlug(slug)
      throw err
    }
  }
}
