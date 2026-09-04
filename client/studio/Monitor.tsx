import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { editedDims, type SourceDto } from "../../shared/recipe.ts"
import { Gizmo, placedRect } from "./Gizmo.tsx"
import type { AudioClip, Cue, Sequence, VisualClip } from "../../shared/sequence.ts"
import { EditedMedia } from "../compose/Stage.tsx"
import { clamp, fmtTC } from "../util/time.ts"
import { hasArabic } from "./fields.tsx"
import { duration, useStudio } from "./studioStore.ts"
import { ctxOnly } from "./ContextMenu.tsx"
import { hooks } from "./commands.ts"
import { toast } from "../components/Toasts.tsx"
import { useUi, type MenuItem } from "./uiStore.ts"

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
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const D = duration(seq)
  const ratio = canvasRatio(seq, sources)
  const tool = useUi((s) => s.tool)
  const safe = useUi((s) => s.safeMargins)
  const grid = useUi((s) => s.grid)
  const captionsPreview = useUi((s) => s.captionsPreview)
  const mz = useUi((s) => s.monitorZoom)
  const mpan = useUi((s) => s.monitorPan)
  const trackFlags = useUi((s) => s.trackFlags)
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] })
  const panRef = useRef<{ id: number; x0: number; y0: number; p: { x: number; y: number } } | null>(null)

  // ⌘/ctrl + wheel zooms the monitor; the hand tool pans it
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const u = useUi.getState()
      u.setMonitorZoom(u.monitorZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), u.monitorPan)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // snapshot: draw the visible media layers onto a canvas (best effort — cues and crops are skipped)
  useEffect(() => {
    hooks.snapshot = () => {
      const stage = stageRef.current
      if (!stage) return
      const cv = document.createElement("canvas")
      cv.width = Math.round(size.w * 2)
      cv.height = Math.round(size.h * 2)
      const ctx = cv.getContext("2d")
      if (!ctx) return
      ctx.fillStyle = `#${useStudio.getState().seq.canvas.background}`
      ctx.fillRect(0, 0, cv.width, cv.height)
      const sr = stage.getBoundingClientRect()
      for (const el of Array.from(stage.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img.st-media, video.st-media"))) {
        const r = el.getBoundingClientRect()
        try {
          ctx.globalAlpha = Number((el.closest(".st-layer") as HTMLElement | null)?.style.opacity || 1)
          ctx.drawImage(el, ((r.left - sr.left) / sr.width) * cv.width, ((r.top - sr.top) / sr.height) * cv.height, (r.width / sr.width) * cv.width, (r.height / sr.height) * cv.height)
        } catch {
          /* tainted / not ready */
        }
      }
      const a = document.createElement("a")
      a.href = cv.toDataURL("image/png")
      a.download = `frame-${fmtTC(useStudio.getState().playhead).replace(/[:.]/g, "-")}.png`
      a.click()
      toast("frame saved")
    }
  }, [size])

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
      const rate = useUi.getState().shuttle || 1
      const next = st.playhead + dt * rate
      if (next >= duration(st.seq) || next <= 0) {
        st.setPlayhead(next <= 0 ? 0 : 0)
        st.setPlaying(false)
        useUi.getState().setShuttle(0)
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
    const solos = seq.tracks.filter((t) => trackFlags[t.id]?.solo)
    const soloKinds = new Set<string>(solos.map((t) => t.kind))
    const hidden = (t: { id: string; kind: string; muted: boolean }) => t.muted || (soloKinds.has(t.kind) && !solos.some((x) => x.id === t.id))
    for (const track of seq.tracks) {
      if (track.kind !== "visual" || hidden(track)) continue
      for (const clip of track.clips) {
        const src = sources[clip.source]
        if (!src) continue
        const len = src.media === "video" ? Math.min(clip.duration, Math.max(0.1, (src.duration ?? clip.duration) - clip.in)) : clip.duration
        out.push({ track: track.id, clip, len })
      }
    }
    return out
  }, [seq, sources, trackFlags])

  const soloKinds2 = useMemo(() => new Set<string>(seq.tracks.filter((t) => trackFlags[t.id]?.solo).map((t) => t.kind)), [seq, trackFlags])
  const audible = (t: { id: string; kind: string; muted: boolean }) => !t.muted && (!soloKinds2.has(t.kind) || trackFlags[t.id]?.solo)
  const audios = useMemo(() => {
    const out: AudioClip[] = []
    for (const track of seq.tracks) if (track.kind === "audio" && audible(track)) out.push(...track.clips)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, trackFlags])

  const cues = useMemo(() => {
    const out: Cue[] = []
    for (const track of seq.tracks) if (track.kind === "text" && audible(track)) out.push(...track.clips)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, trackFlags])

  const monitorMenu = (): MenuItem[] => {
    const u = useUi.getState()
    return [
      { kind: "sub", label: "Zoom", items: [
        { kind: "item", label: "Fit", checked: u.monitorZoom === 1, run: () => u.setMonitorZoom(1) },
        { kind: "item", label: "50%", checked: u.monitorZoom === 0.5, run: () => u.setMonitorZoom(0.5) },
        { kind: "item", label: "100%", checked: u.monitorZoom === 2, run: () => u.setMonitorZoom(2) },
        { kind: "item", label: "200%", checked: u.monitorZoom === 4, run: () => u.setMonitorZoom(4) },
      ] },
      { kind: "item", label: "Safe margins", checked: u.safeMargins, run: () => u.toggle("safeMargins") },
      { kind: "item", label: "Grid", checked: u.grid, run: () => u.toggle("grid") },
      { kind: "item", label: "Captions preview", checked: u.captionsPreview, run: () => u.toggle("captionsPreview") },
      { kind: "sep" },
      { kind: "item", label: "Snapshot frame (PNG)", run: () => hooks.snapshot() },
    ]
  }

  const active = (at: number, len: number) => t >= at && t < at + len

  return (
    <div className="st-monitor">
      <div
        ref={wrapRef}
        className={`st-stagewrap${tool === "hand" ? " st-stagewrap--hand" : ""}`}
        onPointerDown={(e) => {
          if (tool !== "hand" || e.button !== 0) return
          panRef.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, p: { ...mpan } }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = panRef.current
          if (!d || d.id !== e.pointerId) return
          useUi.getState().setMonitorZoom(mz, { x: d.p.x + (e.clientX - d.x0), y: d.p.y + (e.clientY - d.y0) })
        }}
        onPointerUp={() => (panRef.current = null)}
        {...ctxOnly(monitorMenu)}
      >
      <div
        ref={stageRef}
        className="st-stage"
        style={{ aspectRatio: `${ratio}`, background: `#${seq.canvas.background}`, transform: mz !== 1 || mpan.x || mpan.y ? `translate(${mpan.x}px, ${mpan.y}px) scale(${mz})` : undefined }}
        onClick={() => {
          // empty monitor: a click deselects and toggles playback, like a player
          if (useStudio.getState().primary) select(null)
          else setPlaying(!useStudio.getState().playing)
        }}
      >
        {grid && <div className="st-overlay st-overlay--grid" aria-hidden="true" />}
        {safe && <div className="st-overlay st-overlay--safe" aria-hidden="true"><div className="st-overlay__action" /><div className="st-overlay__title" /></div>}
        {guides.v.map((x) => <div key={`v${x}`} className="st-guide st-guide--v" style={{ left: `${x * 100}%` }} />)}
        {guides.h.map((y) => <div key={`h${y}`} className="st-guide st-guide--h" style={{ top: `${y * 100}%` }} />)}
        {layers.map(({ clip, len }) =>
          active(clip.at, len) ? <VisualLayer key={clip.id} clip={clip} len={len} src={sources[clip.source]!} t={t} size={size} playing={playing} selected={primary === clip.id} onGuides={setGuides} /> : null,
        )}
        {audios.map((a) => (active(a.at, a.out - a.in) ? <AudioLayer key={a.id} clip={a} src={sources[a.source]} t={t} playing={playing} /> : null))}
        {captionsPreview && cues.map((c) => (active(c.at, c.duration) ? <CueLayer key={c.id} cue={c} size={size} selected={primary === c.id} /> : null))}
        {layers.length === 0 && cues.length === 0 && <div className="st-stage__empty">drop media on the timeline, or hit “+ add” in the bin</div>}
      </div>
      </div>
      <div className="st-monitor__bar">
        <button type="button" className="st-play" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setPlaying(!useStudio.getState().playing) }} aria-label={playing ? "pause" : "play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="st-tc mono">
          <span className="st-tc__now">{fmtTC(t)}</span> <span className="st-tc__sep">/</span> {fmtTC(D)}
        </span>
        <input className="st-scrub" type="range" min={0} max={Math.max(0.001, D)} step={0.001} value={clamp(t, 0, D)} onChange={(e) => setPlayhead(Number(e.target.value))} aria-label="playhead" />
        {mz !== 1 && <button className="st-tl__hb" onClick={() => useUi.getState().setMonitorZoom(1)} title="zoom to fit">{Math.round(mz * 50)}%</button>}
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

function VisualLayer({ clip, len, src, t, size, playing, selected, onGuides }: { clip: VisualClip; len: number; src: SourceDto; t: number; size: { w: number; h: number }; playing: boolean; selected: boolean; onGuides: (g: { v: number[]; h: number[] }) => void }) {
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
  const tr = clip.transform
  const lk = clip.look
  const filter = lk
    ? [
        lk.brightness ? `brightness(${1 + lk.brightness})` : "",
        lk.contrast !== 1 ? `contrast(${lk.contrast})` : "",
        lk.saturation !== 1 ? `saturate(${lk.saturation})` : "",
        lk.grayscale ? "grayscale(1)" : "",
        lk.blur ? `blur(${(lk.blur * size.w) / 1920}px)` : "",
      ].filter(Boolean).join(" ") || undefined
    : undefined
  const placed = placedRect(clip, size, aspect)
  // the transform is about the placed rect's centre; the layer's own box may be the whole stage (fit/fill)
  const originX = placed.cx - (tr?.x ?? 0) * size.w - (box.left as number)
  const originY = placed.cy - (tr?.y ?? 0) * size.h - (box.top as number)
  const transform = tr && (tr.x || tr.y || tr.scale !== 1 || tr.rotate) ? `translate(${tr.x * size.w}px, ${tr.y * size.h}px) rotate(${tr.rotate}deg) scale(${tr.scale})` : undefined
  return (
    <>
      <div
        className={`st-layer${selected ? " st-layer--sel" : ""}`}
        style={{ ...box, opacity, filter, transform, transformOrigin: `${isFinite(originX) ? originX : 0}px ${isFinite(originY) ? originY : 0}px` }}
        onClick={(e) => {
          e.stopPropagation()
          useStudio.getState().select(clip.id)
        }}
      >
        <EditedMedia source={src} edit={clip.edit ?? null} boxW={boxW} boxH={boxH} fit={clip.fit === "cover" ? "cover" : "contain"}>
          {media}
        </EditedMedia>
        {lk?.vignette ? <div className="st-vignette" style={{ opacity: lk.vignette }} /> : null}
      </div>
      {selected && <Gizmo clip={clip} size={size} aspect={aspect} onGuides={onGuides} />}
    </>
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

function FreeBoxHandles({ clip, size, aspect, onGuides }: { clip: VisualClip; size: { w: number; h: number }; aspect: number; onGuides: (g: { v: number[]; h: number[] }) => void }) {
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
    let box = d.kind === "move" ? { x: clamp(d.box.x + dx, -0.9, 0.95), y: clamp(d.box.y + dy, -0.9, 0.95), w: d.box.w } : { ...d.box, w: clamp(d.box.w + dx, 0.05, 2) }
    // smart guides: snap the box's edges and centre to the canvas edges and centre
    if (d.kind === "move" && useStudio.getState().snap) {
      const h = (box.w * (size.w / size.h)) / aspect
      const tol = 0.012
      const v: number[] = []
      const hh: number[] = []
      const candX: Array<[number, number]> = [[box.x, 0], [box.x + box.w, 1], [box.x + box.w / 2, 0.5]]
      for (const [edge, target] of candX) if (Math.abs(edge - target) < tol) { box = { ...box, x: box.x + (target - edge) }; v.push(target); break }
      const candY: Array<[number, number]> = [[box.y, 0], [box.y + h, 1], [box.y + h / 2, 0.5]]
      for (const [edge, target] of candY) if (Math.abs(edge - target) < tol) { box = { ...box, y: box.y + (target - edge) }; hh.push(target); break }
      onGuides({ v, h: hh })
    }
    useStudio.getState().mutate((seq) => {
      for (const t of seq.tracks)
        if (t.kind === "visual")
          for (const c of t.clips) if (c.id === clip.id) c.box = box
    })
  }
  const up = () => {
    drag.current = null
    onGuides({ v: [], h: [] })
  }
  return (
    <>
      <div className="st-layer__move" onPointerDown={start("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="st-layer__grip" onPointerDown={start("size")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="resize" />
    </>
  )
}
