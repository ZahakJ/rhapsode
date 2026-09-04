import { useRef, useState, type ReactNode } from "react"
import { Portal } from "../components/Portal.tsx"
import { contextMenuProps } from "./ContextMenu.tsx"
import { PANEL_LABEL, persistLayout, useUi, type DockNode, type Floating, type MenuItem, type PanelId } from "./uiStore.ts"

/**
 * The window system: a tree of splits ending in tabbed groups, resizable
 * dividers, tabs that drag between groups (drop in the middle to add a tab,
 * near an edge to split), floating windows with move/resize/z-order, and
 * maximize. Panel bodies are supplied by the view; the dock only arranges.
 */

const DRAG_TYPE = "application/x-rhapsode-panel"

export type PanelRenderers = Record<PanelId, () => ReactNode>

export function Dock({ render }: { render: PanelRenderers }) {
  const layout = useUi((s) => s.layout)
  const maximized = useUi((s) => s.maximized)
  const floating = useUi((s) => s.floating)
  if (maximized) {
    return (
      <div className="dock-root dock-root--max">
        <Group node={{ kind: "group", id: "max", tabs: [maximized], active: maximized }} render={render} path={[]} maximizedView />
        <FloatingLayer render={render} floating={floating} />
      </div>
    )
  }
  return (
    <div className="dock-root">
      <Node node={layout} render={render} path={[]} />
      <FloatingLayer render={render} floating={floating} />
    </div>
  )
}

function Node({ node, render, path }: { node: DockNode; render: PanelRenderers; path: number[] }) {
  if (node.kind === "group") return <Group node={node} render={render} path={path} />
  const isRow = node.dir === "row"
  return (
    <div className={`dock-split dock-split--${node.dir}`}>
      {node.children.map((child, i) => (
        <div key={i} className="dock-split__cell" style={{ flexBasis: `${node.sizes[i] ?? 100 / node.children.length}%` }}>
          <Node node={child} render={render} path={[...path, i]} />
          {i < node.children.length - 1 && <Splitter path={path} index={i} isRow={isRow} />}
        </div>
      ))}
    </div>
  )
}

function Splitter({ path, index, isRow }: { path: number[]; index: number; isRow: boolean }) {
  const drag = useRef<{ id: number; start: number; size: number } | null>(null)
  return (
    <div
      className={`dock-splitter dock-splitter--${isRow ? "v" : "h"}`}
      title="drag to resize · double-click to reset"
      onDoubleClick={() => useUi.getState().equalize(path)}
      onPointerDown={(e) => {
        const parent = (e.currentTarget.parentElement as HTMLElement).parentElement as HTMLElement
        const r = parent.getBoundingClientRect()
        drag.current = { id: e.pointerId, start: isRow ? e.clientX : e.clientY, size: isRow ? r.width : r.height }
        e.currentTarget.setPointerCapture(e.pointerId)
        e.preventDefault()
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        const now = isRow ? e.clientX : e.clientY
        const deltaPct = ((now - d.start) / d.size) * 100
        if (Math.abs(deltaPct) < 0.2) return
        useUi.getState().resize(path, index, deltaPct)
        drag.current = { ...d, start: now }
      }}
      onPointerUp={() => {
        drag.current = null
        persistLayout()
      }}
    />
  )
}

