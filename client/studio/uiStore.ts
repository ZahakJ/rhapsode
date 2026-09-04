import { create } from "zustand"
import type { Sequence } from "../../shared/sequence.ts"
import type { AnyClip } from "./studioStore.ts"

// Client-only editing state around the sequence: tools, the work area,
// markers, the clipboard, per-track lock/solo flags, monitor overlays, and the
// window layout. None of it changes what the server receives except through
// the render transform in StudioView (work area, solo).

export type Tool = "select" | "razor" | "hand"
export type PanelId = "media" | "monitor" | "timeline" | "inspector" | "subtitles" | "history" | "markers"
export const PANEL_LABEL: Record<PanelId, string> = {
  media: "Media",
  monitor: "Monitor",
  timeline: "Timeline",
  inspector: "Inspector",
  subtitles: "Subtitles",
  history: "History",
  markers: "Markers",
}
export const ALL_PANELS: PanelId[] = ["media", "monitor", "timeline", "inspector", "subtitles", "history", "markers"]

export type Marker = { id: string; at: number; label: string; color: string }
export type ClipboardItem = { kind: "visual" | "audio" | "text"; clip: AnyClip }

export type DockNode =
  | { kind: "split"; dir: "row" | "col"; sizes: number[]; children: DockNode[] }
  | { kind: "group"; id: string; tabs: PanelId[]; active: PanelId }

export type Floating = { id: PanelId; x: number; y: number; w: number; h: number; z: number }

export type MenuItem =
  | { kind: "item"; label: string; shortcut?: string; disabled?: boolean; checked?: boolean; run: () => void }
  | { kind: "sep" }
  | { kind: "sub"; label: string; items: MenuItem[] }

export type ContextMenuState = { x: number; y: number; items: MenuItem[] } | null

const LAYOUT_KEY = "rhapsode:v1:layout"

let gid = 0
const g = (tabs: PanelId[], active?: PanelId): DockNode => ({ kind: "group", id: `g${++gid}_${Math.random().toString(36).slice(2, 6)}`, tabs, active: active ?? tabs[0]! })

export const LAYOUT_PRESETS: Record<string, () => DockNode> = {
  Editing: () => ({
    kind: "split",
    dir: "row",
    sizes: [21, 57, 22],
    children: [g(["media"]), { kind: "split", dir: "col", sizes: [56, 44], children: [g(["monitor"]), g(["timeline"])] }, g(["inspector", "subtitles", "history", "markers"])],
  }),
  Assembly: () => ({
    kind: "split",
    dir: "row",
    sizes: [44, 56],
    children: [g(["media", "markers"]), { kind: "split", dir: "col", sizes: [68, 32], children: [g(["monitor"]), g(["timeline", "inspector"])] }],
  }),
  Captions: () => ({
    kind: "split",
    dir: "col",
    sizes: [62, 38],
    children: [{ kind: "split", dir: "row", sizes: [46, 54], children: [g(["monitor"]), g(["subtitles", "inspector"])] }, g(["timeline", "media"])],
  }),
  Audio: () => ({
    kind: "split",
    dir: "row",
    sizes: [76, 24],
    children: [{ kind: "split", dir: "col", sizes: [30, 70], children: [g(["monitor", "media"]), g(["timeline"])] }, g(["inspector", "history", "markers", "subtitles"])],
  }),
}

export function panelsIn(node: DockNode): PanelId[] {
  return node.kind === "group" ? node.tabs : node.children.flatMap(panelsIn)
}

