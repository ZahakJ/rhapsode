import { useEffect, useState } from "react"
import type { JobDto, RenderDto } from "../../shared/recipe.ts"
import { api } from "../api/client.ts"
import { watchJob, stageLabel } from "../api/jobs.ts"
import { InviteKeyDialog } from "../components/InviteKeyDialog.tsx"
import { toast } from "../components/Toasts.tsx"
import { navigate } from "../router.ts"
import { useAuth } from "../store/authStore.ts"
import { usePhone } from "../usePhone.ts"
import { isTyping } from "../util/time.ts"
import { Inspector } from "./Inspector.tsx"
import { MediaBin } from "./MediaBin.tsx"
import { Monitor } from "./Monitor.tsx"
import { StudioTimeline } from "./StudioTimeline.tsx"
import { SubtitlesPanel } from "./SubtitlesPanel.tsx"
import { Seg } from "./fields.tsx"
import { contentEnd, duration, findClip, restoreStudioDraft, saveStudioDraft, useStudio, validateSequence, type Panel } from "./studioStore.ts"

type RenderState = { kind: "idle" } | { kind: "queued"; slug: string } | { kind: "job"; job: JobDto; slug: string; progress: number | null; stage: string | null }

/**
 * The studio: media bin · monitor + timeline · inspector. Desktop-first; on a
 * phone the panels stack and fine editing is a desktop thing.
 */
