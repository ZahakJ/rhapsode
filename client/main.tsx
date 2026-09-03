import "@fontsource/ibm-plex-sans"
import "@fontsource/ibm-plex-sans/500.css"
import "@fontsource/ibm-plex-sans/600.css"
import "@fontsource/ibm-plex-mono"
import "@fontsource/ibm-plex-mono/500.css"
// captions only — the one display face
import "@fontsource/anton"
import "./styles/tokens.css"
import "./styles/base.css"
import "./styles/components.css"
import "./styles/app.css"
import "./styles/mobile.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