export type UiState = {
  tool: Tool
  workArea: { in: number; out: number } | null
  markers: Marker[]
  clipboard: ClipboardItem[]
  trackFlags: Record<string, { locked?: boolean; solo?: boolean }>
  safeMargins: boolean
  grid: boolean
  captionsPreview: boolean
  rulers: boolean
  monitorZoom: number
  monitorPan: { x: number; y: number }
  shuttle: number
  shortcutsOpen: boolean
  gotoOpen: boolean
  aboutOpen: boolean
  contextMenu: ContextMenuState
  menuOpen: string | null
  layout: DockNode
  floating: Floating[]
  closed: PanelId[]
  maximized: PanelId | null
  focused: PanelId
  savedLayouts: Record<string, DockNode>
  layoutName: string

  setTool: (t: Tool) => void
  setWorkArea: (w: { in: number; out: number } | null) => void
  markIn: (t: number, D: number) => void
  markOut: (t: number, D: number) => void
  addMarker: (at: number, label?: string, color?: string) => string
  updateMarker: (id: string, p: Partial<Marker>) => void
  removeMarker: (id: string) => void
  setMarkers: (m: Marker[]) => void
  setClipboard: (c: ClipboardItem[]) => void
  toggleFlag: (trackId: string, flag: "locked" | "solo") => void
  toggle: (k: "safeMargins" | "grid" | "captionsPreview" | "rulers") => void
  setMonitorZoom: (z: number, pan?: { x: number; y: number }) => void
  setShuttle: (r: number) => void
  setShortcutsOpen: (o: boolean) => void
  setGotoOpen: (o: boolean) => void
  setAboutOpen: (o: boolean) => void
  openContextMenu: (x: number, y: number, items: MenuItem[]) => void
  closeContextMenu: () => void
  setMenuOpen: (m: string | null) => void
  setLayout: (l: DockNode) => void
  applyPreset: (name: string) => void
  saveLayoutAs: (name: string) => void
  resetLayout: () => void
  setFocused: (p: PanelId) => void
  toggleMaximize: (p?: PanelId) => void
  closePanel: (p: PanelId) => void
  openPanel: (p: PanelId) => void
  floatPanel: (p: PanelId) => void
  dockPanel: (p: PanelId) => void
  updateFloating: (p: PanelId, patch: Partial<Floating>) => void
  raiseFloating: (p: PanelId) => void
  movePanel: (p: PanelId, targetGroup: string, where: "center" | "left" | "right" | "top" | "bottom") => void
  setGroupActive: (groupId: string, p: PanelId) => void
  resize: (path: number[], index: number, delta: number) => void
  equalize: (path: number[]) => void
}

function loadLayout(): Partial<Pick<UiState, "layout" | "floating" | "closed" | "savedLayouts" | "layoutName" | "safeMargins" | "grid">> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return {}
    const j = JSON.parse(raw) as Record<string, unknown>
    const out: Partial<UiState> = {}
    if (j.layout && typeof j.layout === "object") out.layout = j.layout as DockNode
    if (Array.isArray(j.floating)) out.floating = j.floating as Floating[]
    if (Array.isArray(j.closed)) out.closed = j.closed as PanelId[]
    if (j.savedLayouts && typeof j.savedLayouts === "object") out.savedLayouts = j.savedLayouts as Record<string, DockNode>
    if (typeof j.layoutName === "string") out.layoutName = j.layoutName
    if (typeof j.safeMargins === "boolean") out.safeMargins = j.safeMargins
    if (typeof j.grid === "boolean") out.grid = j.grid
    return out
  } catch {
    return {}
  }
}

export function persistLayout(): void {
  const s = useUi.getState()
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ layout: s.layout, floating: s.floating, closed: s.closed, savedLayouts: s.savedLayouts, layoutName: s.layoutName, safeMargins: s.safeMargins, grid: s.grid }))
  } catch {
    /* ignore */
  }
}

/** remove a panel from the tree; collapse empty groups and single-child splits */
export function removePanel(node: DockNode, p: PanelId): DockNode | null {
  if (node.kind === "group") {
    const tabs = node.tabs.filter((t) => t !== p)
    if (!tabs.length) return null
    return { ...node, tabs, active: tabs.includes(node.active) ? node.active : tabs[0]! }
  }
  const kids: DockNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const r = removePanel(c, p)
    if (r) {
      kids.push(r)
      sizes.push(node.sizes[i] ?? 100 / node.children.length)
    }
  })
  if (!kids.length) return null
  if (kids.length === 1) return kids[0]!
  const total = sizes.reduce((a, b) => a + b, 0)
  return { ...node, children: kids, sizes: sizes.map((s) => (s / total) * 100) }
}

