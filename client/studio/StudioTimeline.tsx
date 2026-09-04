import { useEffect, useMemo, useRef, useState } from "react"
import type { AudioClip, Cue, Track, VisualClip } from "../../shared/sequence.ts"
import { toast } from "../components/Toasts.tsx"
import { clamp, fmtTime, round3 } from "../util/time.ts"
import { clipLength, contentEnd, duration, useStudio, type AnyClip } from "./studioStore.ts"

/**
 * The multitrack timeline. Rows are tracks (top row = topmost visual track),
 * blocks are clips. Drag a block to move it (across tracks of the same
 * kind), drag its edges to trim, click the ruler to seek, ⌘/ctrl + wheel to
 * zoom. Snapping pulls edges to other edges and the playhead.
 */

const HEADER_W = 176
const ROW_H: Record<Track["kind"], number> = { visual: 60, audio: 44, text: 38 }
const SNAP_PX = 8

type Drag =
  | { kind: "move"; id: string; ids: string[]; x0: number; y0: number; starts: Record<string, number>; trackId: string; pointer: number }
  | { kind: "trim"; id: string; edge: "l" | "r"; x0: number; clip: AnyClip; track: Track; pointer: number }
  | { kind: "scrub"; pointer: number }

export function StudioTimeline() {
  const seq = useStudio((s) => s.seq)
  const sources = useStudio((s) => s.sources)
  const zoom = useStudio((s) => s.zoom)
  const setZoom = useStudio((s) => s.setZoom)
  const playhead = useStudio((s) => s.playhead)
  const setPlayhead = useStudio((s) => s.setPlayhead)
  const selected = useStudio((s) => s.selected)
  const select = useStudio((s) => s.select)
  const selectedTrack = useStudio((s) => s.selectedTrack)
  const selectTrack = useStudio((s) => s.selectTrack)
  const snap = useStudio((s) => s.snap)
  const setSnap = useStudio((s) => s.setSnap)
  const addTrack = useStudio((s) => s.addTrack)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)

  const D = duration(seq)
  const end = Math.max(D, contentEnd(seq))
  const width = Math.max(600, (end + 8) * zoom)
  const rows = useMemo(() => seq.tracks.slice().reverse(), [seq.tracks])

  // ⌘/ctrl + wheel zooms around the cursor
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const st = useStudio.getState()
      const rect = el.getBoundingClientRect()
      const tAtCursor = (el.scrollLeft + e.clientX - rect.left - HEADER_W) / st.zoom
      const z = clamp(st.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 6, 600)
      st.setZoom(z)
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, tAtCursor * z - (e.clientX - rect.left - HEADER_W))
      })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  const xOf = (t: number) => t * zoom
  const tOf = (clientX: number) => {
    const el = scrollRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.max(0, (el.scrollLeft + clientX - rect.left - HEADER_W) / zoom)
  }

  /** snap candidates: every other clip edge, the playhead, zero */
  const snapTo = (t: number, exclude: string[]): number => {
    if (!snap) return t
    const pts = [0, playhead]
    for (const tr of seq.tracks) for (const c of tr.clips as AnyClip[]) if (!exclude.includes(c.id)) pts.push(c.at, c.at + clipLength(tr, c))
    let best = t
    let bestD = SNAP_PX / zoom
    for (const p of pts) {
      const d = Math.abs(p - t)
      if (d < bestD) {
        best = p
        bestD = d
      }
    }
    return best
  }

  // ——— drags ———
  const onClipDown = (e: React.PointerEvent, track: Track, clip: AnyClip) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const target = e.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const edge = e.clientX - rect.left < 8 ? "l" : rect.right - e.clientX < 8 ? "r" : null
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    const st = useStudio.getState()
    if (!st.selected.includes(clip.id) || additive) select(clip.id, additive)
    selectTrack(track.id)
    st.snapshot()
    target.setPointerCapture(e.pointerId)
    if (edge && rect.width > 24) {
      setDrag({ kind: "trim", id: clip.id, edge, x0: e.clientX, clip: JSON.parse(JSON.stringify(clip)) as AnyClip, track, pointer: e.pointerId })
    } else {
      const ids = useStudio.getState().selected.includes(clip.id) ? useStudio.getState().selected : [clip.id]
      const starts: Record<string, number> = {}
      for (const id of ids) {
        for (const tr of seq.tracks) for (const c of tr.clips as AnyClip[]) if (c.id === id) starts[id] = c.at
      }
      setDrag({ kind: "move", id: clip.id, ids, x0: e.clientX, y0: e.clientY, starts, trackId: track.id, pointer: e.pointerId })
    }
  }

  const onMove = (e: React.PointerEvent) => {
    if (!drag || drag.pointer !== e.pointerId) return
    const st = useStudio.getState()
    if (drag.kind === "scrub") {
      setPlayhead(tOf(e.clientX))
      return
    }
    const dx = (e.clientX - drag.x0) / zoom
    if (drag.kind === "move") {
      const base = drag.starts[drag.id] ?? 0
      let at = Math.max(0, base + dx)
      const f = findLen(st.seq, drag.id)
      if (f) {
        const snappedStart = snapTo(at, drag.ids)
        const snappedEnd = snapTo(at + f.len, drag.ids) - f.len
        at = Math.abs(snappedStart - at) <= Math.abs(snappedEnd - at) ? snappedStart : Math.max(0, snappedEnd)
      }
      const delta = at - base
      // which track is under the pointer?
      const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => (el as HTMLElement).dataset?.track) as HTMLElement | undefined
      const targetTrack = under?.dataset.track
      const targetKind = under?.dataset.kind
      const single = drag.ids.length === 1
      st.mutate((seq) => {
        for (const id of drag.ids) {
          const s0 = drag.starts[id] ?? 0
          for (const tr of seq.tracks) {
            const i = (tr.clips as AnyClip[]).findIndex((c) => c.id === id)
            if (i === -1) continue
            const c = (tr.clips as AnyClip[])[i]!
            c.at = round3(Math.max(0, s0 + delta))
            if (single && targetTrack && targetTrack !== tr.id && targetKind === tr.kind) {
              const dest = seq.tracks.find((t) => t.id === targetTrack)
              if (dest) {
                ;(tr.clips as AnyClip[]).splice(i, 1)
                ;(dest.clips as AnyClip[]).push(c)
              }
            }
            break
          }
        }
      })
      return
    }
    // trim
    const o = drag.clip
    const src = "source" in o ? sources[(o as VisualClip).source] : undefined
    st.mutate((seq) => {
      const tr = seq.tracks.find((t) => t.id === drag.track.id)
      const c = tr ? (tr.clips as AnyClip[]).find((x) => x.id === drag.id) : undefined
      if (!tr || !c) return
      if (tr.kind === "audio") {
        const a = c as AudioClip
        const oa = o as AudioClip
        const max = src?.duration ?? oa.out
        if (drag.edge === "l") {
          const nAt = snapTo(clamp(oa.at + dx, Math.max(0, oa.at - oa.in), oa.at + (oa.out - oa.in) - 0.1), [a.id])
          const d = nAt - oa.at
          a.at = round3(nAt)
          a.in = round3(oa.in + d)
        } else {
          const nEnd = snapTo(clamp(oa.at + (oa.out - oa.in) + dx, oa.at + 0.1, oa.at + (max - oa.in)), [a.id])
          a.out = round3(oa.in + (nEnd - oa.at))
        }
      } else if (tr.kind === "visual") {
        const v = c as VisualClip
        const ov = o as VisualClip
        const isVideo = src?.media === "video"
        const srcLen = isVideo ? (src?.duration ?? ov.in + ov.duration) : Infinity
        if (drag.edge === "l") {
          const minAt = isVideo ? ov.at - ov.in : 0
          const nAt = snapTo(clamp(ov.at + dx, Math.max(0, minAt), ov.at + ov.duration - 0.1), [v.id])
          const d = nAt - ov.at
          v.at = round3(nAt)
          v.duration = round3(ov.duration - d)
          if (isVideo) v.in = round3(ov.in + d)
        } else {
          const maxEnd = ov.at + Math.min(isVideo ? srcLen - ov.in : 600, 600)
          const nEnd = snapTo(clamp(ov.at + ov.duration + dx, ov.at + 0.1, maxEnd), [v.id])
          v.duration = round3(nEnd - ov.at)
        }
      } else {
        const q = c as Cue
        const oq = o as Cue
        if (drag.edge === "l") {
          const nAt = snapTo(clamp(oq.at + dx, 0, oq.at + oq.duration - 0.1), [q.id])
          q.at = round3(nAt)
          q.duration = round3(oq.duration - (nAt - oq.at))
        } else {
          const nEnd = snapTo(clamp(oq.at + oq.duration + dx, oq.at + 0.1, 600), [q.id])
          q.duration = round3(nEnd - oq.at)
        }
      }
    })
  }

  const onUp = (e: React.PointerEvent) => {
    if (drag && drag.pointer === e.pointerId) setDrag(null)
  }

  // drop a bin source onto a track row
  const onRowDrop = (e: React.DragEvent, track: Track) => {
    const id = e.dataTransfer.getData("application/x-rhapsode-source")
    if (!id) return
    e.preventDefault()
    const src = sources[id]
    if (!src) return
    const at = tOf(e.clientX)
    const isSound = src.media === "audio"
    if (isSound && track.kind === "visual") toast("a sound goes on an audio track — placed it there", "warn")
    const made = useStudio.getState().addClipFromSource(src, { at, trackId: isSound && track.kind === "visual" ? undefined : track.id })
    if (!made) toast("that source does not fit on this track", "warn")
  }

  const ticks = useMemo(() => {
    const step = niceStep(zoom)
    const out: number[] = []
    for (let t = 0; t <= end + 8; t += step) out.push(round3(t))
    return out
  }, [zoom, end])

  return (
    <div className="st-tl">
      <div className="st-tl__tools">
        <button className="ms-btn ms-btn--small" onClick={() => addTrack("visual")}>+ video track</button>
        <button className="ms-btn ms-btn--small" onClick={() => addTrack("audio")}>+ audio track</button>
        <button className="ms-btn ms-btn--small st-addtrack--text" onClick={() => addTrack("text")}>+ text track</button>
        <span className="st-tl__spacer" />
        <label className={`st-toggle${snap ? " st-toggle--on" : ""}`}>
          <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> snap
        </label>
        <label className="st-zoom">
          <span className="rh-hint">zoom</span>
          <input type="range" min={6} max={400} step={1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
      </div>
      <div ref={scrollRef} className="st-tl__scroll" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="st-tl__inner" style={{ width: width + HEADER_W }}>
          {/* ruler */}
          <div className="st-ruler-row">
            <div className="st-tl__head st-tl__head--ruler mono">{fmtTime(D, false)}</div>
            <div
              className="st-ruler"
              style={{ width }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                setPlayhead(tOf(e.clientX))
                setDrag({ kind: "scrub", pointer: e.pointerId })
              }}
            >
              {ticks.map((t) => (
                <span key={t} className="st-ruler__tick" style={{ left: xOf(t) }}>
                  <span className="mono">{fmtTime(t, false)}</span>
                </span>
              ))}
              <span className="st-ruler__end" style={{ left: xOf(D) }} title="sequence end" />
            </div>
          </div>
          {/* tracks */}
          {rows.map((track) => (
            <div key={track.id} className={`st-row st-row--${track.kind}${selectedTrack === track.id ? " st-row--sel" : ""}`} style={{ height: ROW_H[track.kind] }}>
              <TrackHead track={track} />
              <div
                className="st-row__lane"
                data-track={track.id}
                data-kind={track.kind}
                style={{ width }}
                onClick={() => {
                  selectTrack(track.id)
                  select(null)
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("application/x-rhapsode-source")) e.preventDefault()
                }}
                onDrop={(e) => onRowDrop(e, track)}
              >
                {(track.clips as AnyClip[]).map((clip) => {
                  const len = clipLength(track, clip)
                  const src = "source" in clip ? sources[(clip as VisualClip).source] : undefined
                  const label = track.kind === "text" ? (clip as Cue).text : src?.title || "clip"
                  const isSel = selected.includes(clip.id)
                  return (
                    <div
                      key={clip.id}
                      className={`st-clip st-clip--${track.kind}${isSel ? " st-clip--sel" : ""}`}
                      style={{ left: xOf(clip.at), width: Math.max(6, xOf(len)) }}
                      onPointerDown={(e) => onClipDown(e, track, clip)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        setPlayhead(clip.at)
                      }}
                      title={`${label} · ${fmtTime(clip.at)} → ${fmtTime(clip.at + len)}`}
                    >
                      {track.kind === "visual" && src?.thumbUrl && <img className="st-clip__thumb" src={src.thumbUrl} alt="" draggable={false} />}
                      {track.kind === "audio" && <span className="st-clip__wave" aria-hidden="true" />}
                      <span className="st-clip__name">{label}</span>
                      <span className="st-clip__dur mono">{fmtTime(len)}</span>
                      <span className="st-clip__edge st-clip__edge--l" />
                      <span className="st-clip__edge st-clip__edge--r" />
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {/* playhead */}
          <div className="st-playhead" style={{ left: HEADER_W + xOf(playhead) }} />
        </div>
      </div>
    </div>
  )
}

function TrackHead({ track }: { track: Track }) {
  const patchTrack = useStudio((s) => s.patchTrack)
  const removeTrack = useStudio((s) => s.removeTrack)
  const moveTrack = useStudio((s) => s.moveTrack)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(track.name)
  useEffect(() => setName(track.name), [track.name])
  const glyph = track.kind === "visual" ? "▣" : track.kind === "audio" ? "♪" : "T"
  return (
    <div className="st-tl__head">
      <span className="st-tl__glyph mono" title={track.kind}>{glyph}</span>
      {editing ? (
        <input
          className="st-tl__name-input"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            setEditing(false)
            if (name.trim() && name !== track.name) patchTrack(track.id, { name: name.trim().slice(0, 40) })
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur()
          }}
        />
      ) : (
        <button className="st-tl__name" onDoubleClick={() => setEditing(true)} title="double-click to rename">
          {track.name}
        </button>
      )}
      <span className="st-tl__headbtns">
        <button className={`st-tl__hb${track.muted ? " st-tl__hb--on" : ""}`} onClick={() => patchTrack(track.id, { muted: !track.muted })} title={track.muted ? "unmute" : "mute"}>M</button>
        <button className="st-tl__hb" onClick={() => moveTrack(track.id, 1)} title="move up (toward the top)">↑</button>
        <button className="st-tl__hb" onClick={() => moveTrack(track.id, -1)} title="move down">↓</button>
        <button className="st-tl__hb st-tl__hb--danger" onClick={() => removeTrack(track.id)} title="delete track">✕</button>
      </span>
    </div>
  )
}

function findLen(seq: { tracks: Track[] }, id: string): { len: number } | null {
  for (const tr of seq.tracks) for (const c of tr.clips as AnyClip[]) if (c.id === id) return { len: clipLength(tr, c) }
  return null
}

function niceStep(zoom: number): number {
  const target = 90 / zoom // seconds per ~90px
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  return steps.find((s) => s >= target) ?? 600
}
