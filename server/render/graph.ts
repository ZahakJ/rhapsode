import { CANVAS, SOURCE_MAX_EDGE, outputDurationOf, type Recipe, type Caption } from "../../shared/recipe.ts"

// The one render path. A pure function from a recipe (plus what we know about
// its sources) to an ffmpeg argv — no fs, no clock, no process — so every
// filter string is pinned by a unit test and the runner is a thin spawn.
//
// Invariants worth knowing before touching a chain:
//   * duration is always an explicit `-t D` on the output, never -shortest;
//     every audio lane is apad'ed so the mix can't end early
//   * `setpts=PTS-STARTPTS` follows every trimmed input (edit lists / priming)
//   * `fps=` precedes the `setpts=PTS+AT/TB` shift, never follows it
//   * amix carries normalize=0 (else each input is halved)
//   * a lane the mode wants but the file lacks is replaced by anullsrc — a
//     `[1:a]` reference to a silent file is a hard ffmpeg error
//   * drawtext option order is load-bearing on ffmpeg 9 (textfile before
//     fontfile, expansion=none last); a test pins it

export type SourceInfo = {
  id: string
  path: string
  media: "video" | "image"
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
}

export type Encoder = "h264_nvenc" | "libx264"

export type BuildInput = {
  recipe: Recipe
  sources: Record<string, SourceInfo>
  jobDir: string
  fontPath: string
  encoder: Encoder
  outPath: string
}

export type BuildOutput = {
  args: string[]
  filterComplex: string
  duration: number
  width: number
  height: number
  fps: number
  /** the runner writes these before spawning */
  captionFiles: Array<{ path: string; text: string }>
}

export const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2)

/** Output canvas for a recipe given the base's display dimensions. */
export function canvasFor(recipe: Recipe, base: { width: number; height: number }): { w: number; h: number } {
  const aspect = recipe.output.aspect
  if (aspect !== "source") return { ...CANVAS[aspect] }
  const scale = Math.min(1, SOURCE_MAX_EDGE / Math.max(base.width, base.height))
  return { w: even(base.width * scale), h: even(base.height * scale) }
}

const fmt = (n: number): string => {
  const s = Number(n.toFixed(3)).toString()
  return s
}

function fit(w: number, h: number, mode: "contain" | "cover"): string {
  if (mode === "cover") {
    return `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bicubic,crop=${w}:${h}`
  }
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=bicubic,` +
    `scale=trunc(iw/2)*2:trunc(ih/2)*2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
  )
}

