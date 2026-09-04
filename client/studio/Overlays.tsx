import { useEffect, useState } from "react"
import { Portal } from "../components/Portal.tsx"
import { toast } from "../components/Toasts.tsx"
import { fmtTC, parseClock } from "../util/time.ts"
import { CHEAT_GROUPS, COMMANDS, bindingOf, loadKeymap, prettyChord } from "./commands.ts"
import { useStudio } from "./studioStore.ts"
import { useUi } from "./uiStore.ts"

/** `?` — a searchable cheat-sheet grouped like the menus. */
export function ShortcutsOverlay() {
  const open = useUi((s) => s.shortcutsOpen)
  const close = () => useUi.getState().setShortcutsOpen(false)
  const [q, setQ] = useState("")
  useEffect(() => {
    if (open) setQ("")
  }, [open])
  if (!open) return null
  const keymap = loadKeymap()
  const needle = q.trim().toLowerCase()
  return (
    <Portal>
      <div className="st-scrim" onClick={close}>
        <div className="st-sheet st-sheet--wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="keyboard shortcuts">
          <div className="st-sheet__head">
            <span className="st-section__title">keyboard shortcuts</span>
            <div className="ms-search st-sheet__search">
              <input autoFocus placeholder="search…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close() }} />
            </div>
            <button className="ms-btn ms-btn--ghost ms-btn--small" onClick={close}>close</button>
          </div>
          <div className="st-cheat">
            {CHEAT_GROUPS.map((g) => {
              const rows = COMMANDS.filter((c) => c.group === g && (bindingOf(c, keymap) || !c.hidden) && (!needle || c.label.toLowerCase().includes(needle) || prettyChord(bindingOf(c, keymap)).toLowerCase().includes(needle)))
              if (!rows.length) return null
              return (
                <section key={g} className="st-cheat__group">
                  <h4>{g}</h4>
                  {rows.map((c) => (
                    <div key={c.id} className="st-cheat__row">
                      <span>{c.label}</span>
                      <span className="mono st-cheat__keys">{[bindingOf(c, keymap), c.alt].filter(Boolean).map((k) => <kbd key={k}>{prettyChord(k)}</kbd>)}</span>
                    </div>
                  ))}
                </section>
              )
            })}
            <section className="st-cheat__group">
              <h4>Mouse</h4>
              <div className="st-cheat__row"><span>Zoom the timeline</span><span className="mono st-cheat__keys"><kbd>⌘/Ctrl + wheel</kbd></span></div>
              <div className="st-cheat__row"><span>Duplicate while dragging</span><span className="mono st-cheat__keys"><kbd>⌥ + drag</kbd></span></div>
              <div className="st-cheat__row"><span>Add to selection</span><span className="mono st-cheat__keys"><kbd>⇧ click</kbd></span></div>
              <div className="st-cheat__row"><span>Context menu</span><span className="mono st-cheat__keys"><kbd>right-click</kbd><kbd>long-press</kbd></span></div>
              <div className="st-cheat__row"><span>Split with the razor</span><span className="mono st-cheat__keys"><kbd>C</kbd> then click a clip</span></div>
              <div className="st-cheat__row"><span>Pan the timeline / monitor</span><span className="mono st-cheat__keys"><kbd>H</kbd> then drag</span></div>
            </section>
          </div>
          <p className="rh-hint">bindings are stored in <span className="mono">rhapsode:v1:keys</span> — a remapping screen is the next step; the map is already yours to edit.</p>
        </div>
      </div>
    </Portal>
  )
}

/** G — a tiny timecode prompt. */
export function GotoPrompt() {
  const open = useUi((s) => s.gotoOpen)
  const [v, setV] = useState("")
  useEffect(() => {
    if (open) setV(fmtTC(useStudio.getState().playhead))
  }, [open])
  if (!open) return null
  const close = () => useUi.getState().setGotoOpen(false)
  const go = () => {
    const t = parseClock(v)
    if (!Number.isFinite(t)) {
      toast("give a time like 1:23.5", "warn")
      return
    }
    useStudio.getState().setPlayhead(t)
    close()
  }
  return (
    <Portal>
      <div className="st-scrim st-scrim--light" onClick={close}>
        <div className="st-sheet st-sheet--tiny" onClick={(e) => e.stopPropagation()}>
          <span className="st-section__title">go to</span>
          <input className="st-field__input mono st-goto" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") go(); if (e.key === "Escape") close() }} />
          <div className="rh-row"><button className="ms-btn ms-btn--primary ms-btn--small" onClick={go}>go</button><button className="ms-btn ms-btn--ghost ms-btn--small" onClick={close}>cancel</button></div>
        </div>
      </div>
    </Portal>
  )
}

/** A one-field prompt used for marker labels and layout names. */
export function TextPrompt({ title, initial, onDone, onCancel, placeholder }: { title: string; initial?: string; onDone: (v: string) => void; onCancel: () => void; placeholder?: string }) {
  const [v, setV] = useState(initial ?? "")
  return (
    <Portal>
      <div className="st-scrim st-scrim--light" onClick={onCancel}>
        <div className="st-sheet st-sheet--tiny" onClick={(e) => e.stopPropagation()}>
          <span className="st-section__title">{title}</span>
          <input className="st-field__input st-goto" autoFocus placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") onDone(v); if (e.key === "Escape") onCancel() }} />
          <div className="rh-row"><button className="ms-btn ms-btn--primary ms-btn--small" onClick={() => onDone(v)}>ok</button><button className="ms-btn ms-btn--ghost ms-btn--small" onClick={onCancel}>cancel</button></div>
        </div>
      </div>
    </Portal>
  )
}

export function AboutSheet() {
  const open = useUi((s) => s.aboutOpen)
  if (!open) return null
  const close = () => useUi.getState().setAboutOpen(false)
  return (
    <Portal>
      <div className="st-scrim" onClick={close}>
        <div className="st-sheet st-sheet--tiny" onClick={(e) => e.stopPropagation()}>
          <span className="st-section__title">rhapsode · the cutting room</span>
          <p className="rh-hint">ῥαψῳδός — the song-stitcher. A sequence of tracks, one pure recipe→ffmpeg path, links that unfurl. Self-hosted, MIT.</p>
          <p className="rh-hint mono">github.com/ZahakJ/rhapsode</p>
          <button className="ms-btn ms-btn--small" onClick={close}>close</button>
        </div>
      </div>
    </Portal>
  )
}
