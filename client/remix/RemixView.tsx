import { useEffect, useState } from "react"
import { api, ApiError } from "../api/client.ts"
import { useAuth } from "../store/authStore.ts"
import { useCompose } from "../store/composeStore.ts"
import { useStudio } from "../studio/studioStore.ts"
import { InviteKeyDialog } from "../components/InviteKeyDialog.tsx"
import { toast } from "../components/Toasts.tsx"
import { navigate } from "../router.ts"

/** Pull a render's recipe into the composer. Gated: the recipe names sources. */
export function RemixView({ slug }: { slug: string }) {
  const verified = useAuth((s) => s.verified)
  const [keyOpen, setKeyOpen] = useState(!verified)
  const [state, setState] = useState<"loading" | "error">("loading")
  const [msg, setMsg] = useState("")

  useEffect(() => {
    if (!verified) return
    let live = true
    api
      .getRecipe(slug)
      .then(({ recipe, sequence, title, sources }) => {
        if (!live) return
        if (sequence) {
          useStudio.getState().setSequence(sequence, title ?? "", sources)
          toast("sequence loaded — remix away in the studio")
          navigate("#/studio")
          return
        }
        if (!recipe) throw new Error("that render carries no recipe")
        useCompose.getState().loadRecipe(recipe, sources)
        const missing = [recipe.base.source, recipe.overlay.source].filter((id) => !sources.some((s) => s.id === id))
        if (missing.length) toast("a source was swept — re-add it", "warn")
        else toast("recipe loaded — remix away")
        navigate("#/")
      })
      .catch((e) => {
        if (!live) return
        if (e instanceof ApiError && e.status === 404) {
          setMsg("a source was swept, and the recipe went with it. Re-add the pieces to make it again.")
        } else setMsg(e instanceof Error ? e.message : "could not load the recipe")
        setState("error")
      })
    return () => {
      live = false
    }
  }, [slug, verified])

  return (
    <div className="rh-page">
      <div className="ms-empty">
        {!verified ? (
          <>
            <div className="ms-empty__title">remixing needs the key</div>
            <button className="ms-btn ms-btn--primary" onClick={() => setKeyOpen(true)}>enter the invite key</button>
            <a className="ms-btn ms-btn--ghost" href={`#/r/${encodeURIComponent(slug)}`}>back</a>
          </>
        ) : state === "loading" ? (
          <div className="ms-empty__title">loading the recipe…</div>
        ) : (
          <>
            <div className="ms-empty__title">can't remix that one</div>
            <div>{msg}</div>
            <a className="ms-btn" href="#/">compose fresh</a>
          </>
        )}
      </div>
      {keyOpen && <InviteKeyDialog onClose={() => setKeyOpen(false)} />}
    </div>
  )
}
