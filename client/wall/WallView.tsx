import { useEffect, useState } from "react"
import type { RenderDto } from "../../shared/recipe.ts"
import { api } from "../api/client.ts"
import { toast } from "../components/Toasts.tsx"
import { fmtClock } from "../util/time.ts"

export function WallView() {
  const [items, setItems] = useState<RenderDto[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

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

  return (
    <div className="rh-wall">
      <div className="rh-wall__head">
        <span className="rh-wall__title">the wall</span>
        <span className="rh-wall__count mono">{items.length}{cursor ? "+" : ""}</span>
      </div>
      {loaded && items.length === 0 ? (
        <div className="ms-empty">
          <div className="ms-empty__title">nothing stitched yet</div>
          <div>the first render lands here</div>
          <a className="ms-btn ms-btn--primary" href="#/">compose one</a>
        </div>
      ) : (
        <div className="rh-grid">
          {items.map((r) => (
            <a key={r.slug} className="rh-card" href={`#/r/${encodeURIComponent(r.slug)}`}>
              <div className="rh-card__media" style={{ aspectRatio: `${r.width} / ${r.height}` }}>
                <img src={r.posterUrl} alt="" loading="lazy" />
                <span className="rh-card__dur mono">{fmtClock(r.duration)}</span>
              </div>
              <div className="rh-card__bar">
                <span className="rh-card__title">{r.title || r.slug}</span>
              </div>
            </a>
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
