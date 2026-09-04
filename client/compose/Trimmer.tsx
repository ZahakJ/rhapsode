import { useCallback, useEffect, useRef, useState } from "react"
import type { SourceDto } from "../../shared/recipe.ts"
import { OUT_MAX_SECONDS } from "../../shared/recipe.ts"
import { clamp, fmtClock, fmtTC, fmtTime, isTyping, parseClock, round3 } from "../util/time.ts"

const MIN_SPAN = 0.2

/**
 * Pick [in, out] on one video source with the precision of a cutting room:
 * a millisecond playhead readout, typed in/out points, draggable handles and
 * playhead, nudge transport, and a keyboard map while the trimmer has focus.
 * The video element is the proxy, so what you see is what the render cuts.
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
  const fps = source.fps && source.fps > 0 ? source.fps : 30
  const videoRef = useRef<HTMLMediaElement>(null)
  const isAudio = source.media === "audio"
  const barRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [loop, setLoop] = useState(true)
  const [head, setHead] = useState(inT)
  const [focused, setFocused] = useState(false)
  const dragRef = useRef<{ which: "in" | "out" | "head"; id: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  // refs so the rAF loop and key handlers never see stale bounds
  const bounds = useRef({ inT, outT, loop })
  bounds.current = { inT, outT, loop }

  // ——— playhead clock: rAF while playing, so the readout is smooth ———
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const tick = () => {
      const { inT: a, outT: b, loop: lp } = bounds.current
      setHead(v.currentTime)
      if (!v.paused && v.currentTime >= b - 0.01) {
        if (lp) {
          v.currentTime = a
        } else {
          v.pause()
          v.currentTime = b
        }
      }
      if (!v.paused) rafRef.current = requestAnimationFrame(tick)
    }
    const onPlay = () => {
      setPlaying(true)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(tick)
    }
    const onPause = () => {
      setPlaying(false)
      setHead(v.currentTime)
    }
    const onSeeked = () => setHead(v.currentTime)
    v.addEventListener("play", onPlay)
    v.addEventListener("pause", onPause)
    v.addEventListener("seeked", onSeeked)
    return () => {
      v.removeEventListener("play", onPlay)
      v.removeEventListener("pause", onPause)
      v.removeEventListener("seeked", onSeeked)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current
      const tt = clamp(round3(t), 0, duration)
      if (v) v.currentTime = tt
      setHead(tt)
    },
    [duration],
  )

  const setIn = useCallback(
    (t: number, moveHead = true) => {
      const nin = clamp(round3(t), 0, Math.max(0, outT - MIN_SPAN))
      onChange(nin, outT)
      if (moveHead) seek(nin)
    },
    [outT, onChange, seek],
  )
  const setOut = useCallback(
    (t: number, moveHead = true) => {
      const nout = clamp(round3(t), Math.min(duration, inT + MIN_SPAN), duration)
      onChange(inT, nout)
      if (moveHead) seek(nout)
    },
    [inT, duration, onChange, seek],
  )

  // Typed times and "set here" mean it: an in past the out pushes the out
  // along (keeping the span), and vice versa. Dragged handles still cannot
  // cross each other — that is what a handle is for.
  const placeIn = useCallback(
    (t: number, moveHead = true) => {
      const nin = clamp(round3(t), 0, Math.max(0, duration - MIN_SPAN))
      const span = outT - inT
      const nout = nin > outT - MIN_SPAN ? clamp(round3(nin + Math.max(MIN_SPAN, span)), nin + MIN_SPAN, duration) : outT
      onChange(nin, nout)
      if (moveHead) seek(nin)
    },
    [inT, outT, duration, onChange, seek],
  )
  const placeOut = useCallback(
    (t: number, moveHead = true) => {
      const nout = clamp(round3(t), MIN_SPAN, duration)
      const span = outT - inT
      const nin = nout < inT + MIN_SPAN ? clamp(round3(nout - Math.max(MIN_SPAN, span)), 0, nout - MIN_SPAN) : inT
      onChange(nin, nout)
      if (moveHead) seek(nout)
    },
    [inT, outT, duration, onChange, seek],
  )

  const play = () => {
    const v = videoRef.current
    if (!v) return
    if (v.currentTime < inT || v.currentTime >= outT - 0.01) v.currentTime = inT
    void v.play().catch(() => {})
  }
  const toggle = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) play()
    else v.pause()
  }
  const nudge = (dt: number) => {
    const v = videoRef.current
    if (!v) return
    seek(v.currentTime + dt)
  }

  // ——— pointer: handles, and scrubbing on the bar ———
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
    wrapRef.current?.focus({ preventScroll: true })
  }
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const t = fracAt(e.clientX) * duration
    if (d.which === "in") setIn(t)
    else if (d.which === "out") setOut(t)
    else seek(t)
  }
  const onHandleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null
  }
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // the bar scrubs the playhead; handles stop propagation before this fires
    e.preventDefault()
    dragRef.current = { which: "head", id: e.pointerId }
    e.currentTarget.setPointerCapture(e.pointerId)
    videoRef.current?.pause()
    seek(fracAt(e.clientX) * duration)
    wrapRef.current?.focus({ preventScroll: true })
  }

  // ——— keyboard, only while the trimmer has focus ———
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isTyping(e.target)) return
    const frame = 1 / fps
    const step = e.shiftKey ? 1 : e.altKey ? frame : 0.1
    switch (e.key) {
      case " ":
        e.preventDefault()
        toggle()
        break
      case "ArrowLeft":
        e.preventDefault()
        nudge(-step)
        break
      case "ArrowRight":
        e.preventDefault()
        nudge(step)
        break
      case "i":
      case "I":
        e.preventDefault()
        placeIn(head, false)
        break
      case "o":
      case "O":
        e.preventDefault()
        placeOut(head, false)
        break
      case "Home":
        e.preventDefault()
        seek(inT)
        break
      case "End":
        e.preventDefault()
        seek(outT)
        break
      case "l":
      case "L":
        e.preventDefault()
        setLoop((x) => !x)
        break
      default:
        return
    }
  }

  const span = outT - inT
  const tooLong = span > OUT_MAX_SECONDS
  const pct = (t: number) => (duration ? (t / duration) * 100 : 0)

  return (
    <div
      ref={wrapRef}
      className={`rh-trim${focused ? " rh-trim--focus" : ""}`}
      tabIndex={0}
      onKeyDown={onKey}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
      onPointerDown={() => wrapRef.current?.focus({ preventScroll: true })}
      aria-label={`${label}: trim`}
    >
      <div className="rh-trim__head">
        <span className="rh-trim__label">{label}</span>
        <span className={`rh-trim__span mono${tooLong ? " rh-trim__span--bad" : ""}`}>
          {fmtTime(span)} s{tooLong ? ` · max ${OUT_MAX_SECONDS}` : ""}
        </span>
      </div>

      <div className={`rh-trim__video${isAudio ? " rh-trim__video--audio" : ""}`}>
        {isAudio ? (
          <>
            <img className="rh-trim__wave" src={source.thumbUrl ?? ""} alt="" draggable={false} onClick={toggle} />
            <audio ref={videoRef as React.RefObject<HTMLAudioElement>} src={source.proxyUrl ?? undefined} preload="metadata" onLoadedMetadata={() => seek(inT)} />
          </>
        ) : (
          <video
            ref={videoRef as React.RefObject<HTMLVideoElement>}
            src={source.proxyUrl ?? undefined}
            playsInline
            preload="metadata"
            onClick={toggle}
            onLoadedMetadata={() => seek(inT)}
          />
        )}
        <button
          className={`rh-trim__play${playing ? " rh-trim__play--on" : ""}`}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
          aria-label={playing ? "pause" : "play the selection"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
      </div>

      <div className="rh-trim__times">
        <TimeField label="in" value={inT} onCommit={(t) => placeIn(t)} />
        <div className="rh-trim__tc" aria-live="off">
          <span className="rh-trim__tclabel">playhead</span>
          <span className="rh-trim__tcval mono">{fmtTC(head)}</span>
        </div>
        <TimeField label="out" value={outT} onCommit={(t) => placeOut(t)} align="right" />
      </div>

      <div className="rh-trim__bar" ref={barRef} onPointerDown={onBarDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}>
        <div className="rh-trim__dim" style={{ left: 0, width: `${pct(inT)}%` }} />
        <div className="rh-trim__sel" style={{ left: `${pct(inT)}%`, width: `${pct(outT) - pct(inT)}%` }} />
        <div className="rh-trim__dim" style={{ left: `${pct(outT)}%`, right: 0 }} />
        <div className="rh-trim__playhead" style={{ left: `${pct(head)}%` }}>
          <span className="rh-trim__playhead-cap" />
        </div>
        <div
          className="rh-trim__handle rh-trim__handle--in"
          style={{ left: `${pct(inT)}%` }}
          role="slider"
          aria-label="in point"
          aria-valuenow={inT}
          aria-valuemin={0}
          aria-valuemax={duration}
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
          aria-valuemin={0}
          aria-valuemax={duration}
          onPointerDown={onHandleDown("out")}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
        />
      </div>

      <div className="rh-trim__transport">
        <div className="rh-trim__tgroup">
          <button className="rh-tbtn mono" onClick={() => nudge(-1)} title="back 1 s (shift+←)">
            ‹1s
          </button>
          <button className="rh-tbtn mono" onClick={() => nudge(-0.1)} title="back 0.1 s (←)">
            ‹.1
          </button>
          <button className={`rh-tbtn rh-tbtn--play${playing ? " rh-tbtn--on" : ""}`} onClick={toggle} title="play / pause (space)">
            {playing ? "❚❚" : "▶"}
          </button>
          <button className="rh-tbtn mono" onClick={() => nudge(0.1)} title="forward 0.1 s (→)">
            .1›
          </button>
          <button className="rh-tbtn mono" onClick={() => nudge(1)} title="forward 1 s (shift+→)">
            1s›
          </button>
        </div>
        <div className="rh-trim__tgroup">
          <button className="rh-tbtn rh-tbtn--set" onClick={() => placeIn(head, false)} title="set in at the playhead (I)">
            <span className="mono">[</span> set in
          </button>
          <button className="rh-tbtn rh-tbtn--set" onClick={() => placeOut(head, false)} title="set out at the playhead (O)">
            set out <span className="mono">]</span>
          </button>
          <button className={`rh-tbtn${loop ? " rh-tbtn--on" : ""}`} onClick={() => setLoop((x) => !x)} title="loop the selection (L)">
            loop
          </button>
        </div>
      </div>

      <div className="rh-trim__foot">
        <span className="rh-trim__total mono">{fmtClock(duration)} total</span>
        <span className="rh-trim__keys mono">space · ← → · shift=1s · alt=frame · I O · L</span>
      </div>
      {source.windowStart !== null && source.windowEnd !== null && (
        <p className="rh-hint rh-trim__hint">
          this file covers {fmtClock(source.windowStart)}–{fmtClock(source.windowEnd)} of the original
        </p>
      )}
      {hint && <p className="rh-hint rh-trim__hint">{hint}</p>}
    </div>
  )
}

/** A typed timecode: shows m:ss.mmm, accepts ss / m:ss / m:ss.s / h:mm:ss on Enter or blur. */
function TimeField({
  label,
  value,
  onCommit,
  align = "left",
}: {
  label: string
  value: number
  onCommit: (t: number) => void
  align?: "left" | "right"
}) {
  const [text, setText] = useState<string | null>(null)
  const shown = text ?? fmtTC(value)
  const commit = () => {
    if (text === null) return
    const t = parseClock(text)
    if (Number.isFinite(t)) onCommit(t)
    setText(null)
  }
  return (
    <label className={`rh-tf rh-tf--${align}`}>
      <span className="rh-tf__label">{label}</span>
      <input
        className="rh-tf__input mono"
        value={shown}
        inputMode="decimal"
        spellCheck={false}
        onFocus={(e) => {
          setText(fmtTC(value))
          e.currentTarget.select()
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit()
            e.currentTarget.blur()
          } else if (e.key === "Escape") {
            setText(null)
            e.currentTarget.blur()
          }
          e.stopPropagation()
        }}
        aria-label={`${label} point`}
      />
    </label>
  )
}
