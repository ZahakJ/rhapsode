import { useEffect, useState } from "react"
import type { RenderDto } from "../../shared/recipe.ts"
import { api } from "../api/client.ts"
import { useAuth } from "../store/authStore.ts"
import { toast } from "../components/Toasts.tsx"
import { navigate } from "../router.ts"
import { fmtClock } from "../util/time.ts"

export function ResultView({ slug }: { slug: string }) {
  const verified = useAuth((s) => s.verified)
  const [render, setRender] = useState<RenderDto | null>(null)
  const [missing, setMissing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let live = true
    setRender(null)
    setMissing(false)
    api
      .getRender(slug)
      .then((r) => live && setRender(r))
      .catch(() => live && setMissing(true))
    return () => {
      live = false
    }
  }, [slug])

  const shareUrl = `${window.location.origin}/m/${encodeURIComponent(slug)}`
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function"

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast("link copied")
    } catch {
      toast(shareUrl, "warn")
    }
  }
  const share = async () => {
    try {
      await navigator.share({ title: render?.title || "rhapsode", url: shareUrl })
    } catch {
      /* user dismissed */
    }
  }
  const del = async () => {
    try {
      await api.deleteRender(slug)
      toast("deleted")
      navigate("#/wall")
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not delete", "danger")
    }
  }

  if (missing) {
    return (
      <div className="rh-page">
        <div className="ms-empty">
          <div className="ms-empty__title">nothing here</div>
          <div>no render called <span className="mono">{slug}</span></div>
          <a className="ms-btn" href="#/wall">the wall</a>
        </div>
      </div>
    )
  }
  if (!render) return <div className="rh-page"><div className="ms-empty">loading…</div></div>

  return (
    <div className="rh-page rh-result">
      <div className="rh-result__media">
        <video src={render.url} poster={render.posterUrl} controls playsInline preload="metadata" />
      </div>
      <div className="rh-result__meta">
        <h1 className="rh-result__title">{render.title || render.slug}</h1>
        <div className="rh-result__line mono">
          {fmtClock(render.duration)} · {render.width}×{render.height} · <span className="rh-result__slug">{render.slug}</span>
        </div>
        <div className="rh-result__actions">
          <button className="ms-btn ms-btn--primary" onClick={() => void copy()}>copy link</button>
          {canShare && <button className="ms-btn" onClick={() => void share()}>share…</button>}
          <a className="ms-btn" href={render.url} download={`${render.slug}.mp4`}>download mp4</a>
          <a className="ms-btn" href={`#/remix/${encodeURIComponent(render.slug)}`}>remix</a>
          <a className="ms-btn ms-btn--ghost" href={render.shareUrl} target="_blank" rel="noreferrer">open share page ↗</a>
        </div>
        <div className="rh-result__share mono">{shareUrl}</div>
        {verified && (
          <div className="rh-result__danger">
            {confirming ? (
              <div className="rh-row">
                <span className="rh-hint">delete this render for good?</span>
                <button className="ms-btn ms-btn--danger" onClick={() => void del()}>yes, delete</button>
                <button className="ms-btn ms-btn--ghost" onClick={() => setConfirming(false)}>keep it</button>
              </div>
            ) : (
              <button className="ms-btn ms-btn--ghost" onClick={() => setConfirming(true)}>delete…</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