function firstGroup(node: DockNode): DockNode & { kind: "group" } {
  if (node.kind === "group") return node
  return firstGroup(node.children[0]!)
}

function lastGroup(node: DockNode): DockNode & { kind: "group" } {
  if (node.kind === "group") return node
  return lastGroup(node.children[node.children.length - 1]!)
}

function insertPanel(node: DockNode, targetGroup: string, p: PanelId, where: "center" | "left" | "right" | "top" | "bottom"): DockNode {
  if (node.kind === "group") {
    if (node.id !== targetGroup) return node
    if (where === "center") return { ...node, tabs: node.tabs.includes(p) ? node.tabs : [...node.tabs, p], active: p }
    const dir = where === "left" || where === "right" ? "row" : "col"
    const fresh = g([p])
    const children = where === "left" || where === "top" ? [fresh, node] : [node, fresh]
    return { kind: "split", dir, sizes: [40, 60].sort(() => (where === "left" || where === "top" ? -1 : 1)), children }
  }
  return { ...node, children: node.children.map((c) => insertPanel(c, targetGroup, p, where)) }
}

function nodeAt(node: DockNode, path: number[]): DockNode {
  let n = node
  for (const i of path) {
    if (n.kind !== "split") break
    n = n.children[i]!
  }
  return n
}

function replaceAt(node: DockNode, path: number[], fn: (n: DockNode) => DockNode): DockNode {
  if (!path.length) return fn(node)
  if (node.kind !== "split") return node
  const [h, ...rest] = path
  return { ...node, children: node.children.map((c, i) => (i === h ? replaceAt(c, rest, fn) : c)) }
}

const loaded = loadLayout()

