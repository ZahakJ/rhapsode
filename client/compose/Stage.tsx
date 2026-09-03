import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { CANVAS, type Caption } from "../../shared/recipe.ts"
import { useCompose } from "../store/composeStore.ts"
import { clamp } from "../util/time.ts"

/**
 * The preview stage: the output canvas at its aspect, the base underneath,
 * the overlay placed per mode, captions on top — all draggable in fractional
 * coordinates. Two media elements are kept in step by a small clock so the
 * preview plays roughly like the render will. Approximate on purpose.
 */
export function Stage() {
  const s = useCompose()
  const { base, overlay, mode, output, captions, at, ovIn, ovOut, audio } = s
  const stageRef = useRef<HTMLDivElement>(null)
  const baseVideo = useRef<HTMLVideoElement>(null)
  const ovVideo = useRef<HTMLVideoElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [playing, setPlaying] = useState(false)
  const [clock, setClock] = useState(0)
  const rafRef = useRef<number | null>(null)
  const t0Ref = useRef(0)

  const D = s.outputDuration()
  const ovLen = Math.max(0, Math.min(ovOut - ovIn, D - at))

  // canvas aspect
  const canvas = useMemo(() => {
    if (output.aspect !== "source") return CANVAS[output.aspect]
    const w = base?.width ?? 16
    const h = base?.height ?? 9
    return { w, h }
  }, [output.aspect, base?.width, base?.height])

  // measure the stage box
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

  // ——— the clock ———
  // video base: the base <video> is the clock (currentTime - baseIn)
  // image base: a rAF timer from 0..D
  const isVideoBase = base?.media === "video"

  useEffect(() => {
    if (!isVideoBase) return
    const v = baseVideo.current
    if (!v) return
    const onTime = () => {
      const t = v.currentTime - s.baseIn
      setClock(t)
      if (v.currentTime >= s.baseOut - 0.02) {
        v.currentTime = s.baseIn
      }
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    v.addEventListener("timeupdate", onTime)
    v.addEventListener("play", onPlay)
    v.addEventListener("pause", onPause)
    return () => {
      v.removeEventListener("timeupdate", onTime)
      v.removeEventListener("play", onPlay)
      v.removeEventListener("pause", onPause)
    }
  }, [isVideoBase, s.baseIn, s.baseOut])

  useEffect(() => {
    if (isVideoBase || !playing) return
    const tick = () => {
      const t = (performance.now() - t0Ref.current) / 1000
      if (t >= D) {
        t0Ref.current = performance.now()
        setClock(0)
      } else setClock(t)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [isVideoBase, playing, D])

  // ——— keep the overlay video in step ———
  const inWindow = clock >= at && clock < at + ovLen
  useEffect(() => {
    const ov = ovVideo.current
    if (!ov) return
    if (!playing) {
      ov.pause()
      return
    }
    if (inWindow) {
      const want = ovIn + (clock - at)
      if (Math.abs(ov.currentTime - want) > 0.3) ov.currentTime = want
      if (ov.paused) void ov.play().catch(() => {})
    } else {
      if (!ov.paused) ov.pause()
      ov.currentTime = ovIn
    }
  }, [clock, playing, inWindow, ovIn, at])

  // audio per option (duck ≈ base at a quarter during the overlay window)
  useEffect(() => {
    const bv = baseVideo.current
    const ov = ovVideo.current
    if (bv) {
      bv.muted = audio.base === "mute"
      bv.volume = clamp(audio.base === "duck" && inWindow ? 0.25 * audio.baseGain : audio.baseGain, 0, 1)
    }
    if (ov) {
      ov.muted = audio.overlay === "mute"
      ov.volume = clamp(audio.overlayGain, 0, 1)
    }
  }, [audio, inWindow])

  const toggle = () => {
    if (isVideoBase) {
      const v = baseVideo.current
      if (!v) return
      if (v.paused) {
        if (v.currentTime < s.baseIn || v.currentTime >= s.baseOut) v.currentTime = s.baseIn
        void v.play().catch(() => {})
      } else v.pause()
    } else {
      if (playing) {
        setPlaying(false)
      } else {
        t0Ref.current = performance.now()
        setClock(0)
        setPlaying(true)
      }
    }
  }

  // ——— geometry ———
  const fitStyle: CSSProperties = { objectFit: output.fit === "cover" ? "cover" : "contain" }
  const ovAspect = overlay && overlay.width && overlay.height ? overlay.width / overlay.height : 16 / 9
  const canvasAspect = canvas.w / canvas.h

  const pipStyle = (): CSSProperties => {
    if (mode.kind !== "pip") return {}
    const { x, y, w } = mode.box
    const h = (w * canvasAspect) / ovAspect
    return { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }
  }

  // drag the pip box / resize by its corner
  const dragRef = useRef<{ id: number; kind: "move" | "size"; x0: number; y0: number; box: { x: number; y: number; w: number } } | null>(null)
  const onPipDown = (kind: "move" | "size") => (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode.kind !== "pip") return
    e.stopPropagation()
    e.preventDefault()
    dragRef.current = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, box: { ...mode.box } }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPipMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId || mode.kind !== "pip" || !size.w) return
    const dx = (e.clientX - d.x0) / size.w
    const dy = (e.clientY - d.y0) / size.h
    if (d.kind === "move") {
      const h = (d.box.w * canvasAspect) / ovAspect
      const x = clamp(d.box.x + dx, 0, 1 - d.box.w)
      const y = clamp(d.box.y + dy, 0, Math.max(0, 1 - h))
      s.patch({ mode: { kind: "pip", box: { x, y, w: d.box.w } } })
    } else {
      const w = clamp(d.box.w + dx, 0.1, 1 - d.box.x)
      s.patch({ mode: { kind: "pip", box: { x: d.box.x, y: d.box.y, w } } })
    }
  }
  const onPipUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null
  }

  // caption drag
  const capDrag = useRef<{ id: number; i: number; x0: number; y0: number; cx: number; cy: number } | null>(null)
  const onCapDown = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    const c = captions[i]!
    capDrag.current = { id: e.pointerId, i, x0: e.clientX, y0: e.clientY, cx: c.x, cy: c.y }
    e.currentTarget.setPointerCapture(e.pointerId)
    s.patch({ selectedCaption: i })
  }
  const onCapMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = capDrag.current
    if (!d || d.id !== e.pointerId || !size.w) return
    s.updateCaption(d.i, {
      x: clamp(d.cx + (e.clientX - d.x0) / size.w, 0, 1),
      y: clamp(d.cy + (e.clientY - d.y0) / size.h, 0, 1),
    })
  }
  const onCapUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (capDrag.current?.id === e.pointerId) capDrag.current = null
  }

  const capStyle = (c: Caption): CSSProperties => {
    const fs = Math.max(6, c.size * size.h)
    const tx = c.align === "left" ? "0" : c.align === "right" ? "-100%" : "-50%"
    return {
      left: `${c.x * 100}%`,
      top: `${c.y * 100}%`,
      transform: `translate(${tx}, -50%)`,
      fontSize: `${fs}px`,
      WebkitTextStroke: `${Math.max(1, fs / 14)}px #000`,
      textAlign: c.align,
      lineHeight: 1.1,
    }
  }
  const capVisible = (c: Caption) => {
    if (c.from === undefined && c.to === undefined) return true
    return clock >= (c.from ?? 0) && clock <= (c.to ?? 1e9)
  }

  const baseEl = base ? (
    base.media === "video" ? (
      <video
        ref={baseVideo}
        className="rh-stage__media"
        style={fitStyle}
        src={base.proxyUrl ?? undefined}
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => {
          e.currentTarget.currentTime = s.baseIn
        }}
      />
    ) : (
      <img className="rh-stage__media" style={fitStyle} src={base.proxyUrl ?? base.thumbUrl ?? ""} alt="" />
    )
  ) : (
    <div className="rh-stage__empty">pick a base</div>
  )

  const ovEl = overlay ? (
    <video
      ref={ovVideo}
      className="rh-stage__media rh-stage__ov"
      src={overlay.proxyUrl ?? undefined}
      playsInline
      preload="metadata"
      style={{ objectFit: "contain" }}
    />
  ) : null

  let body: React.ReactNode
  if (mode.kind === "stack" && overlay) {
    const vertical = mode.dir === "top" || mode.dir === "bottom"
    const ovFirst = mode.dir === "top" || mode.dir === "left"
    const lanes = [
      <div key="a" className="rh-stage__lane">{baseEl}</div>,
      <div key="b" className={`rh-stage__lane rh-stage__lane--ov${inWindow || !playing ? "" : " rh-stage__lane--dark"}`}>{ovEl}</div>,
    ]
    body = (
      <div className={`rh-stage__stack rh-stage__stack--${vertical ? "v" : "h"}`}>
        {ovFirst ? [lanes[1], lanes[0]] : lanes}
      </div>
    )
  } else {
    body = (
      <>
        {baseEl}
        {mode.kind === "pip" && overlay && (
          <div
            className={`rh-stage__pip${inWindow || !playing ? "" : " rh-stage__pip--hidden"}`}
            style={pipStyle()}
            onPointerDown={onPipDown("move")}
            onPointerMove={onPipMove}
            onPointerUp={onPipUp}
            onPointerCancel={onPipUp}
          >
            {ovEl}
            <div
              className="rh-stage__pipgrip"
              onPointerDown={onPipDown("size")}
              onPointerMove={onPipMove}
              onPointerUp={onPipUp}
              onPointerCancel={onPipUp}
              aria-label="resize"
            />
          </div>
        )}
        {mode.kind === "dub" && overlay && (
          <div className="rh-stage__dubov" aria-hidden="true">
            {ovEl}
          </div>
        )}
      </>
    )
  }

  return (
    <div className="rh-stagewrap">
      <div
        ref={stageRef}
        className="rh-stage"
        style={{ aspectRatio: `${canvas.w} / ${canvas.h}` }}
        onClick={() => s.patch({ selectedCaption: null })}
      >
        {body}
        {captions.map((c, i) => (
          <div
            key={i}
            className={`rh-cap${s.selectedCaption === i ? " rh-cap--sel" : ""}${capVisible(c) ? "" : " rh-cap--off"}`}
            style={capStyle(c)}
            onPointerDown={onCapDown(i)}
            onPointerMove={onCapMove}
            onPointerUp={onCapUp}
            onPointerCancel={onCapUp}
            onClick={(e) => e.stopPropagation()}
          >
            {c.text}
          </div>
        ))}
        {base && (
          <button className={`rh-stage__play${playing ? " rh-stage__play--on" : ""}`} onClick={(e) => { e.stopPropagation(); toggle() }} aria-label={playing ? "pause preview" : "play preview"}>
            {playing ? "❚❚" : "▶"}
          </button>
        )}
      </div>
      <div className="rh-stage__foot">
        <span className="mono">{clock.toFixed(1)} / {D.toFixed(1)} s</span>
        <span className="rh-hint">preview is approximate; the render is truth</span>
      </div>
    </div>
  )
}