function Group({ node, render, path, maximizedView = false, floatingId }: { node: DockNode & { kind: "group" }; render: PanelRenderers; path: number[]; maximizedView?: boolean; floatingId?: PanelId }) {
  const focused = useUi((s) => s.focused)
  const [over, setOver] = useState<"center" | "left" | "right" | "top" | "bottom" | null>(null)
  const ui = useUi.getState
  const active = node.tabs.includes(node.active) ? node.active : node.tabs[0]
  void path

  const zoneFor = (e: React.DragEvent): "center" | "left" | "right" | "top" | "bottom" => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    if (x < 0.2) return "left"
    if (x > 0.8) return "right"
    if (y < 0.25) return "top"
    if (y > 0.75) return "bottom"
    return "center"
  }

  const tabMenu = (p: PanelId): MenuItem[] => [
    { kind: "item", label: "Float", run: () => ui().floatPanel(p) },
    { kind: "item", label: ui().maximized === p ? "Restore" : "Maximize", shortcut: "Backquote", run: () => ui().toggleMaximize(p) },
    { kind: "sep" },
    { kind: "item", label: "Close panel", run: () => ui().closePanel(p) },
  ]

  return (
    <div
      className={`dock-group${focused === active ? " dock-group--focused" : ""}${over ? ` dock-group--over-${over}` : ""}`}
      onPointerDownCapture={() => active && ui().setFocused(active)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "move"
        const z = zoneFor(e)
        if (z !== over) setOver(z)
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        const p = e.dataTransfer.getData(DRAG_TYPE) as PanelId
        if (!p) return
        e.preventDefault()
        e.stopPropagation()
        const z = zoneFor(e)
        setOver(null)
        if (floatingId) return
        ui().movePanel(p, node.id, z)
      }}
    >
      <div className="dock-tabs" role="tablist">
        {node.tabs.map((p) => (
          <button
            key={p}
            role="tab"
            aria-selected={p === active}
            className={`dock-tab${p === active ? " dock-tab--active" : ""}`}
            draggable={!maximizedView}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, p)
              e.dataTransfer.effectAllowed = "move"
            }}
            onClick={() => (floatingId ? undefined : ui().setGroupActive(node.id, p))}
            onDoubleClick={() => ui().toggleMaximize(p)}
            {...contextMenuProps(() => tabMenu(p))}
          >
            {PANEL_LABEL[p]}
          </button>
        ))}
        <span className="dock-tabs__spacer" />
        {!maximizedView && !floatingId && active && (
          <button className="dock-tabs__btn" title="float" onClick={() => ui().floatPanel(active)}>⧉</button>
        )}
        {floatingId && <button className="dock-tabs__btn" title="dock back" onClick={() => ui().dockPanel(floatingId)}>⇱</button>}
        {active && (
          <button className="dock-tabs__btn" title={ui().maximized ? "restore (`)" : "maximize (`)"} onClick={() => ui().toggleMaximize(active)}>
            {ui().maximized ? "⤡" : "⤢"}
          </button>
        )}
        {active && !maximizedView && <button className="dock-tabs__btn dock-tabs__btn--close" title="close panel" onClick={() => ui().closePanel(active)}>✕</button>}
      </div>
      <div className="dock-body">{active ? render[active]() : <div className="rh-hint dock-empty">empty group — drag a tab here, or reopen a panel from Window</div>}</div>
      {over && <div className={`dock-drop dock-drop--${over}`} />}
    </div>
  )
}

function FloatingLayer({ render, floating }: { render: PanelRenderers; floating: Floating[] }) {
  if (!floating.length) return null
  return (
    <Portal>
      {floating.map((f) => (
        <FloatingWindow key={f.id} f={f} render={render} />
      ))}
    </Portal>
  )
}

function FloatingWindow({ f, render }: { f: Floating; render: PanelRenderers }) {
  const drag = useRef<{ id: number; kind: "move" | "size"; x0: number; y0: number; f: Floating } | null>(null)
  const ui = useUi.getState
  const start = (kind: "move" | "size") => (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return
    drag.current = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, f: { ...f } }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    ui().raiseFloating(f.id)
    e.preventDefault()
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x0
    const dy = e.clientY - d.y0
    if (d.kind === "move") ui().updateFloating(f.id, { x: Math.max(0, Math.min(window.innerWidth - 80, d.f.x + dx)), y: Math.max(40, Math.min(window.innerHeight - 40, d.f.y + dy)) })
    else ui().updateFloating(f.id, { w: Math.max(240, d.f.w + dx), h: Math.max(160, d.f.h + dy) })
  }
  const up = () => {
    drag.current = null
    persistLayout()
  }
  return (
    <div className="dock-float" style={{ left: f.x, top: f.y, width: f.w, height: f.h, zIndex: 60 + f.z }} onPointerDownCapture={() => ui().raiseFloating(f.id)}>
      <div className="dock-float__bar" onPointerDown={start("move")} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <Group node={{ kind: "group", id: `float-${f.id}`, tabs: [f.id], active: f.id }} render={render} path={[]} floatingId={f.id} />
      </div>
      <div className="dock-float__grip" onPointerDown={start("size")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="resize" />
    </div>
  )
}
