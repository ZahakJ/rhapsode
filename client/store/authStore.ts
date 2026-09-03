import { create } from "zustand"
import { persist } from "zustand/middleware"

type AuthState = {
  /** the invite passphrase, remembered locally once verified */
  key: string | null
  verified: boolean
  setKey: (key: string) => void
  clearKey: () => void
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      key: null,
      verified: false,
      setKey: (key) => set({ key, verified: true }),
      clearKey: () => set({ key: null, verified: false }),
    }),
    { name: "rhapsode:v1:auth" },
  ),
)
