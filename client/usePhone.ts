import { useEffect, useState } from "react"

// The one breakpoint the app branches on in JS. It must stay in lockstep with
// the LAYOUT block in styles/mobile.css: below it the forge has no room for
// three rails, so the picker and the inspector move into bottom sheets.
export const PHONE_QUERY = "(max-width: 900px)"

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const sync = () => setMatches(mql.matches)
    sync() // the query may have flipped between render and effect
    mql.addEventListener("change", sync)
    return () => mql.removeEventListener("change", sync)
  }, [query])
  return matches
}

/** True on phone-sized glass — the app is a canvas, a tray and sheets. */
export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY)
}
