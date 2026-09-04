import { useEffect, useRef, useState } from "react"
import type { JobDto, RenderDto, SourceDto } from "../../shared/recipe.ts"
import { cueSchema, parseSrt, sequenceSchema } from "../../shared/sequence.ts"
import { api } from "../api/client.ts"
import { watchJob, stageLabel } from "../api/jobs.ts"
import { InviteKeyDialog } from "../components/InviteKeyDialog.tsx"
import { toast } from "../components/Toasts.tsx"
import { navigate } from "../router.ts"
import { useAuth } from "../store/authStore.ts"
import { usePhone } from "../usePhone.ts"
import { fmtTC, isTyping, parseClock, round3 } from "../util/time.ts"
import { commandForEvent, hooks } from "./commands.ts"
import { ContextMenuHost } from "./ContextMenu.tsx"
import { Dock, type PanelRenderers } from "./Dock.tsx"
import { Inspector } from "./Inspector.tsx"
import { MediaBin } from "./MediaBin.tsx"
import { MenuBar } from "./MenuBar.tsx"
import { Monitor } from "./Monitor.tsx"
import { AboutSheet, GotoPrompt, ShortcutsOverlay, TextPrompt } from "./Overlays.tsx"
import { HistoryPanel, MarkersPanel } from "./SidePanels.tsx"
import { StudioTimeline } from "./StudioTimeline.tsx"
import { SubtitlesPanel } from "./SubtitlesPanel.tsx"
import { Seg } from "./fields.tsx"
import { contentEnd, duration, nid, restoreStudioDraft, saveStudioDraft, useStudio, validateSequence, type Panel } from "./studioStore.ts"
import { renderTransform, useUi } from "./uiStore.ts"

type RenderState = { kind: "idle" } | { kind: "queued"; slug: string } | { kind: "job"; job: JobDto; slug: string; progress: number | null; stage: string | null }

const PROJECT_VERSION = 1

/**
 * The studio: a menu bar, a docking window system (media · monitor ·
 * timeline · inspector · subtitles · history · markers), one command
 * registry behind menus, context menus and keys. Phones keep a stacked layout.
 */
