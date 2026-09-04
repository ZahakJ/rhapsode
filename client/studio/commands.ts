import { toast } from "../components/Toasts.tsx"
import { navigate } from "../router.ts"
import { clamp, fmtTime } from "../util/time.ts"
import { KB_PRESETS, clipLength, contentEnd, duration, findClip, useStudio, type AnyClip } from "./studioStore.ts"
import { ALL_PANELS, LAYOUT_PRESETS, PANEL_LABEL, useUi, type PanelId } from "./uiStore.ts"
import type { VisualClip } from "../../shared/sequence.ts"

// One registry drives the menu bar, the context menus and the keyboard, so a
// label always shows the shortcut that actually fires it. Shortcuts are
// "Mod+Shift+KeyZ"-style strings over KeyboardEvent.code; the user's map lives
// in rhapsode:v1:keys and overrides the defaults per command id.

export type CommandGroup = "File" | "Edit" | "Clip" | "Sequence" | "Window" | "Help" | "Transport" | "Tools"

export type Command = {
  id: string
  label: string
  group: CommandGroup
  shortcut?: string
  /** a second binding that also fires it */
  alt?: string
  when?: () => boolean
  checked?: () => boolean
  run: () => void
  /** hidden from menus (keyboard only) */
  hidden?: boolean
}

const KEYS_KEY = "rhapsode:v1:keys"
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

/** hooks the view registers so commands can reach things only it owns */
export const hooks: { render: () => void; saveProject: () => void; openProject: () => void; importSrt: () => void; snapshot: () => void; zoomToFit: () => void } = {
  render: () => {},
  saveProject: () => {},
  openProject: () => {},
  importSrt: () => {},
  snapshot: () => {},
  zoomToFit: () => {},
}

const st = () => useStudio.getState()
const ui = () => useUi.getState()
const sel = () => st().selected
const primary = () => {
  const s = st()
  return s.primary ? findClip(s.seq, s.primary) : null
}
const hasSel = () => sel().length > 0
const primaryVisual = () => primary()?.track.kind === "visual"
const primaryStill = () => {
  const f = primary()
  if (!f || f.track.kind !== "visual") return false
  return st().sources[(f.clip as VisualClip).source]?.media === "image"
}
const locked = (trackId: string) => !!ui().trackFlags[trackId]?.locked
const unlockedSel = () => {
  const s = st()
  return s.selected.filter((id) => {
    const f = findClip(s.seq, id)
    return f && !locked(f.track.id)
  })
}
const frame = () => 1 / st().seq.canvas.fps

function patchPrimaryVisual(p: Partial<VisualClip>) {
  const f = primary()
  if (!f || f.track.kind !== "visual") return
  st().patchClip(f.clip.id, p)
}

function setFocusedTool(t: "select" | "razor" | "hand") {
  ui().setTool(t)
  toast(`${t} tool`)
}

