import { useEffect, useRef, useState } from "react"
import type { SourceDto } from "../../shared/recipe.ts"
import { api } from "../api/client.ts"
import { useAuth } from "../store/authStore.ts"
import { toast } from "../components/Toasts.tsx"
import { InviteKeyDialog } from "../components/InviteKeyDialog.tsx"
import { JobProgress } from "./JobProgress.tsx"
import { useIngest, type Slot } from "./ingestStore.ts"
import { CropPanel } from "./CropPanel.tsx"
import { isRealEdit } from "../store/composeStore.ts"
import type { Edit } from "../../shared/recipe.ts"
import { fmtClock, parseClock } from "../util/time.ts"

/**
 * One slot of the composition: paste a link, pick or drop a file, paste from
 * the clipboard, or re-pick a recent source. Used twice — the base and the
 * clip on top. All the work happens in ingestStore; this is the view.
 */
export function SourcePicker({
  slot,
  source,
  onSource,
  allowImage,
  edit = null,
  onEdit,
}: {
  slot: Slot
  source: SourceDto | null
  onSource: (s: SourceDto | null) => void
  allowImage: boolean
  edit?: Edit | null
  onEdit?: (e: Edit | null) => void
}) {
  const [cropOpen, setCropOpen] = useState(false)
  const verified = useAuth((s) => s.verified)
  const phase = useIngest((s) => s[slot])
  const ingest = useIngest()
  const [url, setUrl] = useState("")
  const [around, setAround] = useState("")
  const [recent, setRecent] = useState<SourceDto[]>([])
  const [keyOpen, setKeyOpen] = useState(false)
  const [over, setOver] = useState(0)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const deleteRecent = async (id: string) => {
    try {
      await api.deleteSource(id)
      setRecent((list) => list.filter((x) => x.id !== id))
      toast("source deleted")
    } catch (e) {
      const status = (e as { status?: number }).status
      toast(status === 409 ? "a render still uses it" : e instanceof Error ? e.message : "could not delete", "warn")
    } finally {
      setConfirmDel(null)
    }
  }

  useEffect(() => {
    if (!verified) return
    let live = true
    api
      .listSources()
      .then((list) => {
        if (!live) return
        setRecent(list.filter((s) => s.status === "ready" && (allowImage || s.media === "video")))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [verified, allowImage, source?.id])

  const needKey = (): boolean => {
    if (verified) return false
    setKeyOpen(true)
    return true
  }

  const fetchUrl = (aroundS?: number) => {
    const u = url.trim()
    if (!u || needKey()) return
    void ingest.ingestUrl(slot, u, aroundS)
  }

  const submitAround = () => {
    if (phase.kind !== "around") return
    const s = parseClock(around)
    if (!Number.isFinite(s) || s < 0 || (phase.duration && s > phase.duration)) {
      toast("give a time like 1:23:45 inside the video", "warn")
      return
    }
    void ingest.ingestUrl(slot, phase.url, s)
  }

  const pickFile = (file: File | undefined) => {
    if (!file || needKey()) return
    void ingest.ingestFile(slot, file)
  }

  const pasteFromClipboard = async () => {
    if (needKey()) return
    const nav = navigator as Navigator & { clipboard?: { read?: () => Promise<ClipboardItem[]>; readText?: () => Promise<string> } }
    try {
      if (nav.clipboard?.read) {
        const items = await nav.clipboard.read()
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/") || t.startsWith("video/"))
          if (type) {
            const blob = await item.getType(type)
            const ext = type.split("/")[1] ?? "png"
            void ingest.ingestFile(slot, new File([blob], `pasted.${ext}`, { type }))
            return
          }
        }
      }
      const text = nav.clipboard?.readText ? (await nav.clipboard.readText()).trim() : ""
      if (text && /^https?:\/\//.test(text)) {
        setUrl(text)
        void ingest.ingestUrl(slot, text)
        return
      }
      toast("nothing pasteable on the clipboard — copy an image or a link first", "warn")
    } catch {
      toast("long-press the link field and paste a link, or pick from your photos", "warn")
    }
  }

  // drag & drop onto the whole slot
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    setOver((n) => n + 1)
  }
  const onDragLeave = () => setOver((n) => Math.max(0, n - 1))
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(0)
    const file = e.dataTransfer.files?.[0]
    if (file) {
      pickFile(file)
      return
    }
    const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain")
    if (text && /^https?:\/\//.test(text.trim())) {
      setUrl(text.trim())
      if (!needKey()) void ingest.ingestUrl(slot, text.trim())
    }
  }

  const accept = allowImage ? "video/*,image/jpeg,image/png,image/webp" : "video/*"
  const title = slot === "base" ? "base" : "clip on top"
  const hint =
    slot === "base"
      ? "what it goes over — a video, a photo, or a link"
      : "the piece you lay on top — a song, a line, a moment"

  return (
    <section
      className={`rh-picker rh-picker--${slot}${over ? " rh-picker--over" : ""}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="rh-picker__head">
        <span className="rh-picker__title">
          <span className="rh-picker__n mono">{slot === "base" ? "A" : "B"}</span> {title}
        </span>
        {source && (
          <span className="rh-row">
            {onEdit && (
              <button className="rh-link" onClick={() => setCropOpen(true)}>
                {isRealEdit(edit) ? "edit ·" : "crop / rotate"}
              </button>
            )}
            {isRealEdit(edit) && (
              <span className="rh-badge mono" title="this source is edited">
                {edit?.crop && (edit.crop.w < 0.9995 || edit.crop.h < 0.9995) ? "crop " : ""}
                {edit?.rotate ? `↻${edit.rotate} ` : ""}
                {edit?.flipH ? "↔" : ""}
              </span>
            )}
            <button className="rh-link" onClick={() => onSource(null)}>
              swap
            </button>
          </span>
        )}
      </div>

      {source && cropOpen && onEdit && (
        <CropPanel
          source={source}
          edit={edit}
          onClose={() => setCropOpen(false)}
          onDone={(e) => {
            onEdit(e)
            setCropOpen(false)
          }}
        />
      )}

      {source ? (
        <SourceCard source={source} />
      ) : phase.kind === "job" ? (
        <div className="rh-picker__job">
          <div className="rh-picker__jobtitle">{phase.source.title || phase.source.url || "preparing"}</div>
          <JobProgress
            job={phase.job}
            onDone={(result) => {
              const s = (result ?? phase.source) as SourceDto
              ingest.finish(slot, s.status ? s : phase.source)
            }}
            onFail={(err) => {
              toast(err, "danger")
              ingest.setPhase(slot, { kind: "idle" })
            }}
          />
        </div>
      ) : phase.kind === "uploading" ? (
        <div className="rh-picker__job">
          <div className="rh-progress">
            <div className="rh-progress__row">
              <span className="rh-progress__label">{phase.label}</span>
              <span className="rh-progress__pct mono">{phase.pct > 0 ? `${Math.round(phase.pct * 100)}%` : "…"}</span>
            </div>
            <div className={`rh-progress__track${phase.pct === 0 ? " rh-progress__track--indeterminate" : ""}`}>
              <div className="rh-progress__fill" style={phase.pct === 0 ? undefined : { width: `${Math.round(phase.pct * 100)}%` }} />
            </div>
          </div>
          {phase.label === "uploading" && (
            <button className="ms-btn ms-btn--ghost" onClick={() => ingest.cancel(slot)}>
              cancel
            </button>
          )}
        </div>
      ) : phase.kind === "around" ? (
        <div className="rh-picker__around">
          <p className="rh-hint">
            <strong>{phase.title}</strong> runs {fmtClock(phase.duration)} — too long to fetch whole. Around what time is the
            part you want? A 15-minute window around it is fetched.
          </p>
          <div className="rh-row">
            <div className="ms-search rh-grow">
              <input
                inputMode="numeric"
                placeholder="h:mm:ss"
                value={around}
                autoFocus
                onChange={(e) => setAround(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitAround()
                }}
              />
            </div>
            <button className="ms-btn ms-btn--primary" onClick={submitAround}>
              fetch
            </button>
            <button className="ms-btn ms-btn--ghost" onClick={() => ingest.setPhase(slot, { kind: "idle" })}>
              back
            </button>
          </div>
        </div>
      ) : (
        <div className="rh-picker__body">
          <p className="rh-hint">{hint}</p>
          <div className="rh-row">
            <div className="ms-search rh-grow">
              <input
                type="url"
                inputMode="url"
                enterKeyHint="go"
                placeholder="paste a link — YouTube, X, TikTok, Instagram…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") fetchUrl()
                }}
              />
            </div>
            <button className="ms-btn ms-btn--primary" disabled={!url.trim()} onClick={() => fetchUrl()}>
              fetch
            </button>
          </div>
          <div className="rh-row rh-row--or">
            <label className="ms-btn rh-filebtn">
              <input ref={fileRef} type="file" accept={accept} hidden onChange={(e) => pickFile(e.target.files?.[0])} />
              {allowImage ? "photos & videos" : "pick a video"}
            </label>
            <button className="ms-btn" onClick={() => void pasteFromClipboard()} title="paste an image, a video or a link from the clipboard">
              paste
            </button>
            <span className="rh-hint rh-picker__drop">or drop a file here</span>
          </div>
          {recent.length > 0 && (
            <div className="rh-recent">
              <div className="rh-recent__label">recent</div>
              <div className="rh-recent__strip">
                {recent.map((s) => (
                  <div key={s.id} className="rh-recent__cell">
                    <button className="rh-recent__item" onClick={() => onSource(s)} title={s.title}>
                      {s.thumbUrl ? <img src={s.thumbUrl} alt="" loading="lazy" /> : <span className="rh-recent__blank" />}
                      <span className="rh-recent__name">{s.title || s.kind}</span>
                      {s.duration !== null && <span className="rh-recent__dur mono">{fmtClock(s.duration)}</span>}
                    </button>
                    {confirmDel === s.id ? (
                      <div className="rh-recent__confirm">
                        <button className="rh-recent__yes" onClick={() => void deleteRecent(s.id)}>
                          delete
                        </button>
                        <button className="rh-recent__no" onClick={() => setConfirmDel(null)}>
                          keep
                        </button>
                      </div>
                    ) : (
                      <button className="rh-recent__x" aria-label={`delete ${s.title || "source"}`} onClick={() => setConfirmDel(s.id)}>
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {keyOpen && <InviteKeyDialog onClose={() => setKeyOpen(false)} />}
    </section>
  )
}

function SourceCard({ source }: { source: SourceDto }) {
  return (
    <div className="rh-srccard">
      {source.thumbUrl ? (
        <img className="rh-srccard__thumb" src={source.thumbUrl} alt="" />
      ) : (
        <div className="rh-srccard__thumb rh-srccard__thumb--blank" />
      )}
      <div className="rh-srccard__meta">
        <div className="rh-srccard__title">{source.title || (source.kind === "url" ? source.url : "upload")}</div>
        <div className="rh-srccard__line mono">
          {source.media === "image" ? "photo" : source.duration !== null ? fmtClock(source.duration) : "video"}
          {source.width && source.height ? ` · ${source.width}×${source.height}` : ""}
          {source.media === "video" && !source.hasAudio ? " · silent" : ""}
        </div>
        {source.windowStart !== null && source.windowEnd !== null && (
          <div className="rh-srccard__line rh-srccard__window">
            covers {fmtClock(source.windowStart)}–{fmtClock(source.windowEnd)} of the original
          </div>
        )}
      </div>
    </div>
  )
}