export function StudioView({ slug }: { slug?: string }) {
  const phone = usePhone()
  const verified = useAuth((s) => s.verified)
  const s = useStudio()
  const ui = useUi()
  const [render, setRender] = useState<RenderState>({ kind: "idle" })
  const [keyOpen, setKeyOpen] = useState(false)
  const [restored, setRestored] = useState(false)
  const [phoneTab, setPhoneTab] = useState<Panel | "history" | "markers">("bin")
  const [prompt, setPrompt] = useState<{ kind: "layout" } | { kind: "marker"; id: string } | null>(null)
  const openRef = useRef<HTMLInputElement>(null)
  const srtRef = useRef<HTMLInputElement>(null)
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

  useEffect(() => {
    const t = setTimeout(saveStudioDraft, 400)
    return () => clearTimeout(t)
  }, [s.seq, s.title])

  // ——— project files ———
  const saveProject = () => {
    const st = useStudio.getState()
    const u = useUi.getState()
    const body = JSON.stringify({ version: PROJECT_VERSION, title: st.title, sequence: st.seq, markers: u.markers, workArea: u.workArea, layout: u.layout, savedAt: new Date().toISOString() }, null, 2)
    const a = document.createElement("a")
    a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }))
    a.download = `rhapsode-${(st.title || "project").replace(/[^\w.-]+/g, "-").toLowerCase()}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    toast("project saved")
  }
  const openProject = async (file: File) => {
    try {
      const j = JSON.parse(await file.text()) as Record<string, unknown>
      const parsed = sequenceSchema.safeParse(j.sequence)
      if (!parsed.success) throw new Error("not a rhapsode project")
      const seq = parsed.data
      const ids = new Set<string>()
      for (const t of seq.tracks) if (t.kind !== "text") for (const c of t.clips as Array<{ source: string }>) ids.add(c.source)
      const resolved = await Promise.all([...ids].map((id) => api.getSource(id).then((x) => (x.status === "ready" ? x : null)).catch(() => null)))
      const live = resolved.filter((x): x is SourceDto => !!x)
      const missing = [...ids].filter((id) => !live.some((x) => x.id === id))
      useStudio.getState().setSequence(seq, typeof j.title === "string" ? j.title : "", live)
      const u = useUi.getState()
      if (Array.isArray(j.markers)) u.setMarkers(j.markers as never)
      u.setWorkArea((j.workArea as { in: number; out: number } | null) ?? null)
      if (j.layout && typeof j.layout === "object" && !phone) u.setLayout(j.layout as never)
      if (missing.length) toast(`${missing.length} source(s) are gone from the server — their clips are flagged in the bin`, "warn")
      else toast("project opened")
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not open that file", "danger")
    }
  }
  const importSrt = async (file: File) => {
    const cues = parseSrt(await file.text())
    if (!cues.length) {
      toast("no cues in that file", "warn")
      return
    }
    useStudio.getState().edit((seq) => {
      let track = seq.tracks.find((t) => t.kind === "text")
      if (!track) {
        track = { id: nid(), kind: "text", name: "text", muted: false, clips: [] }
        seq.tracks.push(track)
      }
      for (const c of cues) track.clips.push(cueSchema.parse({ id: nid(), at: round3(c.from), duration: round3(Math.max(0.1, c.to - c.from)), text: c.text }))
    })
    toast(`imported ${cues.length} cues`)
  }

  // ——— render ———
  const missing = (() => {
    if (contentEnd(s.seq) === 0) return "add a clip to the timeline first"
    const v = validateSequence(renderTransform(s.seq, ui), s.sources)
    return v.ok ? null : v.error
  })()

  const startRender = async () => {
    if (!verified) {
      setKeyOpen(true)
      return
    }
    const st = useStudio.getState()
    const v = validateSequence(renderTransform(st.seq, useUi.getState()), st.sources)
    if (!v.ok) {
      toast(v.error, "warn")
      if (v.clipId) st.select(v.clipId)
      return
    }
    setRender({ kind: "queued", slug: "" })
    try {
      const res = await api.createSequenceRender(v.sequence, st.title.trim() || undefined)
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

  // ——— hooks for the registry + keyboard ———
  useEffect(() => {
    hooks.render = () => void startRender()
    hooks.saveProject = saveProject
    hooks.openProject = () => openRef.current?.click()
    hooks.importSrt = () => srtRef.current?.click()
    hooks.zoomToFit = () => document.dispatchEvent(new CustomEvent("rh:zoom-fit"))
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      const cmd = commandForEvent(e)
      if (!cmd) return
      e.preventDefault()
      cmd.run()
    }
    const onSaveLayout = () => setPrompt({ kind: "layout" })
    const onEditMarker = () => {
      const u = useUi.getState()
      const t = useStudio.getState().playhead
      const near = u.markers.find((m) => Math.abs(m.at - t) < 0.15)
      setPrompt({ kind: "marker", id: near ? near.id : u.addMarker(t) })
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("rh:save-layout", onSaveLayout)
    document.addEventListener("rh:edit-marker", onEditMarker)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("rh:save-layout", onSaveLayout)
      document.removeEventListener("rh:edit-marker", onEditMarker)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified])

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
      <span className="st-top__dur mono" title="sequence length — follows the last clip unless pinned">
        {Math.round(D * 10) / 10}s
        {s.seq.duration ? (
          <button className="st-tl__hb" onClick={() => s.setDuration(undefined)} title="follow the last clip">auto</button>
        ) : (
          <button className="st-tl__hb" onClick={() => s.setDuration(Math.max(1, Math.round(contentEnd(s.seq))))} title="pin the length">pin</button>
        )}
        {ui.workArea && <span className="st-top__wa" title="work area — only this range renders">{fmtTC(ui.workArea.in)} → {fmtTC(ui.workArea.out)}</span>}
      </span>
      <Seg value={ui.tool} onChange={(t) => ui.setTool(t)} options={[{ v: "select", l: "V" }, { v: "razor", l: "C" }, { v: "hand", l: "H" }]} />
      <span className="st-tl__spacer" />
      <button className="ms-btn ms-btn--small ms-btn--ghost" disabled={!s.past.length} onClick={s.undo} title="undo (⌘Z)">undo</button>
      <button className="ms-btn ms-btn--small ms-btn--ghost" disabled={!s.future.length} onClick={s.redo} title="redo (⇧⌘Z)">redo</button>
      <button
        className={`ms-btn ms-btn--primary rh-renderbtn st-render${render.kind !== "idle" ? " rh-renderbtn--busy" : ""}`}
        disabled={render.kind !== "idle" || (!!missing && verified)}
        title={missing ?? "render (⌘↵)"}
        onClick={() => void startRender()}
      >
        {render.kind === "job" && <span className="rh-renderbtn__bar" style={{ width: `${Math.round((render.progress ?? 0) * 100)}%` }} />}
        <span className="rh-renderbtn__label">{renderLabel}</span>
      </button>
    </div>
  )

  const hiddenInputs = (
    <>
      <input ref={openRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void openProject(f); e.target.value = "" }} />
      <input ref={srtRef} type="file" accept=".srt,.vtt,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importSrt(f); e.target.value = "" }} />
    </>
  )

  const prompts = (
    <>
      {prompt?.kind === "layout" && <TextPrompt title="save layout as" placeholder="layout name" onDone={(v) => { if (v.trim()) { ui.saveLayoutAs(v.trim()); toast(`layout "${v.trim()}" saved`) } setPrompt(null) }} onCancel={() => setPrompt(null)} />}
      {prompt?.kind === "marker" && (() => {
        const m = ui.markers.find((x) => x.id === prompt.id)
        return m ? <TextPrompt title={`marker at ${fmtTC(m.at)}`} initial={m.label} placeholder="label" onDone={(v) => { ui.updateMarker(m.id, { label: v }); setPrompt(null) }} onCancel={() => setPrompt(null)} /> : null
      })()}
      <ShortcutsOverlay />
      <GotoPrompt />
      <AboutSheet />
      <ContextMenuHost />
      {keyOpen && <InviteKeyDialog onClose={() => setKeyOpen(false)} />}
    </>
  )

  if (phone) {
    return (
      <div className="st st--phone">
        {topbar}
        <Monitor />
        <StudioTimeline />
        <div className="st-side__tabs st-side__tabs--phone">
          {(["bin", "inspector", "subtitles", "markers"] as const).map((p) => (
            <button key={p} className={`st-side__tab${phoneTab === p ? " st-side__tab--active" : ""}`} onClick={() => setPhoneTab(p)}>{p === "bin" ? "media" : p}</button>
          ))}
        </div>
        <div className="st-phonepanel">{phoneTab === "bin" ? <MediaBin /> : phoneTab === "subtitles" ? <SubtitlesPanel /> : phoneTab === "markers" ? <MarkersPanel /> : <Inspector />}</div>
        <p className="rh-hint st-phonehint">the studio is happiest on a desktop — fine edits are easier with a mouse and a keyboard</p>
        {missing && contentEnd(s.seq) > 0 && <p className="rh-hint rh-missing">{missing}</p>}
        {hiddenInputs}
        {prompts}
      </div>
    )
  }

  const renderers: PanelRenderers = {
    media: () => <MediaBin />,
    monitor: () => <Monitor />,
    timeline: () => <StudioTimeline />,
    inspector: () => <Inspector />,
    subtitles: () => <SubtitlesPanel />,
    history: () => <HistoryPanel />,
    markers: () => <MarkersPanel />,
  }

  return (
    <div className="st">
      <MenuBar />
      {topbar}
      <div className="st-dock">
        <Dock render={renderers} />
      </div>
      {missing && contentEnd(s.seq) > 0 && <p className="rh-hint rh-missing st-missing st-missing--bar">{missing}</p>}
      {hiddenInputs}
      {prompts}
    </div>
  )
}

export { parseClock }
