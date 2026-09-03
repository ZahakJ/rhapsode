import { useEffect, useRef, useState } from "react"
import { editedDims, type Crop, type Edit, type SourceDto } from "../../shared/recipe.ts"
import { Portal } from "../components/Portal.tsx"
import { useCompose } from "../store/composeStore.ts"
import { clamp } from "../util/time.ts"

const MIN = 0.05
type Preset = "free" | "1:1" | "4:5" | "9:16" | "16:9"
const PRESETS: { v: Preset; a: number | null }[] = [
  { v: "free", a: null },
  { v: "1:1", a: 1 },
  { v: "4:5", a: 4 / 5 },
  { v: "9:16", a: 9 / 16 },
  { v: "16:9", a: 16 / 9 },
]
const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 }

/**
 * Crop / rotate / mirror one source. The rectangle lives in fractions of the
 * source's display frame (what ffmpeg sees after autorotate); rotation and
 * the mirror are applied after the crop, exactly like the render does.
 */
export function CropPanel({ source, edit, onClose, onDone }: { source: SourceDto; edit: Edit | null; onClose: () => void; onDone: (e: Edit | null) => void }) {
  const [crop, setCrop] = useState<Crop>(edit?.crop ?? FULL)
  const [rotate, setRotate] = useState<Edit["rotate"]>(edit?.rotate ?? 0)
  const [flipH, setFlipH] = useState<boolean>(edit?.flipH ?? false)
  const [preset, setPreset] = useState<Preset>("free")
  const frameRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; kind: "move" | "nw" | "ne" | "sw" | "se"; x0: number; y0: number; c: Crop } | null>(null)
  const srcW = source.width || 16
  const srcH = source.height || 9
  const baseIn = useCompose((s) => (s.base?.id === source.id ? s.baseIn : s.ovIn))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const rot90 = rotate === 90 || rotate === 270
  /** target pixel aspect of the crop in the source frame, given the preset and rotation */
  const lockedAspect = (): number | null => {
    const p = PRESETS.find((x) => x.v === preset)?.a ?? null
    if (p === null) return null
    return rot90 ? 1 / p : p
  }
  /** h (fraction) that gives pixel aspect A for width fraction w */
  const hFor = (w: number, A: number) => (w * srcW) / (srcH * A)

  const applyPreset = (p: Preset) => {
    setPreset(p)
    const a = PRESETS.find((x) => x.v === p)?.a ?? null
    if (a === null) return
    const A = rot90 ? 1 / a : a
    // the largest centered rectangle of that aspect
    let w = 1
    let h = hFor(1, A)
    if (h > 1) {
      h = 1
      w = (srcH * A) / srcW
    }
    setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h })
  }

  const frac = (e: React.PointerEvent) => {
    const r = frameRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  const down = (kind: NonNullable<typeof drag.current>["kind"]) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    drag.current = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, c: { ...crop } }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId || !frameRef.current) return
    const r = frameRef.current.getBoundingClientRect()
    const dx = (e.clientX - d.x0) / r.width
    const dy = (e.clientY - d.y0) / r.height
    const A = lockedAspect()
    let { x, y, w, h } = d.c
    if (d.kind === "move") {
      x = clamp(d.c.x + dx, 0, 1 - w)
      y = clamp(d.c.y + dy, 0, 1 - h)
    } else {
      const right = d.kind === "ne" || d.kind === "se"
      const bottom = d.kind === "sw" || d.kind === "se"
      // the anchored corner stays put
      const ax = right ? d.c.x : d.c.x + d.c.w
      const ay = bottom ? d.c.y : d.c.y + d.c.h
      let nw = right ? clamp(d.c.w + dx, MIN, 1 - ax) : clamp(d.c.w - dx, MIN, ax)
      let nh = bottom ? clamp(d.c.h + dy, MIN, 1 - ay) : clamp(d.c.h - dy, MIN, ay)
      if (A !== null) {
        nh = hFor(nw, A)
        const maxH = bottom ? 1 - ay : ay
        if (nh > maxH) {
          nh = maxH
          nw = (nh * srcH * A) / srcW
        }
        if (nh < MIN) {
          nh = MIN
          nw = (nh * srcH * A) / srcW
        }
      }
      w = nw
      h = nh
      x = right ? ax : ax - w
      y = bottom ? ay : ay - h
    }
    setCrop({ x, y, w, h })
  }
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null
  }

  const reset = () => {
    setCrop(FULL)
    setRotate(0)
    setFlipH(false)
    setPreset("free")
  }
  const done = () => {
    const isFull = crop.x < 0.0005 && crop.y < 0.0005 && crop.w > 0.9995 && crop.h > 0.9995
    if (isFull && rotate === 0 && !flipH) onDone(null)
    else onDone({ crop: isFull ? undefined : roundCrop(crop), rotate, flipH })
  }

  const out = editedDims({ width: srcW, height: srcH }, { crop, rotate, flipH })
  const pct = (n: number) => `${n * 100}%`
  const pos = (e: React.PointerEvent) => {
    void frac(e)
  }
  void pos

  return (
    <Portal>
      <div className="mm-scrim rh-crop__scrim" onClick={onClose}>
        <div className="rh-crop" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="crop and rotate">
          <div className="rh-crop__head">
            <span className="rh-crop__title">{source.title || "source"}</span>
            <span className="rh-crop__dims mono">
              {Math.round(crop.w * srcW)}×{Math.round(crop.h * srcH)} → {out.width}×{out.height}
            </span>
          </div>

          <div className="rh-crop__stage">
            <div ref={frameRef} className="rh-crop__frame" style={{ aspectRatio: `${srcW} / ${srcH}` }}>
              {source.media === "image" ? (
                <img src={source.proxyUrl ?? source.thumbUrl ?? ""} alt="" draggable={false} />
              ) : (
                <video
                  src={source.proxyUrl ?? undefined}
                  muted
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(e) => {
                    e.currentTarget.currentTime = baseIn
                  }}
                />
              )}
              <div
                className="rh-crop__rect"
                style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }}
                onPointerDown={down("move")}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
              >
                <span className="rh-crop__third rh-crop__third--v1" />
                <span className="rh-crop__third rh-crop__third--v2" />
                <span className="rh-crop__third rh-crop__third--h1" />
                <span className="rh-crop__third rh-crop__third--h2" />
                {(["nw", "ne", "sw", "se"] as const).map((k) => (
                  <span key={k} className={`rh-crop__grip rh-crop__grip--${k}`} onPointerDown={down(k)} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
                ))}
              </div>
            </div>
          </div>

          <div className="rh-crop__tools">
            <div className="ms-seg rh-crop__presets">
              {PRESETS.map((p) => (
                <button key={p.v} className={`ms-seg__opt${preset === p.v ? " ms-seg__opt--active" : ""}`} onClick={() => applyPreset(p.v)}>
                  {p.v}
                </button>
              ))}
            </div>
            <div className="rh-row">
              <button className="ms-btn" onClick={() => setRotate(((rotate + 90) % 360) as Edit["rotate"])} title="rotate a quarter turn">
                ↻ {rotate ? `${rotate}°` : "rotate"}
              </button>
              <button className={`ms-btn${flipH ? " ms-btn--active" : ""}`} onClick={() => setFlipH((f) => !f)} title="mirror left-right">
                ↔ flip
              </button>
              <div className="rh-grow" />
              <button className="ms-btn ms-btn--ghost" onClick={reset}>
                reset
              </button>
              <button className="ms-btn ms-btn--ghost" onClick={onClose}>
                cancel
              </button>
              <button className="ms-btn ms-btn--primary" onClick={done}>
                done
              </button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  )
}

function roundCrop(c: Crop): Crop {
  const r = (n: number) => Math.round(n * 1000) / 1000
  return { x: r(c.x), y: r(c.y), w: r(c.w), h: r(c.h) }
}
