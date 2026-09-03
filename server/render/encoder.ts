import { execFile } from "node:child_process"
import type { Encoder } from "./graph.ts"

function run(args: string[], timeout = 20_000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile("ffmpeg", args, { timeout }, (err, _out, stderr) => resolve({ ok: !err, stderr: String(stderr) }))
  })
}

/** Ask the GPU once at boot; fall back to libx264 when it does not answer. */
export async function detectEncoder(forced: Encoder | null): Promise<Encoder> {
  if (forced) return forced
  const { ok } = await run([
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=256x256:d=0.2",
    "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0",
    "-f", "null", "-",
  ])
  return ok ? "h264_nvenc" : "libx264"
}

/** Captions fail only at render time otherwise — prove the font loads at boot. */
export async function selfTestDrawtext(fontPath: string): Promise<string | null> {
  const { ok, stderr } = await run([
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.1",
    "-vf", `drawtext=text=ok:fontfile=${fontPath}:fontsize=20:expansion=none`,
    "-f", "null", "-",
  ])
  return ok ? null : stderr.trim().split("\n").at(-1) ?? "drawtext failed"
}

export async function ytdlpVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("yt-dlp", ["--version"], { timeout: 10_000 }, (err, out) => resolve(err ? null : String(out).trim()))
  })
}
