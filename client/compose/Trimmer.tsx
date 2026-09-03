import { useEffect, useRef, useState } from "react"
import type { SourceDto } from "../../shared/recipe.ts"
import { OUT_MAX_SECONDS } from "../../shared/recipe.ts"
import { clamp, fmtClock, fmtTime, round1 } from "../util/time.ts"

const MIN_SPAN = 0.2

/**
 * Pick [in, out] on one video source: a scrub bar with two fat handles, ±0.1 s
 * nudges, and a play button that loops the selection. The video element is
 * the proxy, so what you see is what the render cuts.
 */
export function Trimmer({
  source,
  inT,
  outT,
  onChange,
  label,
  hint,
}: {
  source: SourceDto
  inT: number
  outT: number
  onChange: (inT: number, outT: number) => void
  label: string
  hint?: string
}) {
  const duration = source.duration ?? 0
  const videoRef = useRef<HTMLVideoElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [head, setHead] = useState(inT)
  const dragRef = useRef<{ which: "in" | "out"; id: number } | null>(null)

  // loop the selection while playing
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => {
      setHead(v.currentTime)
      if (v.currentTime >= outT - 0.02 || v.currentTime < inT - 0.5) {
        v.currentTime = inT
        if (v.paused && playing) void v.play().catch(() => {})
      }
    }
    v.addEventListener("timeupdate", onTime)
    return () => v.removeEventListener("timeupdate", onTime)
  }, [inT, outT, playing])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPause = () => setPlaying(false)
    const onPlay = () => setPlaying(true)
    v.addEventListener("pause", onPause)
    v.addEventListener("play", onPlay)
    return () => {
      v.removeEventListener("pause", onPause)
      v.removeEventListener("play", onPlay)
    }
  }, [])

  const seek = (t: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = clamp(t, 0, duration)
    setHead(v.currentTime)
  }

  const setIn = (t: number) => {
    const nin = clamp(round1(t), 0, Math.max(0, outT - MIN_SPAN))
    onChange(nin, outT)
    seek(nin)
  }
  const setOut = (t: number) => {
    const nout = clamp(round1(t), Math.min(duration, inT + MIN_SPAN), duration)
    onChange(inT, nout)
    seek(Math.max(inT, nout - 0.5))
  }

  const toggle = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      if (v.currentTime < inT || v.currentTime >= outT) v.currentTime = inT
      void v.play().catch(() => {})
    } else v.pause()
  }

  const fracAt = (clientX: number): number => {
    const el = barRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width, 0, 1)
  }

  const onHandleDown = (which: "in" | "out") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { which, id: e.pointerId }
    e.currentTarget.setPointerCapture(e.pointerId)
    videoRef.current?.pause()
  }
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const t = fracAt(e.clientX) * duration
    if (d.which === "in") setIn(t)
    else setOut(t)
  }
  const onHandleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null
  }
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // tapping the bar scrubs the playhead without moving a handle
    seek(fracAt(e.clientX) * duration)
  }

  const span = outT - inT
  const tooLong = span > OUT_MAX_SECONDS
  const pct = (t: number) => (duration ? (t / duration) * 100 : 0)

  return (
    <div className="rh-trim">
      <div className="rh-trim__head">
        <span className="rh-trim__label">{label}</span>
        <span className={`rh-trim__span mono${tooLong ? " rh-trim__span--bad" : ""}`}>
          {fmtTime(span)} s{tooLong ? ` · max ${OUT_MAX_SECONDS}` : ""}
        </span>
      </div>
      <div className="rh-trim__video">
        <video
          ref={videoRef}
          src={source.proxyUrl ?? undefined}
          playsInline
          preload="metadata"
          onClick={toggle}
          onLoadedMetadata={() => seek(inT)}
        />
        <button className={`rh-trim__play${playing ? " rh-trim__play--on" : ""}`} onClick={toggle} aria-label={playing ? "pause" : "play the selection"}>
          {playing ? "❚❚" : "▶"}
        </button>
      </div>
      <div className="rh-trim__bar" ref={barRef} onPointerDown={onBarDown}>
        <div className="rh-trim__dim" style={{ left: 0, width: `${pct(inT)}%` }} />
        <div className="rh-trim__sel" style={{ left: `${pct(inT)}%`, width: `${pct(outT) - pct(inT)}%` }} />
        <div className="rh-trim__dim" style={{ left: `${pct(outT)}%`, right: 0 }} />
        <div className="rh-trim__head-line" style={{ left: `${pct(head)}%` }} />
        <div
          className="rh-trim__handle rh-trim__handle--in"
          style={{ left: `${pct(inT)}%` }}
          role="slider"
          aria-label="in point"
          aria-valuenow={inT}
          onPointerDown={onHandleDown("in")}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
        />
        <div
          className="rh-trim__handle rh-trim__handle--out"
          style={{ left: `${pct(outT)}%` }}
          role="slider"
          aria-label="out point"
          aria-valuenow={outT}
          onPointerDown={onHandleDown("out")}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
        />
      </div>
      <div className="rh-trim__times">
        <div className="rh-trim__tgroup">
          <button className="ms-btn ms-btn--icon" onClick={() => setIn(inT - 0.1)} aria-label="in point earlier">−</button>
          <button className="rh-trim__stamp mono" onClick={() => setIn(head)} title="set in to the playhead">
            in {fmtTime(inT)}
          </button>
          <button className="ms-btn ms-btn--icon" onClick={() => setIn(inT + 0.1)} aria-label="in point later">+</button>
        </div>
        <span className="rh-trim__total mono">{fmtClock(duration)}</span>
        <div className="rh-trim__tgroup">
          <button className="ms-btn ms-btn--icon" onClick={() => setOut(outT - 0.1)} aria-label="out point earlier">−</button>
          <button className="rh-trim__stamp mono" onClick={() => setOut(head)} title="set out to the playhead">
            out {fmtTime(outT)}
          </button>
          <button className="ms-btn ms-btn--icon" onClick={() => setOut(outT + 0.1)} aria-label="out point later">+</button>
        </div>
      </div>
      {hint && <p className="rh-hint rh-trim__hint">{hint}</p>}
      {source.windowStart !== null && source.windowEnd !== null && (
        <p className="rh-hint rh-trim__hint">
          this file covers {fmtClock(source.windowStart)}–{fmtClock(source.windowEnd)} of the original
        </p>
      )}
    </div>
  )
}
