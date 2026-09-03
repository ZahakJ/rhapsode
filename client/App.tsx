import { useEffect } from "react"
import { useRoute, navigate, type Route } from "./router.ts"
import { ComposeView } from "./compose/ComposeView.tsx"
import { WallView } from "./wall/WallView.tsx"
import { ResultView } from "./result/ResultView.tsx"
import { RemixView } from "./remix/RemixView.tsx"
import { InviteKeyButton } from "./components/InviteKeyDialog.tsx"
import { Toasts } from "./components/Toasts.tsx"

// `short` and `glyph` are the phone's tab bar; `label` is the desktop titlebar.
const TABS = [
  { hash: "#/", label: "Compose", short: "Compose", glyph: "◱", view: "compose" },
  { hash: "#/wall", label: "The Wall", short: "Wall", glyph: "▦", view: "wall" },
] as const

function Nav({ route, place }: { route: Route; place: "top" | "bottom" }) {
  // the result and remix screens belong to "compose" in the tab bar's eyes
  const active = route.view === "wall" ? "wall" : "compose"
  return (
    <nav className={`rh-nav rh-nav--${place}`}>
      {TABS.map((t) => (
        <a
          key={t.hash}
          href={t.hash}
          aria-current={active === t.view ? "page" : undefined}
          className={`rh-nav__tab${active === t.view ? " rh-nav__tab--active" : ""}`}
        >
          <span className="rh-nav__glyph" aria-hidden="true">
            {t.glyph}
          </span>
          <span>{place === "bottom" ? t.short : t.label}</span>
        </a>
      ))}
    </nav>
  )
}

export function App() {
  const route = useRoute()

  useEffect(() => {
    document.body.dataset.appReady = "1"
  }, [])

  return (
    <div className="ms-hud">
      <header className="ms-hud__titlebar">
        <a className="ms-hud__mark" href="#/" onClick={() => navigate("#/")} aria-label="Rhapsode home">
          <span className="ms-hud__app">Rhapsode</span>
          <span className="ms-hud__sub">ῥαψῳδός · the song-stitcher</span>
        </a>
        <Nav route={route} place="top" />
        <div className="ms-hud__spacer" />
        <InviteKeyButton />
      </header>
      <main className="ms-hud__main">
        {route.view === "compose" && <ComposeView />}
        {route.view === "wall" && <WallView />}
        {route.view === "result" && <ResultView slug={route.slug} />}
        {route.view === "remix" && <RemixView slug={route.slug} />}
      </main>
      <Nav route={route} place="bottom" />
      <Toasts />
    </div>
  )
}