export function StudioView({ slug }: { slug?: string }) {
  const phone = usePhone()
  const verified = useAuth((s) => s.verified)
  const s = useStudio()
  const [render, setRender] = useState<RenderState>({ kind: "idle" })
  const [keyOpen, setKeyOpen] = useState(false)
  const [restored, setRestored] = useState(false)
  const [phoneTab, setPhoneTab] = useState<Panel>("bin")
  const D = duration(s.seq)

  // open a render's sequence, or restore the draft
  useEffect(() => {
    if (slug) {
      if (!verified) return
      api
        .getRecipe(slug)
        .then(({ sequence, title, sources }) => {
          if (!sequence) {
            toast("that render was made in the simple cutter — opening it there", "warn")
            navigate(`#/remix/${encodeURIComponent(slug)}`)
            return
          }
          s.setSequence(sequence, title ?? "", sources)
          toast("sequence loaded — remix away")
          navigate("#/studio")
        })
        .catch((e) => toast(e instanceof Error ? e.message : "could not load that render", "danger"))
      return
    }
    if (restored) return
    setRestored(true)
    if (contentEnd(s.seq) > 0) return
    void restoreStudioDraft().then((ok) => ok && toast("project restored"))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, verified])

  // persist, debounced
  useEffect(() => {
    const t = setTimeout(saveStudioDraft, 400)
    return () => clearTimeout(t)
  }, [s.seq, s.title])

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      const st = useStudio.getState()
      const meta = e.metaKey || e.ctrlKey
      const frame = 1 / st.seq.canvas.fps
      if (e.code === "Space") {
        e.preventDefault()
        st.setPlaying(!st.playing)
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault()
        const step = e.shiftKey ? 1 : e.altKey ? frame : 0.1
        st.setPlayhead(st.playhead + (e.key === "ArrowLeft" ? -step : step))
      } else if (e.key === "Home") {
        e.preventDefault()
        st.setPlayhead(0)
      } else if (e.key === "End") {
        e.preventDefault()
        st.setPlayhead(duration(st.seq))
      } else if (meta && (e.key === "z" || e.key === "Z")) {
        e.preventDefault()
        if (e.shiftKey) st.redo()
        else st.undo()
      } else if (meta && (e.key === "y" || e.key === "Y")) {
        e.preventDefault()
        st.redo()
      } else if (meta && (e.key === "d" || e.key === "D")) {
        e.preventDefault()
        if (st.selected.length) st.duplicateClips(st.selected)
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (st.selected.length) {
          e.preventDefault()
          st.removeClips(st.selected)
        }
      } else if (e.key === "s" || e.key === "S") {
        if (st.primary) {
          e.preventDefault()
          st.splitAt(st.primary, st.playhead)
        }
      } else if (e.key === "Escape") {
        st.select(null)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  const missing = (() => {
    if (contentEnd(s.seq) === 0) return "add a clip to the timeline first"
    const v = validateSequence(s.seq, s.sources)
    return v.ok ? null : v.error
  })()

  const startRender = async () => {
    if (!verified) {
      setKeyOpen(true)
      return
    }
    const v = validateSequence(s.seq, s.sources)
    if (!v.ok) {
      toast(v.error, "warn")
      if (v.clipId) s.select(v.clipId)
      return
    }
    setRender({ kind: "queued", slug: "" })
    try {
      const res = await api.createSequenceRender(v.sequence, s.title.trim() || undefined)
      setRender({ kind: "job", job: res.job, slug: res.slug, progress: null, stage: null })
      watchJob(res.job.id, (ev) => {
        if (ev.type === "progress") setRender((r) => (r.kind === "job" ? { ...r, progress: ev.progress, stage: ev.stage } : r))
        else if (ev.type === "done") {
          const out = ev.result as RenderDto | undefined
          setRender({ kind: "idle" })
          navigate(`#/r/${encodeURIComponent(out?.slug ?? res.slug)}`)
        } else if (ev.type === "failed") {
          toast(ev.error, "danger")
          setRender({ kind: "idle" })
        }
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : "render failed", "danger")
      setRender({ kind: "idle" })
    }
  }

  const renderLabel = render.kind === "idle" ? (verified ? "render" : "render — needs the key") : render.kind === "queued" ? "queued…" : `${stageLabel(render.stage, "render")}${render.progress !== null ? ` ${Math.round(render.progress * 100)}%` : ""}`

  const topbar = (
    <div className="st-top">
      <div className="ms-search st-top__title">
        <input placeholder="project title" value={s.title} maxLength={120} onChange={(e) => s.setTitle(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <Seg value={s.seq.canvas.aspect} onChange={(aspect) => s.setCanvas({ aspect })} options={[{ v: "16:9", l: "16:9" }, { v: "9:16", l: "9:16" }, { v: "1:1", l: "1:1" }, { v: "4:5", l: "4:5" }]} />
      <Seg value={String(s.seq.canvas.fps) as "24" | "25" | "30" | "60"} onChange={(f) => s.setCanvas({ fps: Number(f) as 24 | 25 | 30 | 60 })} options={[{ v: "24", l: "24" }, { v: "25", l: "25" }, { v: "30", l: "30" }, { v: "60", l: "60" }]} />
      <label className="st-color st-color--inline" title="background">
        <input type="color" value={`#${s.seq.canvas.background}`} onChange={(e) => s.setCanvas({ background: e.target.value.slice(1) })} />
      </label>
      <span className="st-top__dur mono" title="sequence length — follows the last clip unless set">
        {Math.round(D * 10) / 10}s
        {s.seq.duration ? (
          <button className="st-tl__hb" onClick={() => s.setDuration(undefined)} title="follow the last clip">auto</button>
        ) : (
          <button className="st-tl__hb" onClick={() => s.setDuration(Math.max(1, Math.round(contentEnd(s.seq))))} title="pin the length">pin</button>
        )}
      </span>
      <span className="st-tl__spacer" />
      <button className="ms-btn ms-btn--small ms-btn--ghost" onClick={() => { if (s.past.length === 0 && contentEnd(s.seq) === 0) return; s.newProject(); toast("new project") }}>new</button>
      <button className="ms-btn ms-btn--small ms-btn--ghost" disabled={!s.past.length} onClick={s.undo} title="undo (⌘Z)">undo</button>
      <button className="ms-btn ms-btn--small ms-btn--ghost" disabled={!s.future.length} onClick={s.redo} title="redo (⇧⌘Z)">redo</button>
      <button
        className={`ms-btn ms-btn--primary rh-renderbtn st-render${render.kind !== "idle" ? " rh-renderbtn--busy" : ""}`}
        disabled={render.kind !== "idle" || (!!missing && verified)}
        title={missing ?? undefined}
        onClick={() => void startRender()}
      >
        {render.kind === "job" && <span className="rh-renderbtn__bar" style={{ width: `${Math.round((render.progress ?? 0) * 100)}%` }} />}
        <span className="rh-renderbtn__label">{renderLabel}</span>
      </button>
    </div>
  )

  const sidePanel = (
    <div className="st-side">
      <div className="st-side__tabs">
        {(["inspector", "subtitles"] as Panel[]).map((p) => (
          <button key={p} className={`st-side__tab${s.panel === p ? " st-side__tab--active" : ""}`} onClick={() => s.setPanel(p)}>{p}</button>
        ))}
      </div>
      <div className="st-side__body">{s.panel === "subtitles" ? <SubtitlesPanel /> : <Inspector />}</div>
    </div>
  )

  if (phone) {
    return (
      <div className="st st--phone">
        {topbar}
        <Monitor />
        <StudioTimeline />
        <div className="st-side__tabs st-side__tabs--phone">
          {(["bin", "inspector", "subtitles"] as Panel[]).map((p) => (
            <button key={p} className={`st-side__tab${phoneTab === p ? " st-side__tab--active" : ""}`} onClick={() => setPhoneTab(p)}>{p === "bin" ? "media" : p}</button>
          ))}
        </div>
        <div className="st-phonepanel">{phoneTab === "bin" ? <MediaBin /> : phoneTab === "subtitles" ? <SubtitlesPanel /> : <Inspector />}</div>
        <p className="rh-hint st-phonehint">the studio is happiest on a desktop — fine edits are easier with a mouse and a keyboard</p>
        {missing && contentEnd(s.seq) > 0 && <p className="rh-hint rh-missing">{missing}</p>}
        {keyOpen && <InviteKeyDialog onClose={() => setKeyOpen(false)} />}
      </div>
    )
  }

  return (
    <div className="st">
      {topbar}
      <div className="st-body">
        <aside className="st-left"><MediaBin /></aside>
        <section className="st-center">
          <Monitor />
          <StudioTimeline />
          {missing && contentEnd(s.seq) > 0 && <p className="rh-hint rh-missing st-missing">{missing}</p>}
        </section>
        <aside className="st-right">{sidePanel}</aside>
      </div>
      {keyOpen && <InviteKeyDialog onClose={() => setKeyOpen(false)} />}
    </div>
  )
}

export { findClip }
