import { useEffect, useRef } from "react"
import { COMMANDS, GROUPS, bindingOf, loadKeymap, type Command, type CommandGroup } from "./commands.ts"
import { MenuList } from "./ContextMenu.tsx"
import { useUi, type MenuItem } from "./uiStore.ts"
import { useStudio } from "./studioStore.ts"

/** File · Edit · Clip · Sequence · Window · Help — every entry is a registry command. */
export function MenuBar() {
  const open = useUi((s) => s.menuOpen)
  const setOpen = useUi((s) => s.setMenuOpen)
  const barRef = useRef<HTMLDivElement>(null)
  // subscribe so `when`/`checked` re-evaluate as the selection changes
  useStudio((s) => s.selected.length)
  useStudio((s) => s.past.length)
  useUi((s) => s.closed.length)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest(".st-menubar") && !t.closest(".st-menu")) setOpen(null)
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [open, setOpen])

  const keymap = loadKeymap()
  const itemsFor = (group: CommandGroup): MenuItem[] => {
    const cmds = COMMANDS.filter((c) => c.group === group && !c.hidden)
    const out: MenuItem[] = []
    let lastPrefix = ""
    for (const c of cmds) {
      const prefix = c.id.split(".")[1]?.replace(/[A-Z0-9].*$/, "") ?? ""
      if (group === "Sequence" && lastPrefix && prefix !== lastPrefix && ["aspect", "fps", "zoom", "mark", "marker"].includes(prefix)) out.push({ kind: "sep" })
      if (group === "Window" && c.id === "win.maximize") out.push({ kind: "sep" })
      if (group === "Window" && c.id.startsWith("win.layout.") && !out.some((i) => i.kind === "sub")) out.push({ kind: "sep" })
      if (group === "Clip" && ["clip.fade025", "clip.kbNone", "clip.crop", "clip.trackUp"].includes(c.id)) out.push({ kind: "sep" })
      if (group === "Edit" && ["edit.cut", "edit.split", "edit.selectAll", "edit.nudgeLeft"].includes(c.id)) out.push({ kind: "sep" })
      if (group === "File" && c.id === "file.render") out.push({ kind: "sep" })
      lastPrefix = prefix
      out.push(toItem(c, keymap))
    }
    if (group === "Window") {
      const saved = Object.keys(useUi.getState().savedLayouts)
      if (saved.length) out.push({ kind: "sub", label: "Saved layouts", items: saved.map((n) => ({ kind: "item", label: n, checked: useUi.getState().layoutName === n, run: () => useUi.getState().applyPreset(n) })) })
    }
    return out
  }

  return (
    <div ref={barRef} className="st-menubar" role="menubar" onContextMenu={(e) => e.preventDefault()}>
      {GROUPS.map((g) => {
        const isOpen = open === g
        return (
          <div key={g} className="st-menubar__slot">
            <button
              className={`st-menubar__btn${isOpen ? " st-menubar__btn--open" : ""}`}
              onPointerDown={(e) => {
                e.preventDefault()
                setOpen(isOpen ? null : g)
              }}
              onPointerEnter={() => {
                if (open && open !== g) setOpen(g)
              }}
              aria-haspopup="menu"
              aria-expanded={isOpen}
            >
              {g}
            </button>
            {isOpen && <MenuDrop group={g} items={itemsFor(g)} onClose={() => setOpen(null)} />}
          </div>
        )
      })}
    </div>
  )
}

function MenuDrop({ items, onClose, group }: { items: MenuItem[]; onClose: () => void; group: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const parent = ref.current?.parentElement?.getBoundingClientRect()
  useEffect(() => {
    requestAnimationFrame(() => (document.querySelector(".st-menubar .st-menu") as HTMLElement | null)?.focus())
  }, [group])
  return (
    <div ref={ref} className="st-menubar__drop">
      <MenuList items={items} x={parent?.left ?? 0} y={(parent?.bottom ?? 0) + 2} onClose={onClose} />
    </div>
  )
}

export function toItem(c: Command, keymap = loadKeymap()): MenuItem {
  return {
    kind: "item",
    label: c.label,
    shortcut: bindingOf(c, keymap),
    disabled: c.when ? !c.when() : false,
    checked: c.checked ? c.checked() : undefined,
    run: () => c.run(),
  }
}
