import { create } from "zustand"

type Toast = { id: number; text: string; kind: "info" | "warn" | "danger" }

type ToastState = {
  toasts: Toast[]
  push: (text: string, kind?: Toast["kind"]) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (text, kind = "info") => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => get().dismiss(id), 4000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export function toast(text: string, kind: Toast["kind"] = "info"): void {
  useToasts.getState().push(text, kind)
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="ms-toasts" role="status">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`ms-toast${t.kind !== "info" ? ` ms-toast--${t.kind}` : ""}`}
          onClick={() => useToasts.getState().dismiss(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
