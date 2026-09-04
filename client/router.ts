import { useEffect, useState } from "react"

// Hand-rolled hash router (family pattern — the router owns the URL).
// Routes: #/ (compose), #/wall, #/r/<slug> (result), #/remix/<slug>

export type Route =
  | { view: "compose" }
  | { view: "wall" }
  | { view: "result"; slug: string }
  | { view: "remix"; slug: string }
  | { view: "studio"; slug?: string }

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "")
  if (h === "wall" || h.startsWith("wall/")) return { view: "wall" }
  if (h.startsWith("r/")) {
    const slug = decodeURIComponent(h.slice(2))
    if (slug) return { view: "result", slug }
  }
  if (h === "studio" || h.startsWith("studio/")) {
    const slug = decodeURIComponent(h.slice("studio/".length))
    return slug ? { view: "studio", slug } : { view: "studio" }
  }
  if (h.startsWith("remix/")) {
    const slug = decodeURIComponent(h.slice(6))
    if (slug) return { view: "remix", slug }
  }
  return { view: "compose" }
}

export function navigate(to: string): void {
  window.location.hash = to
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash))
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])
  return route
}
