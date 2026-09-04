import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { editedDims, type SourceDto } from "../../shared/recipe.ts"
import type { AudioClip, Cue, Sequence, VisualClip } from "../../shared/sequence.ts"
import { EditedMedia } from "../compose/Stage.tsx"
import { clamp, fmtTC } from "../util/time.ts"
import { hasArabic } from "./fields.tsx"
import { duration, useStudio } from "./studioStore.ts"

/**
 * The program monitor: an approximate playback of the sequence. At time t,
 * every active visual clip is drawn bottom→top (stills with a CSS Ken Burns,
 * videos seeked into place), audio clips play through hidden elements, and
 * cues are laid over the top. The render is the truth; this is the sketch.
 */

export function canvasRatio(seq: Sequence, sources: Record<string, SourceDto>): number {
  const a = seq.canvas.aspect
  if (a === "16:9") return 16 / 9
  if (a === "9:16") return 9 / 16
  if (a === "1:1") return 1
  if (a === "4:5") return 4 / 5
  const src = seq.canvas.sourceOf ? sources[seq.canvas.sourceOf] : undefined
  if (!src || !src.width || !src.height) return 16 / 9
  return src.width / src.height
}

export function Monitor() {
  const seq = useStudio((s) => s.seq)
  const sources = useStudio((s) => s.sources)
  const playhead = useStudio((s) => s.playhead)
  const playing = useStudio((s) => s.playing)
  const setPlayhead = useStudio((s) => s.setPlayhead)
  const setPlaying = useStudio((s) => s.setPlaying)
  const primary = useStudio((s) => s.primary)
  const select = useStudio((s) => s.select)
  const stageRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const D = duration(seq)
  const ratio = canvasRatio(seq, sources)

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // the clock: rAF while playing
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const st = useStudio.getState()
      const next = st.playhead + dt
      if (next >= duration(st.seq)) {
        st.setPlayhead(0)
        st.setPlaying(false)
        return
      }
      st.setPlayhead(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const t = playhead
  const layers = useMemo(() => {
    const out: Array<{ track: string; clip: VisualClip; len: number }> = []
    for (const track of seq.tracks) {
      if (track.kind !== "visual" || track.muted) continue
      for (const clip of track.clips) {
        const src = sources[clip.source]
        if (!src) continue
        const len = src.media === "video" ? Math.min(clip.duration, Math.max(0.1, (src.duration ?? clip.duration) - clip.in)) : clip.duration
        out.push({ track: track.id, clip, len })
      }
    }
    return out
  }, [seq, sources])

  const audios = useMemo(() => {
    const out: AudioClip[] = []
    for (const track of seq.tracks) if (track.kind === "audio" && !track.muted) out.push(...track.clips)
    return out
  }, [seq])

  const cues = useMemo(() => {
    const out: Cue[] = []
    for (const track of seq.tracks) if (track.kind === "text" && !track.muted) out.push(...track.clips)
    return out
  }, [seq])

  const active = (at: number, len: number) => t >= at && t < at + len

  return (
    <div className="st-monitor">
      <div ref={stageRef} className="st-stage" style={{ aspectRatio: `${ratio}`, background: `#${seq.canvas.background}` }} onClick={() => select(null)}>
        {layers.map(({ clip, len }) =>
          active(clip.at, len) ? <VisualLayer key={clip.id} clip={clip} len={len} src={sources[clip.source]!} t={t} size={size} playing={playing} selected={primary === clip.id} /> : null,
        )}
        {audios.map((a) => (active(a.at, a.out - a.in) ? <AudioLayer key={a.id} clip={a} src={sources[a.source]} t={t} playing={playing} /> : null))}
        {cues.map((c) => (active(c.at, c.duration) ? <CueLayer key={c.id} cue={c} size={size} selected={primary === c.id} /> : null))}
        {layers.length === 0 && cues.length === 0 && <div className="st-stage__empty">drop media on the timeline, or hit “+ add” in the bin</div>}
      </div>
      <div className="st-monitor__bar">
        <button className="st-play" onClick={() => setPlaying(!playing)} aria-label={playing ? "pause" : "play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="st-tc mono">
          <span className="st-tc__now">{fmtTC(t)}</span> <span className="st-tc__sep">/</span> {fmtTC(D)}
        </span>
        <input className="st-scrub" type="range" min={0} max={Math.max(0.001, D)} step={0.001} value={clamp(t, 0, D)} onChange={(e) => setPlayhead(Number(e.target.value))} aria-label="playhead" />
        <span className="rh-hint st-monitor__note">preview is approximate · the render is truth</span>
      </div>
    </div>
  )
}

function fadeFactor(clip: { fadeIn: number; fadeOut: number; at: number }, len: number, t: number): number {
  let f = 1
  const off = t - clip.at
  if (clip.fadeIn > 0) f = Math.min(f, clamp(off / clip.fadeIn, 0, 1))
  if (clip.fadeOut > 0) f = Math.min(f, clamp((len - off) / clip.fadeOut, 0, 1))
  return f
}

function VisualLayer({ clip, len, src, t, size, playing, selected }: { clip: VisualClip; len: number; src: SourceDto; t: number; size: { w: number; h: number }; playing: boolean; selected: boolean }) {
  const opacity = clip.opacity * fadeFactor(clip, len, t)
  const dims = editedDims({ width: src.width || 16, height: src.height || 9 }, clip.edit ?? null)
  const aspect = dims.width / dims.height
  let box: CSSProperties
  let boxW = size.w
  let boxH = size.h
  if (clip.fit === "free" && clip.box) {
    boxW = size.w * clip.box.w
    boxH = boxW / aspect
    box = { left: size.w * clip.box.x, top: size.h * clip.box.y, width: boxW, height: boxH }
  } else {
    box = { left: 0, top: 0, width: size.w, height: size.h }
  }
  const media =
    src.media === "image" ? (
      <KenBurnsImage clip={clip} src={src} t={t} len={len} />
    ) : (
      <ClipVideo src={src} want={clip.in + (t - clip.at)} playing={playing} volume={clip.volume} />
    )
  return (
    <div className={`st-layer${selected ? " st-layer--sel" : ""}`} style={{ ...box, opacity }} onClick={(e) => { e.stopPropagation(); useStudio.getState().select(clip.id) }}>
      <EditedMedia source={src} edit={clip.edit ?? null} boxW={boxW} boxH={boxH} fit={clip.fit === "cover" ? "cover" : "contain"}>
        {media}
      </EditedMedia>
      {selected && clip.fit === "free" && <FreeBoxHandles clip={clip} size={size} aspect={aspect} />}
    </div>
  )
}

function KenBurnsImage({ clip, src, t, len }: { clip: VisualClip; src: SourceDto; t: number; len: number }) {
  const kb = clip.kenBurns
  if (!kb) return <img className="st-media" src={src.proxyUrl ?? src.thumbUrl ?? ""} alt="" draggable={false} />
  const p = clamp((t - clip.at) / len, 0, 1)
  const w = kb.from.w + (kb.to.w - kb.from.w) * p
  const x = kb.from.x + (kb.to.x - kb.from.x) * p
  const y = kb.from.y + (kb.to.y - kb.from.y) * p
  const scale = 1 / w
  return (
    <div className="st-kb">
      <img className="st-media" src={src.proxyUrl ?? src.thumbUrl ?? ""} alt="" draggable={false} style={{ width: `${scale * 100}%`, height: `${scale * 100}%`, left: `${-x * scale * 100}%`, top: `${-y * scale * 100}%`, position: "absolute", maxWidth: "none" }} />
    </div>
  )
}

function ClipVideo({ src, want, playing, volume }: { src: SourceDto; want: number; playing: boolean; volume: number }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    v.muted = volume <= 0
    v.volume = clamp(volume, 0, 1)
    if (Math.abs(v.currentTime - want) > 0.3 || !playing) v.currentTime = Math.max(0, want)
    if (playing) {
      if (v.paused) void v.play().catch(() => {})
    } else if (!v.paused) v.pause()
  }, [want, playing, volume])
  return <video ref={ref} className="st-media" src={src.proxyUrl ?? undefined} playsInline preload="auto" />
}

