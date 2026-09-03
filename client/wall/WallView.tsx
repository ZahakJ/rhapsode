import { useEffect, useState } from "react"
import type { RenderDto, StorageDto } from "../../shared/recipe.ts"
import { api } from "../api/client.ts"
import { useAuth } from "../store/authStore.ts"
import { toast } from "../components/Toasts.tsx"
import { fmtBytes, fmtClock } from "../util/time.ts"

export function WallView() {
  const verified = useAuth((s) => s.verified)
  const [items, setItems] = useState<RenderDto[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)

  const load = async (c?: string) => {
    setBusy(true)
    try {
      const page = await api.listRenders(c)
      setItems((prev) => (c ? [...prev, ...page.items] : page.items))
      setCursor(page.nextCursor)
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not load the wall", "danger")
    } finally {
      setBusy(false)
      setLoaded(true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const del = async (slug: string) => {
    try {
      await api.deleteRender(slug)
      setItems((prev) => prev.filter((r) => r.slug !== slug))
      setConfirm(null)
      toast("deleted")
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not delete", "danger")
    }
  }

  return (
    <div className="rh-wall">
      <div className="rh-wall__head">
        <span className="rh-wall__title">the wall</span>
        <span className="rh-wall__count mono">
          {items.length}
          {cursor ? "+" : ""}
        </span>
        <div className="rh-grow" />
        {verified && <StorageStrip key={String(items.length)} />}
      </div>
      {loaded && items.length === 0 ? (
        <div className="ms-empty">
          <div className="ms-empty__title">nothing stitched yet</div>
          <div>the first render lands here</div>
          <a className="ms-btn ms-btn--primary" href="#/">
            cut one
          </a>
        </div>
      ) : (
        <div className="rh-grid">
          {items.map((r) => (
            <div key={r.slug} className={`rh-card${confirm === r.slug ? " rh-card--confirm" : ""}`}>
              <a className="rh-card__link" href={`#/r/${encodeURIComponent(r.slug)}`}>
                <div className="rh-card__media" style={{ aspectRatio: `${r.width} / ${r.height}` }}>
                  <img src={r.posterUrl} alt="" loading="lazy" />
                  <span className="rh-card__dur mono">{fmtClock(r.duration)}</span>
                </div>
                <div className="rh-card__bar">
                  <span className="rh-card__title">{r.title || r.slug}</span>
                </div>
              </a>
              {verified && confirm !== r.slug && (
                <button className="rh-card__x" aria-label={`delete ${r.title || r.slug}`} onClick={() => setConfirm(r.slug)}>
                  ✕
                </button>
              )}
              {confirm === r.slug && (
                <div className="rh-card__confirm">
                  <span>delete for good?</span>
                  <button className="ms-btn ms-btn--small ms-btn--danger" onClick={() => void del(r.slug)}>
                    delete
                  </button>
                  <button className="ms-btn ms-btn--small ms-btn--ghost" onClick={() => setConfirm(null)}>
                    keep
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {cursor && (
        <div className="rh-wall__more">
          <button className="ms-btn" disabled={busy} onClick={() => void load(cursor)}>
            {busy ? "loading…" : "more"}
          </button>
        </div>
      )}
    </div>
  )
}

/** used / cap, with the source cache one click from gone */
function StorageStrip() {
  const [st, setSt] = useState<StorageDto | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    api
      .getStorage()
      .then((s) => live && setSt(s))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const sweep = async () => {
    setBusy(true)
    try {
      const r = await api.sweepStorage()
      setSt(r.storage)
      toast(`freed ${fmtBytes(r.freedBytes)}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : "sweep failed", "danger")
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  if (!st) return null
  const frac = st.capBytes ? Math.min(1, st.usedBytes / st.capBytes) : 0
  return (
    <div className="rh-storage">
      <div className="rh-storage__text mono">
        <span className="rh-storage__used">{fmtBytes(st.usedBytes)}</span> of {fmtBytes(st.capBytes)} · {st.renders.count} renders ·{" "}
        {st.sources.count} sources{st.sources.unreferenced ? `, ${st.sources.unreferenced} unreferenced` : ""}
      </div>
      <div className="rh-storage__bar" title={`${Math.round(frac * 100)}% of the disk budget`}>
        <div className="rh-storage__fill" style={{ width: `${Math.round(frac * 100)}%` }} />
      </div>
      {confirming ? (
        <div className="rh-row">
          <span className="rh-hint">delete every source no render uses ({fmtBytes(st.sources.unreferencedBytes)})?</span>
          <button className="ms-btn ms-btn--small ms-btn--danger" disabled={busy} onClick={() => void sweep()}>
            {busy ? "clearing…" : "clear"}
          </button>
          <button className="ms-btn ms-btn--small ms-btn--ghost" onClick={() => setConfirming(false)}>
            keep
          </button>
        </div>
      ) : (
        <button className="rh-link" disabled={!st.sources.unreferenced} onClick={() => setConfirming(true)}>
          clear source cache
        </button>
      )}
    </div>
  )
}
