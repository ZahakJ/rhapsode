#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { runOp, schemas, type Manifest, type OpName } from "./ops.ts"

const USAGE = `rhapsode cut — grab a video and cut it into the pieces you need

  rhapsode cut probe  <url|file>
  rhapsode cut fetch  <url> [--from T --to T] [--height 720] [--no-audio]
  rhapsode cut frames <src> --at 12.5,1:03.2 [...]
  rhapsode cut strip  <src> --from 12 --to 14 (--every 67ms | --fps 15)
  rhapsode cut scenes <src> [--from T --to T] [--threshold 0.3] [--max 60] [--no-extract]
  rhapsode cut clip   <src> --range 12-20 [--range 1:05+3] [--mode auto|copy|encode]
  rhapsode cut sheet  <manifest.json | images...> [--cols 6] [--width 320]
  rhapsode mcp        (MCP server on stdio)

image options   --size 640x360|640x|x360  --fit cover|contain|stretch  --crop w:h:x:y
                --format png|jpg|webp  --quality N  --sheet  --sheet-width 320
run options     --out DIR  --hw auto|cuda|cpu  --jobs 4  --height 1080  --json

Times: 12.5, 1:02.5, 01:02:03, 1500ms. A URL is fetched once with yt-dlp
(only the needed section) and cached in ~/.cache/rhapsode/cut.
Every run writes manifest.json next to its files.`

const OPTIONS = {
  at: { type: "string", multiple: true },
  from: { type: "string" },
  to: { type: "string" },
  every: { type: "string" },
  fps: { type: "string" },
  range: { type: "string", multiple: true },
  mode: { type: "string" },
  threshold: { type: "string" },
  max: { type: "string" },
  "no-extract": { type: "boolean" },
  "no-audio": { type: "boolean" },
  size: { type: "string" },
  fit: { type: "string" },
  crop: { type: "string" },
  format: { type: "string" },
  quality: { type: "string" },
  sheet: { type: "boolean" },
  "sheet-width": { type: "string" },
  cols: { type: "string" },
  width: { type: "string" },
  out: { type: "string", short: "o" },
  hw: { type: "string" },
  jobs: { type: "string", short: "j" },
  height: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const

const num = (v: string | undefined) => (v === undefined ? undefined : Number(v))

export function cliParams(op: OpName, argv: string[]): Record<string, unknown> {
  const { values: v, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  const time = (s: string | undefined) => (s === undefined ? undefined : /^\d+(\.\d+)?$/.test(s) ? Number(s) : s)
  const p: Record<string, unknown> = {}
  if (op === "sheet") {
    const files = positionals
    if (files.length === 1 && files[0]!.endsWith(".json")) p.manifest = files[0]
    else p.images = files
    Object.assign(p, { cols: num(v.cols), width: num(v.width), format: v.format, out: v.out })
  } else {
    if (positionals.length !== 1) throw new Error(`${op} takes one source (URL or file)`)
    p.src = positionals[0]
    p.height = num(v.height)
    if (op !== "probe" && op !== "fetch") Object.assign(p, { out: v.out, hw: v.hw, jobs: num(v.jobs) })
    if (op === "frames" || op === "strip" || op === "scenes") {
      Object.assign(p, {
        format: v.format, quality: num(v.quality), sheet: v.sheet, sheetWidth: num(v["sheet-width"]),
      })
    }
    if (op === "frames" || op === "strip" || op === "scenes" || op === "clip") {
      Object.assign(p, { size: v.size, fit: v.fit, crop: v.crop })
    }
    if (op === "frames") p.at = (v.at ?? []).flatMap((s) => s.split(",")).map((s) => time(s.trim()))
    if (op === "strip" || op === "scenes" || op === "fetch") Object.assign(p, { from: time(v.from), to: time(v.to) })
    if (op === "strip") p.every = v.every ?? (v.fps ? `${v.fps}fps` : undefined)
    if (op === "scenes") Object.assign(p, { threshold: num(v.threshold), max: num(v.max), extract: v["no-extract"] ? false : undefined })
    if (op === "clip") Object.assign(p, { ranges: v.range ?? [], mode: v.mode })
    if (op === "fetch") p.audio = v["no-audio"] ? false : undefined
  }
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k]
  return p
}

function summary(m: Manifest): string {
  const lines: string[] = []
  if (m.info) {
    lines.push(`${m.info.title} — ${m.info.uploader ?? "?"} (${m.info.duration ?? "?"} s)  ${m.info.webpageUrl ?? ""}`)
    for (const c of m.cached ?? []) lines.push(`  cached ${c.file}  ${c.start === null ? "whole" : `${c.start}-${c.end} s`}  ≤${c.maxHeight}p`)
    return lines.join("\n")
  }
  if (m.source) {
    const s = m.source
    lines.push(`${s.title}${s.uploader ? ` — ${s.uploader}` : ""}  ${s.media.width}x${s.media.height} ${s.media.fps.toFixed(2)} fps${s.cacheHit ? "" : `  fetched in ${(s.fetchMs / 1000).toFixed(1)} s`}`)
  }
  for (const o of m.outputs) {
    const t = o.t !== undefined ? `  t=${o.t.toFixed(3)}` : o.start !== undefined && o.end !== undefined ? `  ${o.start}-${o.end} ${o.mode ?? ""}` : ""
    lines.push(`${o.path || "(not extracted)"}${t}${o.score != null ? `  score=${o.score.toFixed(3)}` : ""}`)
  }
  for (const n of m.notes) lines.push(`note: ${n}`)
  lines.push(`${m.outputs.length} outputs in ${(m.elapsedMs / 1000).toFixed(2)} s${m.decode ? `  decode=${m.decode}` : ""}${m.encode ? `  encode=${m.encode}` : ""}`)
  if (m.dir) lines.push(`manifest: ${path.join(m.dir, "manifest.json")}`)
  return lines.join("\n")
}

const ALIASES: Record<string, OpName> = { list_scenes: "scenes", contact_sheet: "sheet" }

async function main(argv: string[]) {
  const [cmd, ...rest] = argv
  if (cmd === "mcp") {
    const { serveMcp } = await import("./mcp.ts")
    return serveMcp()
  }
  if (cmd !== "cut" || !rest.length || rest[0] === "-h" || rest[0] === "--help") {
    console.log(USAGE)
    process.exitCode = cmd && cmd !== "cut" && cmd !== "-h" && cmd !== "--help" ? 2 : 0
    return
  }
  const [rawOp, ...args] = rest
  const op = (ALIASES[rawOp!] ?? rawOp) as OpName
  if (!(op in schemas)) {
    console.error(`unknown op "${rawOp}"\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  const json = args.includes("--json")
  try {
    const m = await runOp(op, cliParams(op, args))
    console.log(json ? JSON.stringify(m, null, 2) : summary(m))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (json) console.log(JSON.stringify({ error: msg }))
    else console.error(`rhapsode cut ${op}: ${msg}`)
    process.exitCode = 1
  }
}

const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : ""
if (entry === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
