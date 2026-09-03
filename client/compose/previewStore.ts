import { create } from "zustand"

// The preview clock, shared between the stage (which owns the media
// elements) and the timeline (which draws the playhead and seeks). The stage
// registers its controller; everyone else reads `clock` and calls `seek`.

export type PreviewCtl = {
  seek: (t: number) => void
  toggle: () => void
  pause: () => void
}

type PreviewState = {
  clock: number
  playing: boolean
  ctl: PreviewCtl | null
  setClock: (t: number) => void
  setPlaying: (p: boolean) => void
  register: (ctl: PreviewCtl | null) => void
}

export const usePreview = create<PreviewState>()((set) => ({
  clock: 0,
  playing: false,
  ctl: null,
  setClock: (clock) => set({ clock }),
  setPlaying: (playing) => set({ playing }),
  register: (ctl) => set({ ctl }),
}))
