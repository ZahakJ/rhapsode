import { useEffect, useRef, useState } from "react"
import { useCompose } from "../store/composeStore.ts"
import { usePreview } from "./previewStore.ts"
import { clamp, fmtTC, fmtTime, parseClock, round1 } from "../util/time.ts"

/**
 * The composition timeline: a ruler of the OUTPUT duration, the base track,
 * the clip as a block you drag to choose when it starts (`at`), timed
 * captions on a text track, and the preview playhead. Click the ruler to seek.
 */
export function Timeline() {
  const s = useCompose()
  const clock = usePreview((p) => p.clock)
  const ctl = usePreview((p) => p.ctl)
  const D = s.outputDuration()
  const ovLen = Math.max(0, Math.min(s.ovOut - s.ovIn, D - s.at))
  const areaRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; kind: "clip" | "cap" | "scrub"; i?: number; x0: number; start: number; len: number } | null>(null)
  const [atText, setAtText] = useState<string | null>(null)
  const [areaW, setAreaW] = useState(0)

  // the ruler labels are ~44px of mono; fit as many as the width allows
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setAreaW(el.getBoundingClientRect().width))
    ro.observe(el)
    return () => ro.disconnect()
  })

  if (!s.base || !s.overlay || D <= 0) return null

  const pct = (t: number) => `${clamp((t / D) * 100, 0, 100)}%`
  const fracAt = (clientX: number) => {
    const el = areaRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width, 0, 1)
  }
  const setAt = (t: number) => s.patch({ at: clamp(round1(t), 0, Math.max(0, round1(D - 0.1))) })

  const onClipDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    drag.current = { id: e.pointerId, kind: "clip", x0: e.clientX, start: s.at, len: ovLen }
    e.currentTarget.setPointerCapture(e.pointerId)
    ctl?.pause()
  }
  const onCapDown = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const c = s.captions[i]!
    const from = c.from ?? 0
    const to = c.to ?? D
    drag.current = { id: e.pointerId, kind: "cap", i, x0: e.clientX, start: from, len: to - from }
    e.currentTarget.setPointerCapture(e.pointerId)
    s.patch({ selectedCaption: i })
  }
  const onRulerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    drag.current = { id: e.pointerId, kind: "scrub", x0: e.clientX, start: 0, len: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
    ctl?.seek(fracAt(e.clientX) * D)
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !areaRef.current) return
    const w = areaRef.current.getBoundingClientRect().width
    const dt = ((e.clientX - d.x0) / w) * D
    if (d.kind === "clip") {
      setAt(d.start + dt)
    } else if (d.kind === "cap" && d.i !== undefined) {
      const from = clamp(round1(d.start + dt), 0, Math.max(0, D - d.len))
      const to = round1(from + d.len)
      s.updateCaption(d.i, { from: from <= 0 ? undefined : from, to: to >= D ? undefined : to })
    } else {
      ctl?.seek(fracAt(e.clientX) * D)
    }
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null
  }

  const { ticks, step } = tickTimes(D, Math.max(3, Math.floor((areaW || 600) / 72)))
  const timedCaps = s.captions.map((c, i) => ({ c, i })).filter(({ c }) => c.from !== undefined || c.to !== undefined)
  const commitAt = () => {
    if (atText === null) return
    const t = parseClock(atText)
    if (Number.isFinite(t)) setAt(t)
    setAtText(null)
  }

  return (
    <div className="rh-tl">
      <div className="rh-tl__side">
        <label className="rh-tf rh-tf--left">
          <span className="rh-tf__label">clip starts at</span>
          <input
            className="rh-tf__input mono"
            value={atText ?? fmtTC(s.at)}
            inputMode="decimal"
            spellCheck={false}
            onFocus={(e) => {
              setAtText(fmtTC(s.at))
              e.currentTarget.select()
            }}
            onChange={(e) => setAtText(e.target.value)}
            onBlur={commitAt}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitAt()
                e.currentTarget.blur()
              } else if (e.key === "Escape") {
                setAtText(null)
                e.currentTarget.blur()
              }
              e.stopPropagation()
            }}
          />
        </label>
        <div className="rh-tl__reads mono">
          <span>
            plays <b>{fmtTime(s.at)}</b> → <b>{fmtTime(s.at + ovLen)}</b>
          </span>
          <span>
            of <b>{fmtTime(D)}</b>
          </span>
        </div>
      </div>

      <div className="rh-tl__body">
        <div className="rh-tl__labels">
          <span className="rh-tl__lab rh-tl__lab--ruler" />
          <span className="rh-tl__lab">base</span>
          <span className="rh-tl__lab">clip</span>
          {timedCaps.length > 0 && <span className="rh-tl__lab">text</span>}
        </div>
        <div className="rh-tl__area" ref={areaRef} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="rh-tl__ruler" onPointerDown={onRulerDown}>
            {ticks.map((t, i) => (
              <span
                key={t}
                className={`rh-tl__tick mono${i === 0 ? " rh-tl__tick--first" : ""}${i === ticks.length - 1 && t >= D - 1e-6 ? " rh-tl__tick--last" : ""}`}
                style={{ left: pct(t) }}
              >
                {fmtTime(t, step < 1)}
              </span>
            ))}
          </div>
          <div className="rh-tl__track">
            <div className="rh-tl__block rh-tl__block--base" style={{ left: 0, width: "100%" }}>
              <span>{s.base.title || (s.base.media === "image" ? "photo" : "base")}</span>
            </div>
          </div>
          <div className="rh-tl__track">
            <div
              className="rh-tl__block rh-tl__block--clip"
              style={{ left: pct(s.at), width: pct(ovLen) }}
              onPointerDown={onClipDown}
              role="slider"
              aria-label="clip start"
              aria-valuenow={s.at}
              title="drag to choose when the clip starts"
            >
              <span>{s.overlay.title || "clip"}</span>
            </div>
          </div>
          {timedCaps.length > 0 && (
            <div className="rh-tl__track">
              {timedCaps.map(({ c, i }) => (
                <div
                  key={i}
                  className={`rh-tl__block rh-tl__block--cap${s.selectedCaption === i ? " rh-tl__block--sel" : ""}`}
                  style={{ left: pct(c.from ?? 0), width: pct((c.to ?? D) - (c.from ?? 0)) }}
                  onPointerDown={onCapDown(i)}
                  title="drag to move this caption's window"
                >
                  <span>{c.text}</span>
                </div>
              ))}
            </div>
          )}
          <div className="rh-tl__playhead" style={{ left: pct(clock) }}>
            <span className="rh-tl__playhead-cap" />
          </div>
        </div>
      </div>
    </div>
  )
}

/** ruler ticks at a "nice" interval for the duration */
function tickTimes(D: number, maxTicks: number): { ticks: number[]; step: number } {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60]
  const step = steps.find((st) => D / st <= maxTicks) ?? 60
  const ticks: number[] = []
  for (let t = 0; t <= D + 1e-6; t += step) ticks.push(Math.round(t * 10) / 10)
  // a tick that would sit on top of the end label is dropped for the end itself
  if (ticks.length && D - ticks[ticks.length - 1]! < step * 0.35) ticks.pop()
  ticks.push(Math.round(D * 10) / 10)
  return { ticks, step }
}