function AudioLayer({ clip, src, t, playing }: { clip: AudioClip; src: SourceDto | undefined; t: number; playing: boolean }) {
  const ref = useRef<HTMLMediaElement>(null)
  const len = clip.out - clip.in
  const gain = clip.gain * fadeFactor(clip, len, t)
  const want = clip.in + (t - clip.at)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    v.volume = clamp(gain, 0, 1)
    v.muted = gain <= 0
    if (Math.abs(v.currentTime - want) > 0.3 || !playing) v.currentTime = Math.max(0, want)
    if (playing) {
      if (v.paused) void v.play().catch(() => {})
    } else if (!v.paused) v.pause()
  }, [want, playing, gain])
  if (!src?.proxyUrl) return null
  if (src.media === "audio") return <audio ref={ref as React.RefObject<HTMLAudioElement>} className="st-audio" src={src.proxyUrl} preload="auto" />
  return <video ref={ref as React.RefObject<HTMLVideoElement>} className="st-audio" src={src.proxyUrl} playsInline preload="auto" />
}

function CueLayer({ cue, size, selected }: { cue: Cue; size: { w: number; h: number }; selected: boolean }) {
  const fs = Math.max(6, cue.size * size.h)
  const tx = cue.align === "left" ? "0" : cue.align === "right" ? "-100%" : "-50%"
  const drag = useRef<{ id: number; x0: number; y0: number; cx: number; cy: number } | null>(null)
  const style: CSSProperties = {
    left: `${cue.x * 100}%`,
    top: `${cue.y * 100}%`,
    transform: `translate(${tx}, -50%)`,
    fontSize: `${fs}px`,
    textAlign: cue.align,
    color: `#${cue.color}`,
  }
  const arabic = hasArabic(cue.text) || hasArabic(cue.sub ?? "")
  return (
    <div
      className={`st-cue st-cue--${cue.style}${selected ? " st-cue--sel" : ""}${arabic ? " st-cue--arabic" : ""}`}
      style={style}
      onPointerDown={(e) => {
        e.stopPropagation()
        e.preventDefault()
        useStudio.getState().select(cue.id)
        useStudio.getState().snapshot()
        drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, cx: cue.x, cy: cue.y }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId || !size.w) return
        useStudio.getState().mutate((seq) => {
          for (const t of seq.tracks)
            if (t.kind === "text")
              for (const c of t.clips)
                if (c.id === cue.id) {
                  c.x = clamp(d.cx + (e.clientX - d.x0) / size.w, 0, 1)
                  c.y = clamp(d.cy + (e.clientY - d.y0) / size.h, 0, 1)
                }
        })
      }}
      onPointerUp={() => (drag.current = null)}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="st-cue__main" style={cue.style === "outline" ? { WebkitTextStroke: `${Math.max(1, fs / 14)}px #000` } : undefined}>
        {cue.text}
      </span>
      {cue.sub && (
        <span className="st-cue__sub" style={{ fontSize: `${fs * 0.8}px`, color: `#${cue.subColor}`, ...(cue.style === "outline" ? { WebkitTextStroke: `${Math.max(1, (fs * 0.8) / 14)}px #000` } : {}) }}>
          {cue.sub}
        </span>
      )}
    </div>
  )
}

function FreeBoxHandles({ clip, size, aspect }: { clip: VisualClip; size: { w: number; h: number }; aspect: number }) {
  const drag = useRef<{ id: number; kind: "move" | "size"; x0: number; y0: number; box: { x: number; y: number; w: number } } | null>(null)
  const start = (kind: "move" | "size") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    if (!clip.box) return
    useStudio.getState().snapshot()
    drag.current = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, box: { ...clip.box } }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !size.w) return
    const dx = (e.clientX - d.x0) / size.w
    const dy = (e.clientY - d.y0) / size.h
    const box = d.kind === "move" ? { x: clamp(d.box.x + dx, -0.9, 0.95), y: clamp(d.box.y + dy, -0.9, 0.95), w: d.box.w } : { ...d.box, w: clamp(d.box.w + dx, 0.05, 2) }
    useStudio.getState().mutate((seq) => {
      for (const t of seq.tracks)
        if (t.kind === "visual")
          for (const c of t.clips) if (c.id === clip.id) c.box = box
    })
  }
  const up = () => (drag.current = null)
  void aspect
  return (
    <>
      <div className="st-layer__move" onPointerDown={start("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="st-layer__grip" onPointerDown={start("size")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="resize" />
    </>
  )
}
