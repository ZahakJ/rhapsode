import { createPortal } from "react-dom"
import type { ReactNode } from "react"

// Overlays must escape ancestors with backdrop-filter/transform — those
// create containing blocks that capture position:fixed and pin dialogs to
// whatever panel spawned them (the "popup touching the URL bar" bug).
export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}