export const useUi = create<UiState>()((set, get) => ({
  tool: "select",
  workArea: null,
  markers: [],
  clipboard: [],
  trackFlags: {},
  safeMargins: loaded.safeMargins ?? false,
  grid: loaded.grid ?? false,
  captionsPreview: true,
  rulers: false,
  monitorZoom: 1,
  monitorPan: { x: 0, y: 0 },
  shuttle: 0,
  shortcutsOpen: false,
  gotoOpen: false,
  aboutOpen: false,
  contextMenu: null,
  menuOpen: null,
  layout: loaded.layout ?? LAYOUT_PRESETS.Editing!(),
  floating: loaded.floating ?? [],
  closed: loaded.closed ?? [],
  maximized: null,
  focused: "timeline",
  savedLayouts: loaded.savedLayouts ?? {},
  layoutName: loaded.layoutName ?? "Editing",

  setTool: (tool) => set({ tool }),
  setWorkArea: (workArea) => set({ workArea }),
  markIn: (t, D) =>
    set((s) => {
      const out = s.workArea?.out ?? D
      return { workArea: { in: Math.min(t, out - 0.1), out: Math.max(out, t + 0.1) } }
    }),
  markOut: (t, D) =>
    set((s) => {
      const inn = s.workArea?.in ?? 0
      void D
      return { workArea: { in: Math.min(inn, t - 0.1), out: Math.max(t, inn + 0.1) } }
    }),
  addMarker: (at, label = "", color = "7dd3fc") => {
    const id = Math.random().toString(36).slice(2, 9)
    set((s) => ({ markers: [...s.markers, { id, at, label, color }].sort((a, b) => a.at - b.at) }))
    return id
  },
  updateMarker: (id, p) => set((s) => ({ markers: s.markers.map((m) => (m.id === id ? { ...m, ...p } : m)).sort((a, b) => a.at - b.at) })),
  removeMarker: (id) => set((s) => ({ markers: s.markers.filter((m) => m.id !== id) })),
  setMarkers: (markers) => set({ markers }),
  setClipboard: (clipboard) => set({ clipboard }),
  toggleFlag: (trackId, flag) =>
    set((s) => ({ trackFlags: { ...s.trackFlags, [trackId]: { ...s.trackFlags[trackId], [flag]: !s.trackFlags[trackId]?.[flag] } } })),
  toggle: (k) => {
    set((s) => ({ [k]: !s[k] }) as Partial<UiState>)
    persistLayout()
  },
  setMonitorZoom: (monitorZoom, pan) => set((s) => ({ monitorZoom: Math.min(8, Math.max(0.25, monitorZoom)), monitorPan: pan ?? (monitorZoom <= 1 ? { x: 0, y: 0 } : s.monitorPan) })),
  setShuttle: (shuttle) => set({ shuttle }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setGotoOpen: (gotoOpen) => set({ gotoOpen }),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
  openContextMenu: (x, y, items) => set({ contextMenu: { x, y, items }, menuOpen: null }),
  closeContextMenu: () => set({ contextMenu: null }),
  setMenuOpen: (menuOpen) => set({ menuOpen, contextMenu: null }),

  setLayout: (layout) => {
    set({ layout })
    persistLayout()
  },
  applyPreset: (name) => {
    const preset = LAYOUT_PRESETS[name] ?? (get().savedLayouts[name] ? () => JSON.parse(JSON.stringify(get().savedLayouts[name])) as DockNode : null)
    if (!preset) return
    const layout = preset()
    set({ layout, floating: [], maximized: null, closed: ALL_PANELS.filter((p) => !panelsIn(layout).includes(p)), layoutName: name })
    persistLayout()
  },
  saveLayoutAs: (name) => {
    set((s) => ({ savedLayouts: { ...s.savedLayouts, [name]: JSON.parse(JSON.stringify(s.layout)) as DockNode }, layoutName: name }))
    persistLayout()
  },
  resetLayout: () => get().applyPreset("Editing"),
  setFocused: (focused) => set({ focused }),
  toggleMaximize: (p) =>
    set((s) => {
      const target = p ?? s.focused
      return { maximized: s.maximized === target ? null : target }
    }),
  closePanel: (p) => {
    set((s) => {
      const layout = removePanel(s.layout, p) ?? g([])
      return { layout, floating: s.floating.filter((f) => f.id !== p), closed: s.closed.includes(p) ? s.closed : [...s.closed, p], maximized: s.maximized === p ? null : s.maximized }
    })
    persistLayout()
  },
  openPanel: (p) => {
    set((s) => {
      if (panelsIn(s.layout).includes(p) || s.floating.some((f) => f.id === p)) return { closed: s.closed.filter((c) => c !== p) }
      const target = lastGroup(s.layout)
      const layout = target.tabs.length ? insertPanel(s.layout, target.id, p, "center") : g([p])
      return { layout, closed: s.closed.filter((c) => c !== p) }
    })
    persistLayout()
  },
  floatPanel: (p) => {
    set((s) => {
      if (s.floating.some((f) => f.id === p)) return {}
      const layout = removePanel(s.layout, p) ?? g([])
      const z = Math.max(0, ...s.floating.map((f) => f.z)) + 1
      const n = s.floating.length
      return { layout, floating: [...s.floating, { id: p, x: 120 + n * 30, y: 120 + n * 30, w: p === "timeline" ? 820 : p === "monitor" ? 640 : 380, h: p === "monitor" ? 460 : 420, z }], closed: s.closed.filter((c) => c !== p), maximized: null }
    })
    persistLayout()
  },
  dockPanel: (p) => {
    set((s) => {
      const target = lastGroup(s.layout)
      const layout = target.tabs.length ? insertPanel(s.layout, target.id, p, "center") : g([p])
      return { layout, floating: s.floating.filter((f) => f.id !== p) }
    })
    persistLayout()
  },
  updateFloating: (p, patch) => set((s) => ({ floating: s.floating.map((f) => (f.id === p ? { ...f, ...patch } : f)) })),
  raiseFloating: (p) => set((s) => ({ floating: s.floating.map((f) => (f.id === p ? { ...f, z: Math.max(0, ...s.floating.map((x) => x.z)) + 1 } : f)) })),
  movePanel: (p, targetGroup, where) => {
    set((s) => {
      const target = nodeAt(s.layout, []) && findGroup(s.layout, targetGroup)
      if (!target) return {}
      if (where === "center" && target.tabs.includes(p)) return { layout: setActive(s.layout, targetGroup, p) }
      const without = removePanel(s.layout, p) ?? g([])
      const stillThere = findGroup(without, targetGroup)
      const base = stillThere ? without : s.layout
      return { layout: insertPanel(base, targetGroup, p, where), floating: s.floating.filter((f) => f.id !== p) }
    })
    persistLayout()
  },
  setGroupActive: (groupId, p) => set((s) => ({ layout: setActive(s.layout, groupId, p), focused: p })),
  resize: (path, index, delta) => {
    set((s) => ({
      layout: replaceAt(s.layout, path, (n) => {
        if (n.kind !== "split") return n
        const sizes = n.sizes.slice()
        const a = Math.max(8, Math.min(sizes[index]! + sizes[index + 1]! - 8, sizes[index]! + delta))
        const b = sizes[index]! + sizes[index + 1]! - a
        sizes[index] = a
        sizes[index + 1] = b
        return { ...n, sizes }
      }),
    }))
  },
  equalize: (path) => {
    set((s) => ({ layout: replaceAt(s.layout, path, (n) => (n.kind === "split" ? { ...n, sizes: n.children.map(() => 100 / n.children.length) } : n)) }))
    persistLayout()
  },
}))

export function findGroup(node: DockNode, id: string): (DockNode & { kind: "group" }) | null {
  if (node.kind === "group") return node.id === id ? node : null
  for (const c of node.children) {
    const r = findGroup(c, id)
    if (r) return r
  }
  return null
}

function setActive(node: DockNode, id: string, p: PanelId): DockNode {
  if (node.kind === "group") return node.id === id ? { ...node, active: p } : node
  return { ...node, children: node.children.map((c) => setActive(c, id, p)) }
}

export { firstGroup, nodeAt }

/** The sequence the server gets: the work area cut out, soloed tracks honoured. */
export function renderTransform(seq: Sequence, ui: Pick<UiState, "workArea" | "trackFlags">): Sequence {
  let out: Sequence = JSON.parse(JSON.stringify(seq)) as Sequence
  const solos = Object.entries(ui.trackFlags).filter(([, f]) => f.solo).map(([id]) => id)
  if (solos.length) {
    const soloKinds = new Set(out.tracks.filter((t) => solos.includes(t.id)).map((t) => t.kind))
    out.tracks = out.tracks.map((t) => (soloKinds.has(t.kind) && !solos.includes(t.id) ? { ...t, muted: true } : t))
  }
  const wa = ui.workArea
  if (wa) {
    const { in: a, out: b } = wa
    out = {
      ...out,
      duration: Math.max(0.1, Math.round((b - a) * 1000) / 1000),
      tracks: out.tracks.map((t) => {
        const clips = (t.clips as AnyClip[])
          .map((c) => {
            const len = "duration" in c ? c.duration : c.out - c.in
            const s = c.at
            const e = c.at + len
            if (e <= a || s >= b) return null
            const ns = Math.max(s, a)
            const ne = Math.min(e, b)
            const cut = ns - s
            const copy = JSON.parse(JSON.stringify(c)) as AnyClip
            copy.at = Math.round((ns - a) * 1000) / 1000
            if ("duration" in copy) {
              copy.duration = Math.round((ne - ns) * 1000) / 1000
              if ("in" in copy && cut > 0) (copy as { in: number }).in = Math.round(((copy as { in: number }).in + cut) * 1000) / 1000
            } else {
              copy.in = Math.round((copy.in + cut) * 1000) / 1000
              copy.out = Math.round((copy.in + (ne - ns)) * 1000) / 1000
            }
            return copy
          })
          .filter((c): c is AnyClip => !!c)
        return { ...t, clips } as typeof t
      }),
    }
  }
  return out
}