function fitNoPad(w: number, h: number): string {
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=bicubic,scale=trunc(iw/2)*2:trunc(ih/2)*2`
}

const AFORMAT = "aformat=sample_rates=48000:channel_layouts=stereo"

export function buildArgs(input: BuildInput): BuildOutput {
  const { recipe, jobDir, fontPath, encoder, outPath } = input
  const base = input.sources[recipe.base.source]
  const ov = input.sources[recipe.overlay.source]
  if (!base) throw new Error(`unknown base source ${recipe.base.source}`)
  if (!ov) throw new Error(`unknown overlay source ${recipe.overlay.source}`)
  if (ov.media !== "video") throw new Error("overlay must be a video")
  if (recipe.base.kind === "video" && base.media !== "video") throw new Error("base kind mismatch")
  if (recipe.base.kind === "image" && base.media !== "image") throw new Error("base kind mismatch")

  const D = outputDurationOf(recipe)
  const at = recipe.overlay.at
  const ovLen = Math.min(recipe.overlay.out - recipe.overlay.in, D - at)
  const ovEnd = at + ovLen
  const fps = recipe.base.kind === "video" ? Math.min(60, Math.max(24, Math.round(base.fps || 30))) : 30

  let { w: W, h: H } = canvasFor(recipe, base)
  const mode = recipe.mode
  const fitMode = recipe.output.fit

  // ——— inputs ———
  const args: string[] = ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-y"]
  if (recipe.base.kind === "video") {
    args.push("-ss", fmt(recipe.base.in), "-t", fmt(recipe.base.out - recipe.base.in), "-i", base.path)
  } else {
    args.push("-loop", "1", "-framerate", String(fps), "-i", base.path)
  }
  args.push("-ss", fmt(recipe.overlay.in), "-t", fmt(ovLen), "-i", ov.path)

  const hasBaseAudio = recipe.base.kind === "video" && base.hasAudio
  const wantBase = recipe.audio.base !== "mute" && hasBaseAudio
  const wantOv = recipe.audio.overlay !== "mute" && ov.hasAudio
  const needSilence = !wantBase && !wantOv
  if (needSilence) args.push("-f", "lavfi", "-t", fmt(D), "-i", "anullsrc=r=48000:cl=stereo")

  // ——— video ———
  const chains: string[] = []
  let vOut: string
  if (mode.kind === "stack") {
    const vertical = mode.dir === "top" || mode.dir === "bottom"
    const Lw = vertical ? W : even(W / 2)
    const Lh = vertical ? even(H / 2) : H
    W = vertical ? W : Lw * 2
    H = vertical ? Lh * 2 : H
    chains.push(`[0:v]setpts=PTS-STARTPTS,${fit(Lw, Lh, fitMode)},setsar=1,fps=${fps}[laneA]`)
    chains.push(`[1:v]setpts=PTS-STARTPTS,${fitNoPad(Lw, Lh)},setsar=1,fps=${fps},setpts=PTS+${fmt(at)}/TB[ov]`)
    chains.push(`color=c=black:s=${Lw}x${Lh}:r=${fps}:d=${fmt(D)}[blank]`)
    chains.push(
      `[blank][ov]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:enable='between(t,${fmt(at)},${fmt(ovEnd)})'[laneB]`,
    )
    const first = mode.dir === "top" || mode.dir === "left" ? "[laneB][laneA]" : "[laneA][laneB]"
    chains.push(`${first}${vertical ? "vstack" : "hstack"}[vs]`)
    vOut = "[vs]"
  } else {
    chains.push(`[0:v]setpts=PTS-STARTPTS,${fit(W, H, fitMode)},setsar=1,fps=${fps}[base]`)
    if (mode.kind === "pip") {
      const ow = even(W * mode.box.w)
      const x = Math.round(W * mode.box.x)
      const y = Math.round(H * mode.box.y)
      chains.push(
        `[1:v]setpts=PTS-STARTPTS,scale=w=${ow}:h=-2:flags=bicubic,setsar=1,fps=${fps},setpts=PTS+${fmt(at)}/TB[ov]`,
      )
      chains.push(
        `[base][ov]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${fmt(at)},${fmt(ovEnd)})'[vp]`,
      )
      vOut = "[vp]"
    } else {
      vOut = "[base]"
    }
  }

  // captions ride on the composed frame
  const captionFiles: BuildOutput["captionFiles"] = []
  const tail: string[] = ["format=yuv420p"]
  recipe.captions.forEach((cap, i) => {
    const file = `${jobDir}/cap${i}.txt`
    captionFiles.push({ path: file, text: cap.text })
    tail.push(drawtext(cap, file, fontPath, W, H))
  })
  chains.push(`${vOut}${tail.join(",")}[v]`)

  // ——— audio ———
  const baseLane = `[0:a]asetpts=PTS-STARTPTS,${AFORMAT},volume=${fmt(recipe.audio.baseGain)},apad`
  const ovLane =
    `[1:a]asetpts=PTS-STARTPTS,${AFORMAT},volume=${fmt(recipe.audio.overlayGain)},` +
    `adelay=${Math.round(at * 1000)}:all=1,apad`
  if (needSilence) {
    chains.push(`[2:a]anull[a]`)
  } else if (wantBase && wantOv) {
    if (recipe.audio.base === "duck") {
      chains.push(`${ovLane},asplit=2[oa][sc]`)
      chains.push(`${baseLane}[ba]`)
      chains.push(`[ba][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[bd]`)
      chains.push(`[bd][oa]amix=inputs=2:duration=first:normalize=0[a]`)
    } else {
      chains.push(`${baseLane}[ba]`)
      chains.push(`${ovLane}[oa]`)
      chains.push(`[ba][oa]amix=inputs=2:duration=first:normalize=0[a]`)
    }
  } else if (wantOv) {
    chains.push(`${ovLane}[a]`)
  } else {
    chains.push(`${baseLane}[a]`)
  }

  const filterComplex = chains.join(";")
  args.push("-filter_complex", filterComplex, "-map", "[v]", "-map", "[a]", "-t", fmt(D))
  if (encoder === "h264_nvenc") {
    args.push(
      "-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", "23", "-b:v", "0",
      "-maxrate", "12M", "-bufsize", "24M", "-profile:v", "high", "-pix_fmt", "yuv420p",
    )
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-profile:v", "high", "-pix_fmt", "yuv420p")
  }
  args.push(
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", "-map_metadata", "-1",
    "-progress", "pipe:1",
    outPath,
  )

  return { args, filterComplex, duration: D, width: W, height: H, fps, captionFiles }
}

function drawtext(cap: Caption, file: string, fontPath: string, W: number, H: number): string {
  const fs = Math.max(8, Math.round(H * cap.size))
  const bw = Math.max(2, Math.round(fs / 14))
  const ax = Math.round(W * cap.x)
  const x = cap.align === "left" ? `${ax}` : cap.align === "right" ? `${ax}-text_w` : `${ax}-text_w/2`
  const y = `${Math.round(H * cap.y)}-text_h/2`
  const align = cap.align === "left" ? "L" : cap.align === "right" ? "R" : "C"
  const parts = [
    `textfile=${file}`,
    `fontfile=${fontPath}`,
    `fontsize=${fs}`,
    `fontcolor=white`,
    `borderw=${bw}`,
    `bordercolor=black`,
    `x=${x}`,
    `y=${y}`,
    `text_align=${align}+M`,
    `line_spacing=${Math.round(fs * 0.1)}`,
  ]
  if (cap.from !== undefined || cap.to !== undefined) {
    const from = cap.from ?? 0
    const to = cap.to ?? 1e6
    parts.push(`enable='between(t,${fmt(from)},${fmt(to)})'`)
  }
  parts.push("expansion=none")
  return `drawtext=${parts.join(":")}`
}

/** Paths reach ffmpeg inside a filter string, where these characters are syntax. */
export const SAFE_PATH = /^[A-Za-z0-9_./-]+$/
