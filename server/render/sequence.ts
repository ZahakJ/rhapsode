import { CANVAS, SOURCE_MAX_EDGE, editedDims } from "../../shared/recipe.ts"
import { sequenceDurationOf, type AudioClip, type Cue, type Sequence, type VisualClip } from "../../shared/sequence.ts"
import { editChain, even, fontFor, type BuildOutput, type Encoder, type Fonts, type SourceInfo } from "./graph.ts"

// The studio render path: one ffmpeg command for a whole multitrack
// sequence. Same discipline as graph.ts — pure, argv-asserted by tests,
// explicit -t, apad on every lane, normalize=0, anullsrc when nothing sounds.
//
// Visual clips are composited bottom→top over a coloured background with
// per-clip alpha (fades, opacity) so overlapping clips dissolve into each
// other. Stills can pan and zoom (zoompan). Text cues burn in through
// drawtext with a second line for translations.

export type SequenceFonts = Fonts

export type SequenceBuildInput = {
  sequence: Sequence
  sources: Record<string, SourceInfo>
  jobDir: string
  fonts: SequenceFonts
  encoder: Encoder
  outPath: string
}

const fmt = (n: number): string => Number(n.toFixed(3)).toString()
const AFORMAT = "aformat=sample_rates=48000:channel_layouts=stereo"

export function sequenceCanvas(seq: Sequence, sources: Record<string, SourceInfo>): { w: number; h: number } {
  const a = seq.canvas.aspect
  if (a === "4:5") return { w: 1080, h: 1350 }
  if (a !== "source") return { ...CANVAS[a] }
  const src = seq.canvas.sourceOf ? sources[seq.canvas.sourceOf] : undefined
  if (!src) return { ...CANVAS["16:9"] }
  const scale = Math.min(1, SOURCE_MAX_EDGE / Math.max(src.width, src.height))
  return { w: even(src.width * scale), h: even(src.height * scale) }
}

