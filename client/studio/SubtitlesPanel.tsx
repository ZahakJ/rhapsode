import { useEffect, useRef, useState } from "react"
import { cueSchema, formatSrt, parseSrt, type Cue, type Track } from "../../shared/sequence.ts"
import { toast } from "../components/Toasts.tsx"
import { round3 } from "../util/time.ts"
import { TimeField } from "./fields.tsx"
import { nid, useStudio } from "./studioStore.ts"

/**
 * The subtitle table for one text track: every cue as a row with typed
 * times, the line and its translation. SRT in (a second file fills the
 * translation column by time), SRT out for either column.
 */
export function SubtitlesPanel() {
  const seq = useStudio((s) => s.seq)
  const selectedTrack = useStudio((s) => s.selectedTrack)
  const selectTrack = useStudio((s) => s.selectTrack)
  const primary = useStudio((s) => s.primary)
  const select = useStudio((s) => s.select)
  const setPlayhead = useStudio((s) => s.setPlayhead)
  const playhead = useStudio((s) => s.playhead)
  const addCue = useStudio((s) => s.addCue)
  const patch = useStudio((s) => s.patchClip)
  const removeClips = useStudio((s) => s.removeClips)
  const addTrack = useStudio((s) => s.addTrack)
  const edit = useStudio((s) => s.edit)
  const fileRef = useRef<HTMLInputElement>(null)
  const subFileRef = useRef<HTMLInputElement>(null)
  const [busyImport, setBusyImport] = useState<"text" | "sub" | null>(null)

  const textTracks = seq.tracks.filter((t): t is Extract<Track, { kind: "text" }> => t.kind === "text")
  const track = textTracks.find((t) => t.id === selectedTrack) ?? textTracks[0]

  if (!track) {
    return (
      <div className="st-subs">
        <div className="ms-empty">
          <div className="ms-empty__title">no text track yet</div>
          <button className="ms-btn ms-btn--primary st-addtrack--text" onClick={() => addTrack("text")}>+ text track</button>
        </div>
      </div>
    )
  }
  const cues = track.clips.slice().sort((a, b) => a.at - b.at)

  const importSrt = async (file: File, which: "text" | "sub") => {
    setBusyImport(which)
    try {
      const parsed = parseSrt(await file.text())
      if (!parsed.length) {
        toast("no cues found in that file", "warn")
        return
      }
      edit((s) => {
        const t = s.tracks.find((x) => x.id === track.id)
        if (!t || t.kind !== "text") return
        if (which === "text") {
          for (const c of parsed) t.clips.push(cueSchema.parse({ id: nid(), at: round3(c.from), duration: round3(Math.max(0.1, c.to - c.from)), text: c.text }))
        } else {
          // by index when the counts match, else by time overlap
          const sorted = t.clips.slice().sort((a, b) => a.at - b.at)
          if (sorted.length === parsed.length) sorted.forEach((c, i) => (c.sub = parsed[i]!.text))
          else
            for (const c of sorted) {
              const hit = parsed.find((p) => p.from < c.at + c.duration && p.to > c.at)
              if (hit) c.sub = hit.text
            }
        }
      })
      toast(`imported ${parsed.length} ${which === "text" ? "cues" : "translations"}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not read that file", "danger")
    } finally {
      setBusyImport(null)
    }
  }

  const download = (name: string, body: string) => {
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }))
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  const autoSpace = () => {
    if (cues.length < 2) return
    edit((s) => {
      const t = s.tracks.find((x) => x.id === track.id)
      if (!t || t.kind !== "text") return
      const sorted = t.clips.slice().sort((a, b) => a.at - b.at)
      const first = sorted[0]!.at
      const last = sorted.at(-1)!
      const span = last.at + last.duration - first
      const each = span / sorted.length
      sorted.forEach((c, i) => {
        c.at = round3(first + i * each)
        c.duration = round3(Math.max(0.3, each - 0.1))
      })
    })
  }

  return (
    <div className="st-subs" onKeyDown={(e) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) {
        addCue({ trackId: track.id, at: playhead })
        e.preventDefault()
      }
    }} tabIndex={0}>
      <div className="st-subs__head">
        {textTracks.length > 1 ? (
          <select className="st-subs__track" value={track.id} onChange={(e) => selectTrack(e.target.value)}>
            {textTracks.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        ) : (
          <span className="st-section__title">{track.name}</span>
        )}
        <span className="mono st-bin__count">{cues.length}</span>
        <span className="st-tl__spacer" />
        <button className="ms-btn ms-btn--small st-subs__add" onClick={() => addCue({ trackId: track.id, at: playhead })}>+ cue at playhead</button>
        <button className="ms-btn ms-btn--small" onClick={autoSpace} disabled={cues.length < 2} title="spread the cues evenly over their span">auto-space</button>
        <label className="ms-btn ms-btn--small">
          <input ref={fileRef} type="file" accept=".srt,.vtt,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importSrt(f, "text"); if (fileRef.current) fileRef.current.value = "" }} />
          {busyImport === "text" ? "…" : "import .srt"}
        </label>
        <label className="ms-btn ms-btn--small" title="fills the second line of existing cues">
          <input ref={subFileRef} type="file" accept=".srt,.vtt,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importSrt(f, "sub"); if (subFileRef.current) subFileRef.current.value = "" }} />
          {busyImport === "sub" ? "…" : "import translation .srt"}
        </label>
        <button className="ms-btn ms-btn--small ms-btn--ghost" disabled={!cues.length} onClick={() => download(`${track.name}.srt`, formatSrt(cues.map((c) => ({ from: c.at, to: c.at + c.duration, text: c.text }))))}>export .srt</button>
        <button className="ms-btn ms-btn--small ms-btn--ghost" disabled={!cues.some((c) => c.sub)} onClick={() => download(`${track.name}.translation.srt`, formatSrt(cues.filter((c) => c.sub).map((c) => ({ from: c.at, to: c.at + c.duration, text: c.sub! }))))}>export translation</button>
      </div>
      {cues.length === 0 ? (
        <p className="rh-hint st-subs__empty">no cues yet — add one at the playhead, or import an .srt. Enter adds a cue while this table has focus.</p>
      ) : (
        <div className="st-subs__list">
          {cues.map((c: Cue, i: number) => (
            <div key={c.id} className={`st-cuecard${primary === c.id ? " st-cuecard--sel" : ""}`} onClick={() => { select(c.id); setPlayhead(c.at) }}>
              <div className="st-cuecard__row">
                <span className="st-cuecard__n mono">{i + 1}</span>
                <label className="st-cuecard__time"><span className="st-field__label">in</span><TimeField value={c.at} onCommit={(t) => patch(c.id, { at: t })} compact /></label>
                <label className="st-cuecard__time"><span className="st-field__label">length</span><TimeField value={c.duration} onCommit={(t) => patch(c.id, { duration: Math.max(0.1, t) })} compact min={0.1} /></label>
                <span className="st-tl__spacer" />
                <button className="st-tl__hb st-tl__hb--danger" onClick={(e) => { e.stopPropagation(); removeClips([c.id]) }} title="delete cue">✕</button>
              </div>
              <AutoTextarea className="st-subs__text st-subs__text-main" value={c.text} placeholder="the line" onChange={(v) => patch(c.id, { text: v })} />
              <AutoTextarea className="st-subs__text st-subs__sub" value={c.sub ?? ""} placeholder="second line — translation…" onChange={(v) => patch(c.id, { sub: v || undefined })} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A textarea that grows with its content (two rows minimum). */
function AutoTextarea({ value, onChange, className, placeholder }: { value: string; onChange: (v: string) => void; className: string; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "0px"
    el.style.height = `${Math.max(40, el.scrollHeight)}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      className={className}
      rows={2}
      dir="auto"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
