import { useState } from "react"
import { fmtTC, fmtTime } from "../util/time.ts"
import { TextPrompt } from "./Overlays.tsx"
import { contentEnd, useStudio, type AnyClip } from "./studioStore.ts"
import { useUi } from "./uiStore.ts"

/** The undo stack as a list: click an older state to jump back to it. */
export function HistoryPanel() {
  const past = useStudio((s) => s.past)
  const future = useStudio((s) => s.future)
  const seq = useStudio((s) => s.seq)
  const undo = useStudio((s) => s.undo)
  const redo = useStudio((s) => s.redo)
  const describe = (a: { tracks: Array<{ clips: unknown[] }> }) => {
    const clips = a.tracks.reduce((n, t) => n + t.clips.length, 0)
    return `${a.tracks.length} tracks · ${clips} clips`
  }
  return (
    <div className="st-history">
      <div className="st-bin__head"><span className="st-section__title">history</span><span className="mono st-bin__count">{past.length + 1}</span></div>
      <ol className="st-history__list">
        {past.map((p, i) => (
          <li key={i}>
            <button className="st-history__item" onClick={() => { for (let k = 0; k < past.length - i; k++) undo() }}>
              <span className="mono">#{i + 1}</span> {describe(p)}
            </button>
          </li>
        ))}
        <li>
          <button className="st-history__item st-history__item--now" disabled>
            <span className="mono">now</span> {describe(seq)} · ends {fmtTime(contentEnd(seq))}
          </button>
        </li>
        {future.map((p, i) => (
          <li key={`f${i}`}>
            <button className="st-history__item st-history__item--future" onClick={() => { for (let k = 0; k <= i; k++) redo() }}>
              <span className="mono">redo {i + 1}</span> {describe(p)}
            </button>
          </li>
        ))}
      </ol>
      <p className="rh-hint">every edit is a step; ⌘Z walks back, ⇧⌘Z forward.</p>
    </div>
  )
}

const MARKER_COLORS = ["7dd3fc", "ff9f43", "ff5c5c", "5cff9d", "d9a7ff", "ffffff"]

/** Markers on the ruler, as a list you can rename, recolour and jump to. */
export function MarkersPanel() {
  const markers = useUi((s) => s.markers)
  const setPlayhead = useStudio((s) => s.setPlayhead)
  const playhead = useStudio((s) => s.playhead)
  const [editing, setEditing] = useState<string | null>(null)
  const ui = useUi.getState
  const target = editing ? markers.find((m) => m.id === editing) : undefined
  return (
    <div className="st-markers">
      <div className="st-bin__head">
        <span className="st-section__title">markers</span>
        <span className="mono st-bin__count">{markers.length}</span>
        <span className="st-tl__spacer" />
        <button className="ms-btn ms-btn--small" onClick={() => setEditing(ui().addMarker(playhead))}>+ marker (M)</button>
      </div>
      {markers.length === 0 && <p className="rh-hint">press M on the timeline to drop a marker at the playhead. Markers are saved with the project file.</p>}
      <ul className="st-markers__list">
        {markers.map((m) => (
          <li key={m.id} className="st-markers__row" onClick={() => setPlayhead(m.at)}>
            <span className="st-markers__dot" style={{ background: `#${m.color}` }} />
            <span className="mono st-markers__at">{fmtTC(m.at)}</span>
            <span className="st-markers__label">{m.label || <em>untitled</em>}</span>
            <span className="st-markers__colors" onClick={(e) => e.stopPropagation()}>
              {MARKER_COLORS.map((c) => (
                <button key={c} className={`st-markers__swatch${m.color === c ? " st-markers__swatch--on" : ""}`} style={{ background: `#${c}` }} onClick={() => ui().updateMarker(m.id, { color: c })} aria-label={`colour ${c}`} />
              ))}
            </span>
            <button className="st-tl__hb" onClick={(e) => { e.stopPropagation(); setEditing(m.id) }} title="rename">✎</button>
            <button className="st-tl__hb st-tl__hb--danger" onClick={(e) => { e.stopPropagation(); ui().removeMarker(m.id) }} title="delete">✕</button>
          </li>
        ))}
      </ul>
      {target && (
        <TextPrompt title={`marker at ${fmtTC(target.at)}`} initial={target.label} placeholder="label" onDone={(v) => { ui().updateMarker(target.id, { label: v }); setEditing(null) }} onCancel={() => setEditing(null)} />
      )}
    </div>
  )
}

export type { AnyClip }