export function buildSequenceArgs(input: SequenceBuildInput): BuildOutput {
  const { sequence: seq, sources, jobDir, fonts, encoder, outPath } = input
  const D = sequenceDurationOf(seq)
  const fps = seq.canvas.fps
  const { w: W, h: H } = sequenceCanvas(seq, sources)

  const args: string[] = ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-y"]
  const chains: string[] = []
  const captionFiles: BuildOutput["captionFiles"] = []
  let inputs = 0
  const audioLanes: string[] = []
  const visualLabels: Array<{ label: string; x: number; y: number; at: number; end: number }> = []

  const need = (id: string): SourceInfo => {
    const s = sources[id]
    if (!s) throw new Error(`unknown source ${id}`)
    return s
  }

  // ——— visual tracks, bottom → top ———
  for (const track of seq.tracks) {
    if (track.kind !== "visual" || track.muted) continue
    const clips = track.clips.slice().sort((a, b) => a.at - b.at)
    for (const clip of clips) {
      const src = need(clip.source)
      const dur = src.media === "video" ? Math.min(clip.duration, Math.max(0.1, src.duration - clip.in)) : clip.duration
      const idx = inputs++
      if (src.media === "video") args.push("-ss", fmt(clip.in), "-t", fmt(dur), "-i", src.path)
      else args.push("-loop", "1", "-framerate", String(fps), "-t", fmt(dur), "-i", src.path)

      const label = `v${idx}`
      const dims = editedDims(src, clip.edit)
      const parts: string[] = [`[${idx}:v]setpts=PTS-STARTPTS`]
      const edit = editChain(src, clip.edit)
      if (edit) parts.push(edit.slice(0, -1))
      if (src.media === "image" && clip.kenBurns) parts.push(kenBurns(clip, dims, W, dur, fps))
      const { chain, x, y } = placement(clip, dims, W, H)
      parts.push(chain)
      parts.push("format=yuva420p")
      if (clip.opacity < 1) parts.push(`colorchannelmixer=aa=${fmt(clip.opacity)}`)
      if (clip.fadeIn > 0) parts.push(`fade=t=in:st=0:d=${fmt(Math.min(clip.fadeIn, dur))}:alpha=1`)
      if (clip.fadeOut > 0) parts.push(`fade=t=out:st=${fmt(Math.max(0, dur - clip.fadeOut))}:d=${fmt(Math.min(clip.fadeOut, dur))}:alpha=1`)
      parts.push(`fps=${fps}`, `setpts=PTS+${fmt(clip.at)}/TB`)
      chains.push(`${parts.join(",")}[${label}]`)
      visualLabels.push({ label, x, y, at: clip.at, end: clip.at + dur })

      if (src.media === "video" && src.hasAudio && clip.volume > 0) {
        audioLanes.push(audioLane(idx, clip.volume, 0, 0, clip.at, dur))
      }
    }
  }

  // ——— audio tracks ———
  for (const track of seq.tracks) {
    if (track.kind !== "audio" || track.muted) continue
    for (const clip of track.clips) {
      const src = need(clip.source)
      if (!src.hasAudio) continue
      const len = Math.min(clip.out, src.duration) - clip.in
      if (len <= 0) continue
      const idx = inputs++
      args.push("-ss", fmt(clip.in), "-t", fmt(len), "-i", src.path)
      audioLanes.push(audioLane(idx, clip.gain, clip.fadeIn, clip.fadeOut, clip.at, len))
    }
  }

  // ——— composite ———
  chains.push(`color=c=0x${seq.canvas.background}:s=${W}x${H}:r=${fps}:d=${fmt(D)}[bg]`)
  let prev = "[bg]"
  visualLabels.forEach((v, i) => {
    const out = i === visualLabels.length - 1 ? "[comp]" : `[o${i}]`
    chains.push(`${prev}[${v.label}]overlay=x=${v.x}:y=${v.y}:eof_action=pass:enable='between(t,${fmt(v.at)},${fmt(v.end)})'${out}`)
    prev = out
  })
  if (visualLabels.length === 0) {
    chains.push(`[bg]null[comp]`)
  }

  // ——— text ———
  const tail: string[] = ["format=yuv420p"]
  let cueN = 0
  for (const track of seq.tracks) {
    if (track.kind !== "text" || track.muted) continue
    for (const cue of track.clips) {
      const k = cueN++
      const file = `${jobDir}/cue${k}.txt`
      captionFiles.push({ path: file, text: cue.text })
      const fs = Math.max(8, Math.round(H * cue.size))
      const enable = `enable='between(t,${fmt(cue.at)},${fmt(cue.at + cue.duration)})'`
      const hasSub = !!cue.sub
      const mainY = hasSub ? `${Math.round(H * cue.y)}-text_h-${Math.round(fs * 0.25)}` : `${Math.round(H * cue.y)}-text_h/2`
      tail.push(drawcue(cue, file, fonts, fs, W, mainY, cue.color, enable))
      if (hasSub) {
        const subFile = `${jobDir}/cue${k}s.txt`
        captionFiles.push({ path: subFile, text: cue.sub! })
        const subFs = Math.max(8, Math.round(fs * 0.8))
        tail.push(drawcue({ ...cue, size: cue.size * 0.8 }, subFile, fonts, subFs, W, `${Math.round(H * cue.y)}+${Math.round(fs * 0.25)}`, cue.subColor, enable, cue.sub!))
      }
    }
  }
  chains.push(`[comp]${tail.join(",")}[v]`)

  // ——— mix ———
  if (audioLanes.length === 0) {
    const idx = inputs++
    args.push("-f", "lavfi", "-t", fmt(D), "-i", "anullsrc=r=48000:cl=stereo")
    chains.push(`[${idx}:a]anull[a]`)
  } else if (audioLanes.length === 1) {
    chains.push(`${audioLanes[0]}[a]`)
  } else {
    const labels = audioLanes.map((lane, i) => {
      chains.push(`${lane}[a${i}]`)
      return `[a${i}]`
    })
    chains.push(`${labels.join("")}amix=inputs=${labels.length}:duration=first:normalize=0[a]`)
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
  args.push("-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-map_metadata", "-1", "-progress", "pipe:1", outPath)

  return { args, filterComplex, duration: D, width: W, height: H, fps, captionFiles }
}

function audioLane(idx: number, gain: number, fadeIn: number, fadeOut: number, at: number, len: number): string {
  const parts = [`[${idx}:a]asetpts=PTS-STARTPTS`, AFORMAT, `volume=${fmt(gain)}`]
  if (fadeIn > 0) parts.push(`afade=t=in:st=0:d=${fmt(Math.min(fadeIn, len))}`)
  if (fadeOut > 0) parts.push(`afade=t=out:st=${fmt(Math.max(0, len - fadeOut))}:d=${fmt(Math.min(fadeOut, len))}`)
  parts.push(`adelay=${Math.round(at * 1000)}:all=1`, "apad")
  return parts.join(",")
}

/** Scale/crop the clip for the canvas; returns the chain and the overlay position. */
function placement(clip: VisualClip, dims: { width: number; height: number }, W: number, H: number): { chain: string; x: number; y: number } {
  if (clip.fit === "free" && clip.box) {
    const ow = even(W * clip.box.w)
    return {
      chain: `scale=w=${ow}:h=-2:flags=bicubic,setsar=1`,
      x: Math.round(W * clip.box.x),
      y: Math.round(H * clip.box.y),
    }
  }
  if (clip.fit === "cover") {
    return { chain: `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},setsar=1`, x: 0, y: 0 }
  }
  // contain: pad with transparent so lower tracks stay visible in the bars
  return {
    chain:
      `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic,scale=trunc(iw/2)*2:trunc(ih/2)*2,` +
      `format=yuva420p,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1`,
    x: 0,
    y: 0,
  }
}

/** Pan-and-zoom over a still: a window that glides from `from` to `to` across the clip. */
function kenBurns(clip: VisualClip, dims: { width: number; height: number }, W: number, dur: number, fps: number): string {
  const kb = clip.kenBurns!
  const frames = Math.max(1, Math.round(dur * fps))
  const p = `min(on/${frames},1)`
  const lerp = (a: number, b: number) => `(${fmt(a)}+(${fmt(b - a)})*${p})`
  const zw = even(Math.min(W, dims.width))
  const zh = even((zw * dims.height) / dims.width)
  return (
    `zoompan=z='1/${lerp(kb.from.w, kb.to.w)}':x='iw*${lerp(kb.from.x, kb.to.x)}':y='ih*${lerp(kb.from.y, kb.to.y)}'` +
    `:d=1:s=${zw}x${zh}:fps=${fps}`
  )
}

function drawcue(cue: Cue, file: string, fonts: SequenceFonts, fs: number, W: number, y: string, color: string, enable: string, line?: string): string {
  const ax = Math.round(W * cue.x)
  const x = cue.align === "left" ? `${ax}` : cue.align === "right" ? `${ax}-text_w` : `${ax}-text_w/2`
  const align = cue.align === "left" ? "L" : cue.align === "right" ? "R" : "C"
  const parts = [`textfile=${file}`]
  const face = fontFor(line ?? cue.text, cue.style === "outline" ? "outline" : "clean", fonts)
  if (cue.style === "outline") {
    parts.push(`fontfile=${face}`, `fontsize=${fs}`, `fontcolor=0x${color}`, `borderw=${Math.max(2, Math.round(fs / 14))}`, `bordercolor=black`)
  } else if (cue.style === "clean") {
    parts.push(`fontfile=${face}`, `fontsize=${fs}`, `fontcolor=0x${color}`, `shadowcolor=black@0.7`, `shadowx=${Math.max(1, Math.round(fs / 22))}`, `shadowy=${Math.max(1, Math.round(fs / 22))}`)
  } else {
    parts.push(`fontfile=${face}`, `fontsize=${fs}`, `fontcolor=0x${color}`, `box=1`, `boxcolor=black@0.55`, `boxborderw=${Math.round(fs * 0.35)}`)
  }
  parts.push(`x=${x}`, `y=${y}`, `text_align=${align}+M`, `line_spacing=${Math.round(fs * 0.1)}`, enable, "expansion=none")
  return `drawtext=${parts.join(":")}`
}
