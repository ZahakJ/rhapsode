import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { StemKind } from "../../shared/recipe.ts"
import type { Config } from "../config.ts"
import type { JobCtx } from "../jobs.ts"
import { parseProgressLine, runProc } from "../proc.ts"
import type { Encoder } from "../render/graph.ts"
import type { Store } from "../store.ts"
import { finalizeSource } from "./fetch.ts"

// Stems: split a source's sound into the voice and everything else with
// Demucs (htdemucs, two-stem mode). Each half becomes its own audio source —
// kind 'stem', parent_id pointing back — on exactly the parent's timeline,
// so a recipe's in/out apply to the stem unchanged and the render never
// needs the parent's audio track again.
//
// The job: ffmpeg pulls the parent's sound into a wav → demucs writes
// vocals.wav + no_vocals.wav → each is packed to flac as the stem's original
// and finalised like any other source (aac proxy, waveform card, probe).

export type SeparatePayload = { parentId: string; stems: Record<StemKind, string> }

/** Demucs' own name for the "everything but the voice" half. */
const DEMUCS_FILE: Record<StemKind, string> = { vocals: "vocals.wav", music: "no_vocals.wav" }

export function stemTitle(parentTitle: string, stem: StemKind): string {
  const base = parentTitle.trim() || "untitled"
  return `${stem} · ${base}`
}

/** Once at boot: does the configured demucs answer? Loads torch, so a few seconds. */
export function probeDemucs(bin: string): Promise<boolean> {
  if (!bin) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(bin, ["--help"], { timeout: 60_000 }, (err) => resolve(!err))
  })
}

export function makeSeparateRunner(store: Store, config: Config, encoder: () => Encoder) {
  return async (payload: unknown, ctx: JobCtx) => {
    const { parentId, stems } = payload as SeparatePayload
    const parent = store.sourceById(parentId)
    const rows = (Object.keys(stems) as StemKind[]).map((k) => ({ kind: k, row: store.sourceById(stems[k]) }))
    const fail = (msg: string) => {
      for (const { row } of rows) if (row) store.updateSource(row.id, { status: "failed", error: msg })
    }
    try {
      if (!parent || parent.status !== "ready") throw new Error("the source is gone")
      if (rows.some((r) => !r.row)) throw new Error("stem rows vanished")

      // 1. the parent's sound, as demucs likes it
      ctx.progress(0, "extract")
      const wav = path.join(ctx.jobDir, "in.wav")
      const dur = parent.duration || 1
      await runProc(
        "ffmpeg",
        ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-y", "-progress", "pipe:1", "-i", store.origPath(parent),
          "-vn", "-sn", "-dn", "-map", "0:a:0", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", wav],
        {
          timeoutMs: 10 * 60_000,
          signal: ctx.signal,
          onStdoutLine: (line) => {
            const p = parseProgressLine(line)
            if (p.outTimeS !== undefined) ctx.progress(Math.min(0.08, 0.08 * (p.outTimeS / dur)))
          },
        },
      )

      // 2. demucs — progress bars on stderr, one per model in the bag
      ctx.progress(0.08, "separate")
      const outDir = path.join(ctx.jobDir, "sep")
      await runProc(
        config.demucsBin,
        ["-n", config.demucsModel, "--two-stems=vocals", "-o", outDir, "--filename", "{stem}.{ext}", wav],
        {
          timeoutMs: config.stemTimeoutMs,
          signal: ctx.signal,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
          onStderrLine: (line) => {
            const m = /(\d{1,3})%\|/.exec(line)
            if (m) ctx.progress(0.08 + 0.72 * Math.min(1, Number(m[1]) / 100))
          },
        },
      )
      const sepDir = path.join(outDir, config.demucsModel)

      // 3. each half becomes a source
      ctx.progress(0.8, "pack")
      const results = []
      for (const [i, { kind, row }] of rows.entries()) {
        const from = path.join(sepDir, DEMUCS_FILE[kind])
        if (!fs.existsSync(from)) throw new Error(`demucs wrote no ${kind}`)
        const dir = store.sourceDir(row!.id)
        fs.mkdirSync(dir, { recursive: true })
        const orig = path.join(dir, "orig.flac")
        await runProc("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", from, "-c:a", "flac", "-compression_level", "5", orig], {
          timeoutMs: 10 * 60_000,
          signal: ctx.signal,
        })
        const lo = 0.8 + 0.2 * (i / rows.length)
        const hi = 0.8 + 0.2 * ((i + 1) / rows.length)
        results.push(await finalizeSource(store, config, encoder(), row!, orig, ctx, { from: lo, to: hi - 0.005 }))
      }
      ctx.progress(1, "ready")
      return results
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fail(msg)
      for (const { row } of rows) if (row) fs.rmSync(store.sourceDir(row.id), { recursive: true, force: true })
      throw err
    }
  }
}
