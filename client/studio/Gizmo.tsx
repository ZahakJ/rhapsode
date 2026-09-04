import { useRef, useState, type CSSProperties } from "react"
import type { Transform, VisualClip } from "../../shared/sequence.ts"
import { clamp, round3 } from "../util/time.ts"
import { useStudio } from "./studioStore.ts"

/**
 * The transform gizmo: the selected clip's box on the monitor, wherever fit /
 * fill / free put it, moved by dragging inside, scaled from eight handles
 * (aspect locked — the schema has one scale), rotated from the handle above
 * the top edge. Snaps to the canvas centre and edges; double-click resets.
 */

export const NEUTRAL_T: Transform = { x: 0, y: 0, scale: 1, rotate: 0 }

export type PlacedRect = { cx: number; cy: number; w: number; h: number; rot: number }

/** where a clip sits on a stage of `size`, before and after its transform */
export function placedRect(clip: VisualClip, size: { w: number; h: number }, aspect: number): PlacedRect {
  let rect: { x: number; y: number; w: number; h: number }
  if (clip.fit === "free" && clip.box) {
    const w = size.w * clip.box.w
    rect = { x: size.w * clip.box.x, y: size.h * clip.box.y, w, h: w / aspect }
  } else if (clip.fit === "cover") {
    rect = { x: 0, y: 0, w: size.w, h: size.h }
  } else {
    const stageAspect = size.w / size.h
    const w = stageAspect > aspect ? size.h * aspect : size.w
    const h = stageAspect > aspect ? size.h : size.w / aspect
    rect = { x: (size.w - w) / 2, y: (size.h - h) / 2, w, h }
  }
  const t = clip.transform ?? NEUTRAL_T
  return { cx: rect.x + rect.w / 2 + t.x * size.w, cy: rect.y + rect.h / 2 + t.y * size.h, w: rect.w * t.scale, h: rect.h * t.scale, rot: t.rotate }
}

export function isNeutralTransform(t: Transform | undefined | null): boolean {
  return !t || (Math.abs(t.x) < 1e-6 && Math.abs(t.y) < 1e-6 && Math.abs(t.scale - 1) < 1e-6 && Math.abs(t.rotate) < 1e-6)
}

type Drag = { id: number; kind: "move" | "scale" | "rotate"; x0: number; y0: number; t0: Transform; rect0: PlacedRect; d0: number; a0: number; alt: boolean }

