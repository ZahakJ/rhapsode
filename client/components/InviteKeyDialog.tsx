import { useState } from "react"
import { useAuth } from "../store/authStore.ts"
import { api } from "../api/client.ts"
import { toast } from "./Toasts.tsx"
import { Portal } from "./Portal.tsx"

/** Header button showing key status; opens the passphrase dialog. */
export function InviteKeyButton() {
  const verified = useAuth((s) => s.verified)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className={`ms-btn${verified ? " ms-btn--active" : " ms-btn--ghost"}`}
        onClick={() => setOpen(true)}
        title={verified ? "Invite key saved — you can render" : "Enter the invite key to render"}
      >
        {verified ? "◈ keyed in" : "◇ guest"}
      </button>
      {open && <InviteKeyDialog onClose={() => setOpen(false)} />}
    </>
  )
}

export function InviteKeyDialog({ onClose }: { onClose: () => void }) {
  const { verified, setKey, clearKey } = useAuth()
  // keyed-in users get a status view, not another password box
  const [entering, setEntering] = useState(!verified)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    try {
      const ok = await api.verifyKey(value.trim())
      if (ok) {
        setKey(value.trim())
        toast("Key accepted — the forge is yours ◈")
        onClose()
      } else {
        toast("That key was rejected", "danger")
      }
    } catch {
      toast("Could not reach the server", "danger")
    } finally {
      setBusy(false)
    }
  }

  const logout = () => {
    clearKey()
    toast("Logged out — you're a guest again")
    onClose()
  }

  return (
    <Portal>
      <div className="mm-scrim" onClick={onClose}>
        <div className="mm-dialog ms-panel" onClick={(e) => e.stopPropagation()}>
          <div className="ms-panel__header">Invite key</div>
          <div className="ms-panel__body mm-dialog__body">
            {verified && !entering ? (
              <>
                <p className="mm-dialog__hint">
                  <span style={{ color: "var(--accent)" }}>◈ You're keyed in.</span> Adding sources,
                  rendering, remixing and deleting are all unlocked on this browser.
                </p>
                <div className="mm-dialog__row">
                  <button className="ms-btn ms-btn--danger" onClick={logout}>
                    Log out
                  </button>
                  <button className="ms-btn ms-btn--ghost" onClick={() => setEntering(true)}>
                    use a different key
                  </button>
                  <div style={{ flex: 1 }} />
                  <button className="ms-btn ms-btn--primary" onClick={onClose}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mm-dialog__hint">
                  Anyone can watch. Adding sources and rendering need the invite key.
                </p>
                <div className="ms-search">
                  <input
                    type="password"
                    placeholder="the passphrase…"
                    value={value}
                    autoFocus
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submit()
                      if (e.key === "Escape") onClose()
                    }}
                  />
                </div>
                <div className="mm-dialog__row">
                  {verified && (
                    <button className="ms-btn ms-btn--ghost" onClick={() => setEntering(false)}>
                      ← back
                    </button>
                  )}
                  <div style={{ flex: 1 }} />
                  <button className="ms-btn ms-btn--ghost" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    className="ms-btn ms-btn--primary"
                    disabled={busy || !value.trim()}
                    onClick={() => void submit()}
                  >
                    {busy ? "Checking…" : "Unlock"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Portal>
  )
}