export const COMMANDS: Command[] = [
  // ——— File ———
  { id: "file.new", label: "New project", group: "File", shortcut: "Mod+Alt+KeyN", run: () => { st().newProject(); ui().setWorkArea(null); ui().setMarkers([]); toast("new project") } },
  { id: "file.open", label: "Open project…", group: "File", shortcut: "Mod+KeyO", run: () => hooks.openProject() },
  { id: "file.save", label: "Save project", group: "File", shortcut: "Mod+KeyS", run: () => hooks.saveProject() },
  { id: "file.importSrt", label: "Import subtitles (.srt)…", group: "File", run: () => hooks.importSrt() },
  { id: "file.render", label: "Render", group: "File", shortcut: "Mod+Enter", run: () => hooks.render() },
  { id: "file.wall", label: "Go to the wall", group: "File", run: () => navigate("#/wall") },

  // ——— Edit ———
  { id: "edit.undo", label: "Undo", group: "Edit", shortcut: "Mod+KeyZ", when: () => st().past.length > 0, run: () => st().undo() },
  { id: "edit.redo", label: "Redo", group: "Edit", shortcut: "Mod+Shift+KeyZ", alt: "Mod+KeyY", when: () => st().future.length > 0, run: () => st().redo() },
  { id: "edit.cut", label: "Cut", group: "Edit", shortcut: "Mod+KeyX", when: hasSel, run: () => { const ids = unlockedSel(); ui().setClipboard(st().copySelection(ids)); st().removeClips(ids); toast(`cut ${ids.length}`) } },
  { id: "edit.copy", label: "Copy", group: "Edit", shortcut: "Mod+KeyC", when: hasSel, run: () => { ui().setClipboard(st().copySelection(sel())); toast(`copied ${sel().length}`) } },
  { id: "edit.paste", label: "Paste at playhead", group: "Edit", shortcut: "Mod+KeyV", when: () => ui().clipboard.length > 0, run: () => { const n = st().pasteAt(ui().clipboard, st().playhead, st().selectedTrack); toast(`pasted ${n.length}`) } },
  { id: "edit.duplicate", label: "Duplicate", group: "Edit", shortcut: "Mod+KeyD", when: hasSel, run: () => st().duplicateClips(unlockedSel()) },
  { id: "edit.delete", label: "Delete (lift)", group: "Edit", shortcut: "Delete", alt: "Backspace", when: hasSel, run: () => st().removeClips(unlockedSel()) },
  { id: "edit.rippleDelete", label: "Ripple delete", group: "Edit", shortcut: "Shift+Delete", alt: "Shift+Backspace", when: hasSel, run: () => st().rippleDelete(unlockedSel()) },
  { id: "edit.split", label: "Split at playhead", group: "Edit", shortcut: "KeyS", alt: "Mod+KeyK", when: () => !!st().primary, run: () => { const s = st(); if (s.primary) s.splitAt(s.primary, s.playhead) } },
  { id: "edit.rippleTrimPrev", label: "Ripple trim head to playhead", group: "Edit", shortcut: "KeyQ", when: () => !!st().primary, run: () => { const s = st(); if (s.primary) s.rippleTrim(s.primary, s.playhead, "prev") } },
  { id: "edit.rippleTrimNext", label: "Ripple trim tail to playhead", group: "Edit", shortcut: "KeyW", when: () => !!st().primary, run: () => { const s = st(); if (s.primary) s.rippleTrim(s.primary, s.playhead, "next") } },
  { id: "edit.selectAll", label: "Select all on track", group: "Edit", shortcut: "Mod+KeyA", run: () => st().selectAllOnTrack(st().selectedTrack) },
  { id: "edit.deselect", label: "Deselect all", group: "Edit", shortcut: "Mod+Shift+KeyA", run: () => st().select(null) },
  { id: "edit.markClip", label: "Select clip at playhead", group: "Edit", shortcut: "KeyX", run: () => {
      const s = st()
      const t = s.playhead
      const tracks = s.selectedTrack ? s.seq.tracks.filter((x) => x.id === s.selectedTrack) : [...s.seq.tracks].reverse()
      for (const tr of tracks) for (const c of tr.clips as AnyClip[]) if (c.at <= t && c.at + clipLength(tr, c) > t) { s.select(c.id); return }
      toast("no clip under the playhead", "warn")
    } },
  { id: "edit.nudgeLeft", label: "Nudge selection −1 frame", group: "Edit", shortcut: "BracketLeft", when: hasSel, run: () => st().nudge(unlockedSel(), -frame()) },
  { id: "edit.nudgeRight", label: "Nudge selection +1 frame", group: "Edit", shortcut: "BracketRight", when: hasSel, run: () => st().nudge(unlockedSel(), frame()) },
  { id: "edit.nudgeLeft1s", label: "Nudge selection −1 s", group: "Edit", shortcut: "Shift+BracketLeft", when: hasSel, run: () => st().nudge(unlockedSel(), -1), hidden: true },
  { id: "edit.nudgeRight1s", label: "Nudge selection +1 s", group: "Edit", shortcut: "Shift+BracketRight", when: hasSel, run: () => st().nudge(unlockedSel(), 1), hidden: true },

  // ——— Clip ———
  { id: "clip.fit", label: "Fit (letterbox)", group: "Clip", when: primaryVisual, checked: () => (primary()?.clip as VisualClip | undefined)?.fit === "contain", run: () => patchPrimaryVisual({ fit: "contain" }) },
  { id: "clip.fill", label: "Fill (crop to canvas)", group: "Clip", when: primaryVisual, checked: () => (primary()?.clip as VisualClip | undefined)?.fit === "cover", run: () => patchPrimaryVisual({ fit: "cover" }) },
  { id: "clip.free", label: "Free box", group: "Clip", when: primaryVisual, checked: () => (primary()?.clip as VisualClip | undefined)?.fit === "free", run: () => { const c = primary()?.clip as VisualClip | undefined; patchPrimaryVisual({ fit: "free", box: c?.box ?? { x: 0.55, y: 0.05, w: 0.4 } }) } },
  { id: "clip.fade025", label: "Fades 0.25 s", group: "Clip", when: primaryVisual, run: () => patchPrimaryVisual({ fadeIn: 0.25, fadeOut: 0.25 }) },
  { id: "clip.fade05", label: "Fades 0.5 s", group: "Clip", when: primaryVisual, run: () => patchPrimaryVisual({ fadeIn: 0.5, fadeOut: 0.5 }) },
  { id: "clip.fade1", label: "Fades 1 s", group: "Clip", when: primaryVisual, run: () => patchPrimaryVisual({ fadeIn: 1, fadeOut: 1 }) },
  { id: "clip.fade0", label: "No fades", group: "Clip", when: primaryVisual, run: () => patchPrimaryVisual({ fadeIn: 0, fadeOut: 0 }) },
  { id: "clip.kbNone", label: "Pan & zoom: none", group: "Clip", when: primaryStill, run: () => patchPrimaryVisual({ kenBurns: undefined }) },
  { id: "clip.kbIn", label: "Pan & zoom: zoom in", group: "Clip", when: primaryStill, run: () => patchPrimaryVisual({ kenBurns: { ...KB_PRESETS.zoomIn } }) },
  { id: "clip.kbOut", label: "Pan & zoom: zoom out", group: "Clip", when: primaryStill, run: () => patchPrimaryVisual({ kenBurns: { ...KB_PRESETS.zoomOut } }) },
  { id: "clip.kbRight", label: "Pan & zoom: pan →", group: "Clip", when: primaryStill, run: () => patchPrimaryVisual({ kenBurns: { ...KB_PRESETS.panRight } }) },
  { id: "clip.kbLeft", label: "Pan & zoom: pan ←", group: "Clip", when: primaryStill, run: () => patchPrimaryVisual({ kenBurns: { ...KB_PRESETS.panLeft } }) },
  { id: "clip.crop", label: "Crop / rotate…", group: "Clip", when: primaryVisual, run: () => document.dispatchEvent(new CustomEvent("rh:open-crop")) },
  { id: "clip.centre", label: "Centre on canvas", group: "Clip", when: primaryVisual, run: () => { const c = primary()?.clip as VisualClip | undefined; if (!c) return; if (c.fit === "free" && c.box) { const t = { ...(c.transform ?? { x: 0, y: 0, scale: 1, rotate: 0 }), x: 0, y: 0 }; const src = st().sources[c.source]; const a = src && src.width && src.height ? src.width / src.height : 16 / 9; const boxH = (c.box.w * (16 / 9)) / a; patchPrimaryVisual({ box: { ...c.box, x: (1 - c.box.w) / 2, y: (1 - boxH) / 2 }, transform: t }) } else patchPrimaryVisual({ transform: { ...(c.transform ?? { x: 0, y: 0, scale: 1, rotate: 0 }), x: 0, y: 0 } }) } },
  { id: "clip.resetMotion", label: "Reset motion", group: "Clip", when: primaryVisual, run: () => patchPrimaryVisual({ transform: undefined }) },
  { id: "clip.resetLook", label: "Reset look", group: "Clip", when: primaryVisual, run: () => patchPrimaryVisual({ look: undefined }) },
  { id: "clip.trackUp", label: "Move to track above", group: "Clip", shortcut: "Mod+ArrowUp", when: hasSel, run: () => st().moveSelectionTrack(unlockedSel(), 1) },
  { id: "clip.trackDown", label: "Move to track below", group: "Clip", shortcut: "Mod+ArrowDown", when: hasSel, run: () => st().moveSelectionTrack(unlockedSel(), -1) },
  { id: "clip.front", label: "Bring track to front", group: "Clip", shortcut: "Mod+Shift+ArrowUp", when: () => !!(st().selectedTrack || primary()), run: () => { const t = primary()?.track.id ?? st().selectedTrack; if (t) st().trackToEdge(t, "front") } },
  { id: "clip.back", label: "Send track to back", group: "Clip", shortcut: "Mod+Shift+ArrowDown", when: () => !!(st().selectedTrack || primary()), run: () => { const t = primary()?.track.id ?? st().selectedTrack; if (t) st().trackToEdge(t, "back") } },

  // ——— Sequence ———
  { id: "seq.addVisual", label: "Add video track", group: "Sequence", run: () => st().addTrack("visual") },
  { id: "seq.addAudio", label: "Add audio track", group: "Sequence", run: () => st().addTrack("audio") },
  { id: "seq.addText", label: "Add text track", group: "Sequence", run: () => st().addTrack("text") },
  { id: "seq.pin", label: "Pin sequence length", group: "Sequence", checked: () => !!st().seq.duration, run: () => { const s = st(); s.setDuration(s.seq.duration ? undefined : Math.max(1, Math.round(contentEnd(s.seq)))) } },
  { id: "seq.aspect169", label: "Canvas 16:9", group: "Sequence", checked: () => st().seq.canvas.aspect === "16:9", run: () => st().setCanvas({ aspect: "16:9" }) },
  { id: "seq.aspect916", label: "Canvas 9:16", group: "Sequence", checked: () => st().seq.canvas.aspect === "9:16", run: () => st().setCanvas({ aspect: "9:16" }) },
  { id: "seq.aspect11", label: "Canvas 1:1", group: "Sequence", checked: () => st().seq.canvas.aspect === "1:1", run: () => st().setCanvas({ aspect: "1:1" }) },
  { id: "seq.aspect45", label: "Canvas 4:5", group: "Sequence", checked: () => st().seq.canvas.aspect === "4:5", run: () => st().setCanvas({ aspect: "4:5" }) },
  { id: "seq.fps24", label: "24 fps", group: "Sequence", checked: () => st().seq.canvas.fps === 24, run: () => st().setCanvas({ fps: 24 }) },
  { id: "seq.fps25", label: "25 fps", group: "Sequence", checked: () => st().seq.canvas.fps === 25, run: () => st().setCanvas({ fps: 25 }) },
  { id: "seq.fps30", label: "30 fps", group: "Sequence", checked: () => st().seq.canvas.fps === 30, run: () => st().setCanvas({ fps: 30 }) },
  { id: "seq.fps60", label: "60 fps", group: "Sequence", checked: () => st().seq.canvas.fps === 60, run: () => st().setCanvas({ fps: 60 }) },
  { id: "seq.zoomFit", label: "Zoom to fit", group: "Sequence", shortcut: "Backslash", run: () => hooks.zoomToFit() },
  { id: "seq.zoomIn", label: "Zoom in", group: "Sequence", shortcut: "Equal", run: () => st().setZoom(st().zoom * 1.25) },
  { id: "seq.zoomOut", label: "Zoom out", group: "Sequence", shortcut: "Minus", run: () => st().setZoom(st().zoom / 1.25) },
  { id: "seq.snap", label: "Snap", group: "Sequence", shortcut: "KeyN", checked: () => st().snap, run: () => st().setSnap(!st().snap) },
  { id: "seq.safe", label: "Safe margins", group: "Sequence", checked: () => ui().safeMargins, run: () => ui().toggle("safeMargins") },
  { id: "seq.grid", label: "Grid", group: "Sequence", checked: () => ui().grid, run: () => ui().toggle("grid") },
  { id: "seq.markIn", label: "Mark work-area in", group: "Sequence", shortcut: "KeyI", run: () => ui().markIn(st().playhead, duration(st().seq)) },
  { id: "seq.markOut", label: "Mark work-area out", group: "Sequence", shortcut: "KeyO", run: () => ui().markOut(st().playhead, duration(st().seq)) },
  { id: "seq.clearWork", label: "Clear work area", group: "Sequence", shortcut: "Alt+KeyX", when: () => !!ui().workArea, run: () => ui().setWorkArea(null) },
  { id: "seq.marker", label: "Add marker", group: "Sequence", shortcut: "KeyM", run: () => { ui().addMarker(st().playhead, ""); toast(`marker at ${fmtTime(st().playhead)}`) } },
  { id: "seq.editMarker", label: "Edit marker at playhead", group: "Sequence", shortcut: "Shift+KeyM", run: () => document.dispatchEvent(new CustomEvent("rh:edit-marker")) },
  { id: "seq.goto", label: "Go to time…", group: "Sequence", shortcut: "KeyG", run: () => ui().setGotoOpen(true) },

  // ——— Window ———
  ...ALL_PANELS.map<Command>((p) => ({
    id: `win.${p}`,
    label: PANEL_LABEL[p],
    group: "Window",
    checked: () => !ui().closed.includes(p),
    run: () => (ui().closed.includes(p) ? ui().openPanel(p) : ui().closePanel(p)),
  })),
  { id: "win.maximize", label: "Maximize focused panel", group: "Window", shortcut: "Backquote", checked: () => !!ui().maximized, run: () => ui().toggleMaximize() },
  { id: "win.focusNext", label: "Focus next panel", group: "Window", shortcut: "Tab", hidden: true, run: () => {
      const open = ALL_PANELS.filter((p) => !ui().closed.includes(p))
      const i = open.indexOf(ui().focused)
      ui().setFocused(open[(i + 1) % open.length] ?? "timeline")
    } },
  ...Object.keys(LAYOUT_PRESETS).map<Command>((name) => ({
    id: `win.layout.${name}`,
    label: `Layout: ${name}`,
    group: "Window",
    checked: () => ui().layoutName === name,
    run: () => ui().applyPreset(name),
  })),
  { id: "win.saveLayout", label: "Save current layout as…", group: "Window", run: () => document.dispatchEvent(new CustomEvent("rh:save-layout")) },
  { id: "win.resetLayout", label: "Reset layout", group: "Window", run: () => ui().resetLayout() },

  // ——— Help ———
  { id: "help.keys", label: "Keyboard shortcuts", group: "Help", shortcut: "Shift+Slash", run: () => ui().setShortcutsOpen(!ui().shortcutsOpen) },
  { id: "help.about", label: "About Rhapsode", group: "Help", run: () => ui().setAboutOpen(true) },

  // ——— Transport (keyboard-only, listed in the cheat sheet) ———
  { id: "tr.play", label: "Play / pause", group: "Transport", shortcut: "Space", run: () => { ui().setShuttle(0); st().setPlaying(!st().playing) } },
  { id: "tr.k", label: "Stop (K)", group: "Transport", shortcut: "KeyK", run: () => { ui().setShuttle(0); st().setPlaying(false) } },
  { id: "tr.l", label: "Shuttle forward (L, again = 2×, 4×)", group: "Transport", shortcut: "KeyL", run: () => { const r = ui().shuttle; ui().setShuttle(r <= 0 ? 1 : r >= 4 ? 4 : r * 2); st().setPlaying(true) } },
  { id: "tr.j", label: "Shuttle backward (J, again = 2×, 4×)", group: "Transport", shortcut: "KeyJ", run: () => { const r = ui().shuttle; ui().setShuttle(r >= 0 ? -1 : r <= -4 ? -4 : r * 2); st().setPlaying(true) } },
  { id: "tr.frameL", label: "One frame back", group: "Transport", shortcut: "ArrowLeft", run: () => st().setPlayhead(st().playhead - frame()) },
  { id: "tr.frameR", label: "One frame forward", group: "Transport", shortcut: "ArrowRight", run: () => st().setPlayhead(st().playhead + frame()) },
  { id: "tr.frames5L", label: "Five frames back", group: "Transport", shortcut: "Shift+ArrowLeft", run: () => st().setPlayhead(st().playhead - 5 * frame()) },
  { id: "tr.frames5R", label: "Five frames forward", group: "Transport", shortcut: "Shift+ArrowRight", run: () => st().setPlayhead(st().playhead + 5 * frame()) },
  { id: "tr.secL", label: "One second back", group: "Transport", shortcut: "Alt+ArrowLeft", run: () => st().setPlayhead(st().playhead - 1) },
  { id: "tr.secR", label: "One second forward", group: "Transport", shortcut: "Alt+ArrowRight", run: () => st().setPlayhead(st().playhead + 1) },
  { id: "tr.home", label: "Go to start", group: "Transport", shortcut: "Home", run: () => st().setPlayhead(0) },
  { id: "tr.end", label: "Go to end", group: "Transport", shortcut: "End", run: () => st().setPlayhead(duration(st().seq)) },
  { id: "tr.prevEdit", label: "Previous edit point", group: "Transport", shortcut: "ArrowUp", run: () => { const t = st().playhead; const p = [...st().editPoints()].reverse().find((x) => x < t - 0.001); if (p !== undefined) st().setPlayhead(p) } },
  { id: "tr.nextEdit", label: "Next edit point", group: "Transport", shortcut: "ArrowDown", run: () => { const t = st().playhead; const p = st().editPoints().find((x) => x > t + 0.001); if (p !== undefined) st().setPlayhead(p) } },

  // ——— Tools ———
  { id: "tool.select", label: "Selection tool", group: "Tools", shortcut: "KeyV", checked: () => ui().tool === "select", run: () => setFocusedTool("select") },
  { id: "tool.razor", label: "Razor tool", group: "Tools", shortcut: "KeyC", checked: () => ui().tool === "razor", run: () => setFocusedTool("razor") },
  { id: "tool.hand", label: "Hand tool", group: "Tools", shortcut: "KeyH", checked: () => ui().tool === "hand", run: () => setFocusedTool("hand") },
  { id: "tool.escape", label: "Cancel / deselect", group: "Tools", shortcut: "Escape", hidden: true, run: () => {
      const u = ui()
      if (u.contextMenu) return u.closeContextMenu()
      if (u.menuOpen) return u.setMenuOpen(null)
      if (u.shortcutsOpen) return u.setShortcutsOpen(false)
      if (u.gotoOpen) return u.setGotoOpen(false)
      if (u.aboutOpen) return u.setAboutOpen(false)
      if (u.maximized) return u.toggleMaximize(u.maximized)
      if (u.tool !== "select") return u.setTool("select")
      st().select(null)
    } },
]

