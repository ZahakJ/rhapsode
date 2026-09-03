import { useEffect, useRef, type ReactNode } from "react"
import { Portal } from "./Portal.tsx"

/** Drag the grab bar this far down and the sheet lets go. */
const DISMISS_PX = 96

/**
 * A bottom sheet — the phone stand-in for a docked rail. The body is a flex
 * column that owns its own scroll, so whatever goes inside (the picker, the
 * inspector) keeps the internal scrolling it already had instead of stretching
 * the page.
 */
export function Sheet({
  title,
  onClose,
  tall = false,
  modal = true,
  children,
}: {
  title: string
  /** a browsing sheet earns the whole screen; an editing one leaves the
   *  canvas visible above it, because you are editing what you can see */
  tall?: boolean
  /** Modal sheets dim what's behind and close on a tap outside. A non-modal
   *  one is a docked panel: the canvas above stays live, so you can type a
   *  caption and then drag it without dismissing anything. Closing is the ✕,
   *  a swipe down, or Escape. */
  modal?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: number; y0: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const offset = (dy: number) => {
    const el = sheetRef.current
    if (el) el.style.transform = dy > 0 ? `translateY(${dy}px)` : ""
  }

  return (
    <Portal>
      <div
        className={`mm-sheet-scrim${modal ? "" : " mm-sheet-scrim--open"}`}
        onClick={modal ? onClose : undefined}
      >
        <div
          ref={sheetRef}
          className={`mm-sheet${tall ? " mm-sheet--tall" : ""}`}
          role="dialog"
          aria-modal={modal}
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="mm-sheet__grab"
            onPointerDown={(e) => {
              dragRef.current = { id: e.pointerId, y0: e.clientY }
              e.currentTarget.setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              if (dragRef.current?.id !== e.pointerId) return
              offset(e.clientY - dragRef.current.y0)
            }}
            onPointerUp={(e) => {
              const drag = dragRef.current
              dragRef.current = null
              if (drag?.id !== e.pointerId) return
              offset(0)
              if (e.clientY - drag.y0 > DISMISS_PX) onClose()
            }}
            onPointerCancel={() => {
              dragRef.current = null
              offset(0)
            }}
          >
            <div className="mm-sheet__grip" />
          </div>
          <div className="mm-sheet__head">
            <span className="mm-sheet__title">{title}</span>
            <button className="ms-btn ms-btn--icon" aria-label="close" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="mm-sheet__body">{children}</div>
        </div>
      </div>
    </Portal>
  )
}
