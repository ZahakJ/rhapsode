import { spawn } from "node:child_process"

// One spawn wrapper for every child (ffmpeg, ffprobe, yt-dlp): argv only, no
// shell, a hard timeout, abort support, a stderr ring for error messages, and
// per-line stdout for progress parsing.

export type RunOpts = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  onStdoutLine?: (line: string) => void
  /** bytes of stderr kept for the error message */
  stderrKeep?: number
}

export class ProcError extends Error {
  code: number | null
  stderr: string
  constructor(cmd: string, code: number | null, stderr: string, reason?: string) {
    super(reason ?? `${cmd} exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" · ") || "no output"}`)
    this.code = code
    this.stderr = stderr
  }
}

const KILL_GRACE_MS = 5000

export function runProc(cmd: string, args: string[], opts: RunOpts = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    })
    const keep = opts.stderrKeep ?? 8192
    let stderr = ""
    let stdout = ""
    let pending = ""
    let reason: string | undefined
    let timer: NodeJS.Timeout | undefined
    let killer: NodeJS.Timeout | undefined

    const terminate = (why: string) => {
      if (reason) return
      reason = why
      child.kill("SIGTERM")
      killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
    }
    if (opts.timeoutMs) timer = setTimeout(() => terminate(`${cmd} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`), opts.timeoutMs)
    const onAbort = () => terminate("cancelled")
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener("abort", onAbort, { once: true })
    }

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString()
      if (opts.onStdoutLine) {
        pending += s
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ""
        for (const l of lines) if (l) opts.onStdoutLine(l)
      } else if (stdout.length < 64 * 1024 * 1024) stdout += s
    })
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > keep) stderr = stderr.slice(-keep)
    })
    child.on("error", (err) => {
      cleanup()
      reject(new ProcError(cmd, null, stderr, `${cmd} could not start: ${err.message}`))
    })
    child.on("close", (code) => {
      cleanup()
      if (pending && opts.onStdoutLine) opts.onStdoutLine(pending)
      if (reason) reject(new ProcError(cmd, code, stderr, reason))
      else if (code !== 0) reject(new ProcError(cmd, code, stderr))
      else resolve({ stdout, stderr })
    })
    function cleanup() {
      if (timer) clearTimeout(timer)
      if (killer) clearTimeout(killer)
      opts.signal?.removeEventListener("abort", onAbort)
    }
  })
}

/** ffmpeg -progress pipe:1 lines → seconds rendered so far (null when N/A) */
export function parseProgressLine(line: string): { outTimeS?: number; end?: boolean } {
  const eq = line.indexOf("=")
  if (eq === -1) return {}
  const k = line.slice(0, eq)
  const v = line.slice(eq + 1).trim()
  if (k === "progress") return { end: v === "end" }
  if (k === "out_time_us" || k === "out_time_ms") {
    // both are microseconds in practice; guard N/A and negative first blocks
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) return { outTimeS: n / 1e6 }
  }
  return {}
}