export const byId = new Map(COMMANDS.map((c) => [c.id, c]))

// ——— keymap ———

export function loadKeymap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEYS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** the effective binding for a command (user override wins) */
export function bindingOf(cmd: Command, overrides = loadKeymap()): string | undefined {
  return overrides[cmd.id] ?? cmd.shortcut
}

/** KeyboardEvent → "Mod+Shift+KeyX" */
export function chordOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push("Mod")
  if (e.shiftKey) parts.push("Shift")
  if (e.altKey) parts.push("Alt")
  parts.push(e.code)
  return parts.join("+")
}

const CODE_LABEL: Record<string, string> = {
  Space: "Space", Enter: "↵", Escape: "Esc", Delete: "⌦", Backspace: "⌫", Tab: "⇥", Home: "Home", End: "End",
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Backquote: "`", Backslash: "\\", Equal: "=", Minus: "−",
  BracketLeft: "[", BracketRight: "]", Slash: "/", Comma: ",", Period: ".",
}

/** "Mod+Shift+KeyZ" → "⇧⌘Z" (mac) / "Ctrl+Shift+Z" */
export function prettyChord(chord: string | undefined): string {
  if (!chord) return ""
  const parts = chord.split("+")
  const code = parts.pop()!
  let key = CODE_LABEL[code] ?? (code.startsWith("Key") ? code.slice(3) : code.startsWith("Digit") ? code.slice(5) : code)
  if (chord === "Shift+Slash") return "?"
  const mods = parts
  if (isMac) {
    return `${mods.includes("Alt") ? "⌥" : ""}${mods.includes("Shift") ? "⇧" : ""}${mods.includes("Mod") ? "⌘" : ""}${key}`
  }
  const names = mods.map((m) => (m === "Mod" ? "Ctrl" : m))
  return [...names, key].join("+")
}

/** resolve a key event to a command; the first whose `when` passes wins */
export function commandForEvent(e: KeyboardEvent, overrides = loadKeymap()): Command | null {
  const chord = chordOf(e)
  for (const c of COMMANDS) {
    const b = bindingOf(c, overrides)
    if ((b === chord || c.alt === chord) && (!c.when || c.when())) return c
  }
  return null
}

export function run(id: string): void {
  const c = byId.get(id)
  if (!c) return
  if (c.when && !c.when()) return
  c.run()
}

export const GROUPS: CommandGroup[] = ["File", "Edit", "Clip", "Sequence", "Window", "Help"]
export const CHEAT_GROUPS: CommandGroup[] = ["Transport", "Tools", "Edit", "Clip", "Sequence", "Window", "File", "Help"]

export { clamp }
