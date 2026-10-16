// Time strings as people and agents type them: 12.5, 1:02.3, 01:02:03.5,
// 1500ms, 12s. Ranges: "12-20", "1:00-1:05", "12+3" (start + length).

export function parseTime(v: string | number): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) throw new Error(`bad time: ${v}`)
    return v
  }
  const s = v.trim()
  let t: number
  if (/^\d+(\.\d+)?ms$/.test(s)) t = Number(s.slice(0, -2)) / 1000
  else if (/^\d+(\.\d+)?s$/.test(s)) t = Number(s.slice(0, -1))
  else if (/^\d+(\.\d+)?$/.test(s)) t = Number(s)
  else if (/^(\d+:){1,2}\d+(\.\d+)?$/.test(s)) t = s.split(":").reduce((acc, p) => acc * 60 + Number(p), 0)
  else throw new Error(`bad time: "${v}" (use 12.5, 1:02.3, 01:02:03, 1500ms)`)
  if (!Number.isFinite(t)) throw new Error(`bad time: "${v}"`)
  return t
}

export type Range = { start: number; end: number }

export function parseRange(v: string | { from: string | number; to: string | number }): Range {
  let start: number
  let end: number
  if (typeof v === "object") {
    start = parseTime(v.from)
    end = parseTime(v.to)
  } else {
    const plus = v.indexOf("+")
    if (plus > 0) {
      start = parseTime(v.slice(0, plus))
      end = start + parseTime(v.slice(plus + 1))
    } else {
      const dash = v.indexOf("-")
      if (dash <= 0) throw new Error(`bad range: "${v}" (use 12-20, 1:00-1:05 or 12+3)`)
      start = parseTime(v.slice(0, dash))
      end = parseTime(v.slice(dash + 1))
    }
  }
  if (!(end > start)) throw new Error(`empty range: ${start}-${end}`)
  return { start, end }
}

/** "67ms", "0.067", "15fps" → seconds between frames */
export function parseInterval(v: string | number): number {
  if (typeof v === "string" && /fps$/i.test(v.trim())) {
    const fps = Number(v.trim().slice(0, -3))
    if (!(fps > 0)) throw new Error(`bad rate: "${v}"`)
    return 1 / fps
  }
  const t = parseTime(v)
  if (!(t > 0)) throw new Error(`interval must be > 0: "${v}"`)
  return t
}

/** 62.3 → "00:01:02.300" */
export function fmtTime(t: number): string {
  const ms = Math.round(t * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor(ms / 60_000) % 60
  const s = Math.floor(ms / 1000) % 60
  const r = ms % 1000
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${p(h)}:${p(m)}:${p(s)}.${p(r, 3)}`
}

/** sortable file-name stamp: 62.3 → "0062.300" */
export function stamp(t: number): string {
  return (Math.round(t * 1000) / 1000).toFixed(3).padStart(8, "0")
}
