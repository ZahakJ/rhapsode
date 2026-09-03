import "@fontsource-variable/inter"
import "@fontsource-variable/jetbrains-mono"
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
