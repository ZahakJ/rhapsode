import { useEffect, useRef, useState } from "react"
import type { JobDto, SourceDto } from "../../shared/recipe.ts"
import { api, ApiError } from "../api/client.ts"
import { useAuth } from "../store/authStore.ts"
import { toast } from "../components/Toasts.tsx"
import { InviteKeyDialog } from "../components/InviteKeyDialog.tsx"
import { JobProgress } from "./JobProgress.tsx"
import { fmtClock, parseClock } from "../util/time.ts"

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; pct: number }
  | { kind: "job"; job: JobDto; source: SourceDto }
  | { kind: "around"; url: string; duration: number; title: string }

/**
 * One slot of the composition: paste a URL or pick a file, watch it become a
 * source, or re-pick a recent one. Used twice — the base and the clip on top.
 */
export function SourcePicker({
  slot,
  source,
  onSource,
  allowImage,
}: {
  slot: "base" | "overlay"
  source: SourceDto | null
  onSource: (s: SourceDto | null) => void
  allowImage: boolean
}) {
  const verified = useAuth((s) => s.verified)
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const [url, setUrl] = useState("")
  const [around, setAround] = useState("")
  const [recent, setRecent] = useState<SourceDto[]>([])
  const [keyOpen, setKeyOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

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

  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    toast(msg, "danger")
    setPhase({ kind: "idle" })
  }

  const handleCreated = (res: { source: SourceDto; job: JobDto | null }) => {
    if (res.source.status === "ready" || !res.job) {
      onSource(res.source)
      setPhase({ kind: "idle" })
      toast("already here — reused it")
    } else {
      setPhase({ kind: "job", job: res.job, source: res.source })
    }
  }

  const fetchUrl = async (aroundS?: number) => {
    const u = url.trim()
    if (!u || needKey()) return
    setPhase({ kind: "uploading", pct: 0 })
    try {
      const res = await api.createUrlSource(u, aroundS)
      handleCreated(res)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const d = typeof e.body.duration === "number" ? e.body.duration : 0
        const t = typeof e.body.title === "string" ? e.body.title : u
        setPhase({ kind: "around", url: u, duration: d, title: t })
        return
      }
      fail(e)
    }
  }

  const submitAround = () => {
    if (phase.kind !== "around") return
    const s = parseClock(around)
    if (!Number.isFinite(s) || s < 0 || (phase.duration && s > phase.duration)) {
      toast("give a time like 1:23:45 inside the video", "warn")
      return
    }
    void fetchUrl(s)
  }

  const pickFile = (file: File | undefined) => {
    if (!file || needKey()) return
    if (!allowImage && !file.type.startsWith("video/")) {
      toast("the clip on top has to be a video", "warn")
      return
    }
    const ctl = new AbortController()
    abortRef.current = ctl
    setPhase({ kind: "uploading", pct: 0 })
    api
      .uploadSource(file, (f) => setPhase({ kind: "uploading", pct: f }), ctl.signal)
      .then(handleCreated)
      .catch(fail)
      .finally(() => {
        abortRef.current = null
        if (fileRef.current) fileRef.current.value = ""
      })
  }

  const cancelUpload = () => {
    abortRef.current?.abort()
    setPhase({ kind: "idle" })
  }

  const accept = allowImage ? "video/*,image/jpeg,image/png,image/webp" : "video/*"
  const title = slot === "base" ? "the base" : "the clip on top"
  const hint =
    slot === "base"
      ? "What it goes over: a video, a photo, or a YouTube link."
      : "The piece you are laying on top — a song, a line, a moment."

  return (
    <section className={`rh-picker rh-picker--${slot}`}>
      <div className="rh-picker__head">
        <span className="rh-picker__title">{title}</span>
        {source && (
          <button className="ms-btn ms-btn--ghost rh-picker__swap" onClick={() => onSource(null)}>
            swap
          </button>
        )}
      </div>

      {source ? (
        <SourceCard source={source} />
      ) : phase.kind === "job" ? (
        <div className="rh-picker__job">
          <div className="rh-picker__jobtitle">{phase.source.title || phase.source.url || "preparing"}</div>
          <JobProgress
            job={phase.job}
            onDone={(result) => {
              const s = (result ?? phase.source) as SourceDto
              onSource(s.status ? s : phase.source)
              setPhase({ kind: "idle" })
            }}
            onFail={(err) => {
              toast(err, "danger")
              setPhase({ kind: "idle" })
            }}
          />
        </div>
      ) : phase.kind === "uploading" ? (
        <div className="rh-picker__job">
          <div className="rh-progress">
            <div className="rh-progress__row">
              <span className="rh-progress__label">{url.trim() ? "asking the site" : "uploading"}</span>
              <span className="rh-progress__pct mono">{Math.round(phase.pct * 100)}%</span>
            </div>
            <div className={`rh-progress__track${phase.pct === 0 ? " rh-progress__track--indeterminate" : ""}`}>
              <div className="rh-progress__fill" style={{ width: `${Math.round(phase.pct * 100)}%` }} />
            </div>
          </div>
          {abortRef.current && (
            <button className="ms-btn ms-btn--ghost" onClick={cancelUpload}>
              cancel
            </button>
          )}
        </div>
      ) : phase.kind === "around" ? (
        <div className="rh-picker__around">
          <p className="rh-hint">
            <strong>{phase.title}</strong> runs {fmtClock(phase.duration)} — too long to fetch whole.
            Around what time is the part you want? A 15-minute window around it is fetched.
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
            <button className="ms-btn ms-btn--ghost" onClick={() => setPhase({ kind: "idle" })}>
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
                placeholder="paste a link — YouTube, X, TikTok, Instagram…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void fetchUrl()
                }}
              />
            </div>
            <button className="ms-btn ms-btn--primary" disabled={!url.trim()} onClick={() => void fetchUrl()}>
              fetch
            </button>
          </div>
          <div className="rh-row rh-row--or">
            <span className="rh-or">or</span>
            <label className="ms-btn rh-filebtn">
              <input
                ref={fileRef}
                type="file"
                accept={accept}
                hidden
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
              {allowImage ? "pick a video or photo" : "pick a video"}
            </label>
          </div>
          {recent.length > 0 && (
            <div className="rh-recent">
              <div className="rh-recent__label">recent</div>
              <div className="rh-recent__strip">
                {recent.map((s) => (
                  <button key={s.id} className="rh-recent__item" onClick={() => onSource(s)} title={s.title}>
                    {s.thumbUrl ? <img src={s.thumbUrl} alt="" loading="lazy" /> : <span className="rh-recent__blank" />}
                    <span className="rh-recent__name">{s.title || s.kind}</span>
                    {s.duration !== null && <span className="rh-recent__dur mono">{fmtClock(s.duration)}</span>}
                  </button>
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