export function Gizmo({ clip, size, aspect, onGuides }: { clip: VisualClip; size: { w: number; h: number }; aspect: number; onGuides: (g: { v: number[]; h: number[] }) => void }) {
  const drag = useRef<Drag | null>(null)
  const [readout, setReadout] = useState<string | null>(null)
  const r = placedRect(clip, size, aspect)
  if (!size.w || !size.h) return null

  const setT = (t: Transform) =>
    useStudio.getState().mutate((seq) => {
      for (const tr of seq.tracks)
        if (tr.kind === "visual")
          for (const c of tr.clips) if (c.id === clip.id) c.transform = t
    })

  const start = (kind: Drag["kind"]) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useStudio.getState().snapshot()
    const t0 = { ...(clip.transform ?? NEUTRAL_T) }
    const rect0 = placedRect({ ...clip, transform: t0 }, size, aspect)
    const stage = (e.currentTarget as HTMLElement).closest(".st-stage") as HTMLElement
    const sr = stage.getBoundingClientRect()
    const px = (e.clientX - sr.left) * (size.w / sr.width)
    const py = (e.clientY - sr.top) * (size.h / sr.height)
    drag.current = { id: e.pointerId, kind, x0: px, y0: py, t0, rect0, d0: Math.max(1, Math.hypot(px - rect0.cx, py - rect0.cy)), a0: Math.atan2(py - rect0.cy, px - rect0.cx), alt: e.altKey }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const stage = (e.currentTarget as HTMLElement).closest(".st-stage") as HTMLElement
    const sr = stage.getBoundingClientRect()
    const px = (e.clientX - sr.left) * (size.w / sr.width)
    const py = (e.clientY - sr.top) * (size.h / sr.height)
    let t = { ...d.t0 }
    const guides = { v: [] as number[], h: [] as number[] }
    if (d.kind === "move") {
      t.x = d.t0.x + (px - d.x0) / size.w
      t.y = d.t0.y + (py - d.y0) / size.h
      if (useStudio.getState().snap && !e.altKey) {
        // snap the box's centre and edges to the canvas centre and edges
        const halfW = d.rect0.w / 2 / size.w
        const halfH = d.rect0.h / 2 / size.h
        const cx = (d.rect0.cx - d.t0.x * size.w) / size.w + t.x
        const cy = (d.rect0.cy - d.t0.y * size.h) / size.h + t.y
        const tol = 0.012
        for (const [edge, target] of [[cx, 0.5], [cx - halfW, 0], [cx + halfW, 1]] as Array<[number, number]>) if (Math.abs(edge - target) < tol) { t.x += target - edge; guides.v.push(target); break }
        for (const [edge, target] of [[cy, 0.5], [cy - halfH, 0], [cy + halfH, 1]] as Array<[number, number]>) if (Math.abs(edge - target) < tol) { t.y += target - edge; guides.h.push(target); break }
      }
      t.x = clamp(round3(t.x), -2, 2)
      t.y = clamp(round3(t.y), -2, 2)
      setReadout(`x ${Math.round(t.x * 100)}%  y ${Math.round(t.y * 100)}%`)
    } else if (d.kind === "scale") {
      const dist = Math.hypot(px - d.rect0.cx, py - d.rect0.cy)
      t.scale = clamp(round3(d.t0.scale * (dist / d.d0)), 0.05, 8)
      setReadout(`scale ${Math.round(t.scale * 100)}%`)
    } else {
      const a = Math.atan2(py - d.rect0.cy, px - d.rect0.cx)
      let deg = d.t0.rotate + ((a - d.a0) * 180) / Math.PI
      deg = ((deg + 180) % 360 + 360) % 360 - 180
      if (!e.altKey) {
        const near = Math.round(deg / 90) * 90
        if (Math.abs(deg - near) < 3) deg = near
      }
      t.rotate = round3(deg)
      setReadout(`${Math.round(t.rotate)}°`)
    }
    onGuides(guides)
    setT(t)
  }
  const up = (e: React.PointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return
    drag.current = null
    setReadout(null)
    onGuides({ v: [], h: [] })
  }
  const reset = (e: React.MouseEvent) => {
    e.stopPropagation()
    useStudio.getState().patchClip(clip.id, { transform: undefined })
  }

  const style: CSSProperties = { left: r.cx - r.w / 2, top: r.cy - r.h / 2, width: r.w, height: r.h, transform: `rotate(${r.rot}deg)` }
  const handles: Array<{ k: string; x: number; y: number }> = [
    { k: "nw", x: 0, y: 0 }, { k: "n", x: 0.5, y: 0 }, { k: "ne", x: 1, y: 0 },
    { k: "e", x: 1, y: 0.5 }, { k: "se", x: 1, y: 1 }, { k: "s", x: 0.5, y: 1 },
    { k: "sw", x: 0, y: 1 }, { k: "w", x: 0, y: 0.5 },
  ]
  return (
    <div className="st-gizmo" style={style} onPointerDown={start("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={reset} onClick={(e) => e.stopPropagation()} title="drag to move · handles scale · knob rotates · double-click resets">
      {handles.map((h) => (
        <span key={h.k} className={`st-gizmo__h st-gizmo__h--${h.k}`} style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%` }} onPointerDown={start("scale")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      ))}
      <span className="st-gizmo__stem" />
      <span className="st-gizmo__rot" onPointerDown={start("rotate")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} title="rotate (⌥ for free angles)" />
      {readout && <span className="st-gizmo__readout mono">{readout}</span>}
    </div>
  )
}
