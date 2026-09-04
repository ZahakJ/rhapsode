import { useEffect, useRef, useState } from "react"
import { Portal } from "../components/Portal.tsx"
import { prettyChord } from "./commands.ts"
import { useUi, type MenuItem } from "./uiStore.ts"

/**
 * One custom menu for everything: context menus and the menu bar's drop-downs.
 * Keyboard: ↑/↓ move, →/Enter open a submenu or run, ← closes a submenu, Esc
 * closes. Clamped to the viewport. No native menus, no alerts.
 */
export function MenuList({ items, x, y, onClose, depth = 0 }: { items: MenuItem[]; x: number; y: number; onClose: () => void; depth?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [hover, setHover] = useState<number>(-1)
  const [open, setOpen] = useState<number | null>(null)
  const enabled = items.map((it, i) => (it.kind !== "sep" && !("disabled" in it && it.disabled) ? i : -1)).filter((i) => i >= 0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = Math.max(4, Math.min(x, window.innerWidth - r.width - 4))
    const ny = Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y])

  useEffect(() => {
    if (depth > 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".st-menu")) onClose()
    }
    document.addEventListener("keydown", onKey, true)
    document.addEventListener("pointerdown", onDown, true)
    return () => {
      document.removeEventListener("keydown", onKey, true)
      document.removeEventListener("pointerdown", onDown, true)
    }
  }, [depth, onClose])

  const activate = (i: number) => {
    const it = items[i]
    if (!it || it.kind === "sep") return
    if (it.kind === "sub") {
      setOpen(i)
      return
    }
    if (it.disabled) return
    it.run()
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!enabled.length) return
    const cur = enabled.indexOf(hover)
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setHover(enabled[(cur + 1) % enabled.length]!)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setHover(enabled[(cur - 1 + enabled.length) % enabled.length]!)
    } else if (e.key === "Enter" || e.key === "ArrowRight") {
      e.preventDefault()
      if (hover >= 0) activate(hover)
    } else if (e.key === "ArrowLeft" && depth > 0) {
      e.preventDefault()
      onClose()
    }
    e.stopPropagation()
  }

  return (
    <div
      ref={ref}
      className={`st-menu${depth ? " st-menu--sub" : ""}`}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.kind === "sep" ? (
          <div key={i} className="st-menu__sep" />
        ) : (
          <div
            key={i}
            className={`st-menu__item${hover === i ? " st-menu__item--hover" : ""}${"disabled" in it && it.disabled ? " st-menu__item--disabled" : ""}`}
            role="menuitem"
            onPointerEnter={() => {
              setHover(i)
              if (it.kind === "sub") setOpen(i)
              else setOpen(null)
            }}
            onClick={(e) => {
              e.stopPropagation()
              activate(i)
            }}
          >
            <span className="st-menu__check">{it.kind === "item" && it.checked ? "✓" : ""}</span>
            <span className="st-menu__label">{it.label}</span>
            {it.kind === "item" && it.shortcut && <span className="st-menu__key mono">{prettyChord(it.shortcut)}</span>}
            {it.kind === "sub" && <span className="st-menu__arrow">›</span>}
            {it.kind === "sub" && open === i && (
              <SubMenu items={it.items} parent={ref.current} index={i} onClose={onClose} depth={depth + 1} />
            )}
          </div>
        ),
      )}
    </div>
  )
}

function SubMenu({ items, parent, index, onClose, depth }: { items: MenuItem[]; parent: HTMLDivElement | null; index: number; onClose: () => void; depth: number }) {
  const row = parent?.children[index] as HTMLElement | undefined
  const r = row?.getBoundingClientRect()
  const x = r ? r.right + 2 : 0
  const y = r ? r.top - 4 : 0
  return <MenuList items={items} x={x} y={y} onClose={onClose} depth={depth} />
}

/** The app-wide context menu, driven by uiStore.openContextMenu. */
export function ContextMenuHost() {
  const cm = useUi((s) => s.contextMenu)
  const close = useUi((s) => s.closeContextMenu)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (cm) requestAnimationFrame(() => (document.querySelector(".st-menu") as HTMLElement | null)?.focus())
  }, [cm])
  if (!cm) return null
  return (
    <Portal>
      <div ref={ref} className="st-menu-layer">
        <MenuList items={cm.items} x={cm.x} y={cm.y} onClose={close} />
      </div>
    </Portal>
  )
}

/** Attach to any element: right-click or a 500 ms long-press opens `build()`. */
export function contextMenuProps(build: () => MenuItem[]): {
  onContextMenu: (e: React.MouseEvent) => void
  onPointerDown: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerCancel: (e: React.PointerEvent) => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  let start: { x: number; y: number } | null = null
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
    start = null
  }
  return {
    onContextMenu: (e) => {
      e.preventDefault()
      e.stopPropagation()
      useUi.getState().openContextMenu(e.clientX, e.clientY, build())
    },
    onPointerDown: (e) => {
      if (e.pointerType !== "touch") return
      start = { x: e.clientX, y: e.clientY }
      const x = e.clientX
      const y = e.clientY
      timer = setTimeout(() => {
        useUi.getState().openContextMenu(x, y, build())
        clear()
      }, 500)
    },
    onPointerMove: (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
  }
}

/** Right-click only — for elements that own their pointer handlers (clips, the timeline scroll area). */
export function ctxOnly(build: () => MenuItem[]): { onContextMenu: (e: React.MouseEvent) => void } {
  return {
    onContextMenu: (e) => {
      e.preventDefault()
      e.stopPropagation()
      useUi.getState().openContextMenu(e.clientX, e.clientY, build())
    },
  }
}
