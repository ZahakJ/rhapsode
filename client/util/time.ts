/** m:ss.s — the short clock */
export function fmtTime(s: number, tenths = true): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  const whole = Math.floor(sec)
  const t = Math.floor((sec - whole) * 10)
  const mm = String(m)
  const ss = String(whole).padStart(2, "0")
  return tenths ? `${mm}:${ss}.${t}` : `${mm}:${ss}`
}

/** m:ss.mmm — the timecode readout (the cutting room's signature) */
export function fmtTC(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  const whole = Math.floor(sec)
  const ms = Math.round((sec - whole) * 1000)
  const msFixed = ms === 1000 ? 999 : ms
  return `${m}:${String(whole).padStart(2, "0")}.${String(msFixed).padStart(3, "0")}`
}

/** h:mm:ss for long sources */
export function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const mm = String(m).padStart(h ? 2 : 1, "0")
  const ss = String(sec).padStart(2, "0")
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** "1:23", "83", "83.4", "1:02:03.5" → seconds; NaN when unparsable */
export function parseClock(raw: string): number {
  const parts = raw
    .trim()
    .replace(/\s+/g, "")
    .replace(/s$/i, "")
    .split(":")
  if (parts.length === 0 || parts.length > 3) return NaN
  if (parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return NaN
  let total = 0
  for (const p of parts) total = total * 60 + Number(p)
  return total
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
export const round1 = (n: number): number => Math.round(n * 10) / 10
export const round3 = (n: number): number => Math.round(n * 1000) / 1000

/** true when a keystroke is headed for a text field, so shortcuts must stay out */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable
}
