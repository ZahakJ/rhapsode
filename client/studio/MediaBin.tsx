import { useEffect, useRef, useState } from "react"
import type { JobDto, SourceDto } from "../../shared/recipe.ts"
import { api, ApiError } from "../api/client.ts"
import { watchJob } from "../api/jobs.ts"
import { toast } from "../components/Toasts.tsx"
import { isHttpUrl } from "../compose/ingestStore.ts"
import { useAuth } from "../store/authStore.ts"
import { fmtClock, parseClock } from "../util/time.ts"
import { isAudioSource, isVisualSource, useStudio } from "./studioStore.ts"

type Pending = { key: string; label: string; pct: number | null }

/**
 * The media bin: every ready source, plus a way to get more in — a link, a
 * file, a paste, a drop. Click selects (shift/⌘ for many), "add" places the
 * source at the playhead, a multi-selection of stills offers a montage.
 */
export function MediaBin() {
  const verified = useAuth((s) => s.verified)
  const sources = useStudio((s) => s.sources)
  const binSel = useStudio((s) => s.binSelection)
  const toggleBin = useStudio((s) => s.toggleBin)
  const addSources = useStudio((s) => s.addSources)
  const addClip = useStudio((s) => s.addClipFromSource)
  const makeMontage = useStudio((s) => s.makeMontage)
  const [url, setUrl] = useState("")
  const [pending, setPending] = useState<Pending[]>([])
  const [around, setAround] = useState<{ url: string; duration: number; title: string; value: string } | null>(null)
  const [each, setEach] = useState(3)
  const [dragging, setDragging] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!verified) return
    api
      .listSources()
      .then((list) => addSources(list.filter((s) => s.status === "ready")))
      .catch(() => {})
  }, [verified, addSources])

  const list = Object.values(sources)
    .filter((s) => s.status === "ready")
    .sort((a, b) => b.createdAt - a.createdAt)

  const follow = (key: string, label: string, res: { source: SourceDto; job: JobDto | null }) => {
    if (!res.job || res.source.status === "ready") {
      addSources([res.source])
      setPending((p) => p.filter((x) => x.key !== key))
      toast("already here — reused it")
      return
    }
    setPending((p) => [...p.filter((x) => x.key !== key), { key, label, pct: null }])
    watchJob(res.job.id, (ev) => {
      if (ev.type === "progress") setPending((p) => p.map((x) => (x.key === key ? { ...x, pct: ev.progress } : x)))
      else if (ev.type === "done") {
        const src = (ev.result as SourceDto | undefined) ?? res.source
        api.getSource(src.id).then((fresh) => addSources([fresh])).catch(() => addSources([src]))
        setPending((p) => p.filter((x) => x.key !== key))
        toast(`"${src.title || "source"}" is ready`)
      } else if (ev.type === "failed") {
        setPending((p) => p.filter((x) => x.key !== key))
        toast(ev.error, "danger")
      }
    })
  }

  const needKey = (): boolean => {
    if (verified) return false
    toast("enter the invite key first (top right)", "warn")
    return true
  }

  const ingestUrl = async (u: string, aroundS?: number) => {
    if (needKey()) return
    if (!isHttpUrl(u)) {
      toast("that is not a link", "warn")
      return
    }
    const key = `u:${u}`
    setPending((p) => [...p, { key, label: "asking the site", pct: null }])
    try {
      const res = await api.createUrlSource(u, aroundS)
      follow(key, u, res)
      setUrl("")
      setAround(null)
    } catch (e) {
      setPending((p) => p.filter((x) => x.key !== key))
      if (e instanceof ApiError && e.status === 409) {
        setAround({ url: u, duration: typeof e.body.duration === "number" ? e.body.duration : 0, title: typeof e.body.title === "string" ? e.body.title : u, value: "" })
        return
      }
      toast(e instanceof Error ? e.message : "could not fetch that link", "danger")
    }
  }

  const ingestFile = async (file: File) => {
    if (needKey()) return
    const key = `f:${file.name}:${file.size}`
    setPending((p) => [...p, { key, label: `uploading ${file.name}`, pct: 0 }])
    try {
      const res = await api.uploadSource(file, (pct) => setPending((p) => p.map((x) => (x.key === key ? { ...x, pct } : x))))
      follow(key, file.name, res)
    } catch (e) {
      setPending((p) => p.filter((x) => x.key !== key))
      toast(e instanceof Error ? e.message : "upload failed", "danger")
    }
  }

  const pasteFromClipboard = async () => {
    try {
      if (navigator.clipboard && "read" in navigator.clipboard) {
        const items = await navigator.clipboard.read()
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/") || t.startsWith("video/"))
          if (type) {
            const blob = await item.getType(type)
            const ext = type.split("/")[1] ?? "png"
            void ingestFile(new File([blob], `pasted.${ext}`, { type }))
            return
          }
        }
      }
      const text = await navigator.clipboard.readText()
      if (isHttpUrl(text)) {
        void ingestUrl(text.trim())
        return
      }
      toast("nothing pasteable on the clipboard — copy an image or a link first", "warn")
    } catch {
      toast("long-press the link field and paste a link, or pick a file", "warn")
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(0)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) {
      for (const f of files) void ingestFile(f)
      return
    }
    const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain")
    if (text && isHttpUrl(text)) void ingestUrl(text.trim())
  }

  const selectedStills = binSel.filter((id) => sources[id]?.media === "image")

  return (
    <div
      className={`st-bin${dragging ? " st-bin--drop" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault()
        setDragging((d) => d + 1)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={() => setDragging((d) => Math.max(0, d - 1))}
      onDrop={onDrop}
    >
      <div className="st-bin__head">
        <span className="st-section__title">media</span>
        <span className="mono st-bin__count">{list.length}</span>
      </div>
      <div className="st-bin__ingest">
        <div className="ms-search st-bin__url">
          <input
            type="url"
            inputMode="url"
            enterKeyHint="go"
            placeholder="paste a link…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter") void ingestUrl(url.trim())
            }}
          />
        </div>
        <button className="ms-btn ms-btn--small" disabled={!url.trim()} onClick={() => void ingestUrl(url.trim())}>
          fetch
        </button>
        <label className="ms-btn ms-btn--small st-bin__file">
          <input ref={fileRef} type="file" accept="video/*,audio/*,image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => {
            for (const f of Array.from(e.target.files ?? [])) void ingestFile(f)
            if (fileRef.current) fileRef.current.value = ""
          }} />
          files
        </label>
        <button className="ms-btn ms-btn--small" onClick={() => void pasteFromClipboard()} title="paste an image or a link from the clipboard">
          paste
        </button>
      </div>
      {around && (
        <div className="st-bin__around">
          <p className="rh-hint">
            <strong>{around.title}</strong> runs {fmtClock(around.duration)} — around what time? a 15-minute window is fetched.
          </p>
          <div className="rh-row">
            <div className="ms-search rh-grow">
              <input inputMode="numeric" placeholder="h:mm:ss" value={around.value} autoFocus onChange={(e) => setAround({ ...around, value: e.target.value })} onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Enter") {
                  const s = parseClock(around.value)
                  if (Number.isFinite(s)) void ingestUrl(around.url, s)
                }
              }} />
            </div>
            <button className="ms-btn ms-btn--primary ms-btn--small" onClick={() => {
              const s = parseClock(around.value)
              if (Number.isFinite(s)) void ingestUrl(around.url, s)
              else toast("give a time like 1:23:45", "warn")
            }}>fetch</button>
            <button className="ms-btn ms-btn--ghost ms-btn--small" onClick={() => setAround(null)}>cancel</button>
          </div>
        </div>
      )}
      {pending.length > 0 && (
        <ul className="st-bin__pending">
          {pending.map((p) => (
            <li key={p.key}>
              <span className="st-bin__plabel">{p.label}</span>
              <span className={`rh-progress__track${p.pct === null ? " rh-progress__track--indeterminate" : ""}`}>
                <span className="rh-progress__fill" style={{ width: `${Math.round((p.pct ?? 0) * 100)}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {selectedStills.length >= 2 && (
        <div className="st-bin__montage">
          <span className="rh-hint">{selectedStills.length} stills selected</span>
          <label className="st-bin__each mono">
            <input type="number" min={1} max={20} step={0.5} value={each} onChange={(e) => setEach(Number(e.target.value) || 3)} /> s each
          </label>
          <button className="ms-btn ms-btn--primary ms-btn--small st-bin__montagebtn" onClick={() => makeMontage(selectedStills, each, 0.5)}>
            make a montage
          </button>
        </div>
      )}
      <div className="st-bin__grid">
        {list.length === 0 && !pending.length && (
          <div className="st-bin__empty rh-hint">{verified ? "nothing here yet — paste a link, drop files, or hit files" : "enter the invite key to load your media"}</div>
        )}
        {list.map((s) => {
          const selected = binSel.includes(s.id)
          const audioOnly = !isVisualSource(s) && isAudioSource(s)
          return (
            <div
              key={s.id}
              className={`st-bin__item${selected ? " st-bin__item--sel" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-rhapsode-source", s.id)
                e.dataTransfer.effectAllowed = "copy"
              }}
              onClick={(e) => toggleBin(s.id, e.shiftKey || e.metaKey || e.ctrlKey)}
              title={s.title}
            >
              <div className="st-bin__thumb">
                {s.thumbUrl ? <img src={s.thumbUrl} alt="" loading="lazy" /> : <span className="st-bin__glyph">{audioOnly ? "♪" : "▣"}</span>}
                {audioOnly && s.thumbUrl && <span className="st-bin__glyph st-bin__glyph--over">♪</span>}
                <span className="st-bin__kind mono">{s.media === "image" ? "still" : audioOnly ? `♪ ${fmtClock(s.duration ?? 0)}` : fmtClock(s.duration ?? 0)}</span>
              </div>
              <div className="st-bin__name">{s.title || s.kind}</div>
              <button
                className="st-bin__add"
                onClick={(e) => {
                  e.stopPropagation()
                  const id = addClip(s)
                  if (id) toast(`added "${s.title || "clip"}" at the playhead`)
                }}
                title="add at the playhead"
              >
                + add
              </button>
            </div>
          )
        })}
      </div>
      <p className="rh-hint st-bin__hint">drag onto a track · shift-click to select several · ⌘V pastes here too</p>
    </div>
  )
}
