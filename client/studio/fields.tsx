import { useEffect, useState } from "react"
import { fmtTC, parseClock } from "../util/time.ts"

/** A mono timecode field: shows m:ss.mmm, accepts ss / m:ss / m:ss.s / h:mm:ss, commits on Enter or blur. */
export function TimeField({ label, value, onCommit, min = 0, max, compact = false }: { label?: string; value: number; onCommit: (t: number) => void; min?: number; max?: number; compact?: boolean }) {
  const [text, setText] = useState(fmtTC(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(fmtTC(value))
  }, [value, editing])
  const commit = () => {
    setEditing(false)
    const t = parseClock(text)
    if (!Number.isFinite(t)) {
      setText(fmtTC(value))
      return
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min, t))
    onCommit(clamped)
    setText(fmtTC(clamped))
  }
  return (
    <label className={`st-field${compact ? " st-field--compact" : ""}`}>
      {label && <span className="st-field__label">{label}</span>}
      <input
        className="st-field__input mono"
        value={text}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur()
          if (e.key === "Escape") {
            setText(fmtTC(value))
            ;(e.currentTarget as HTMLInputElement).blur()
          }
          e.stopPropagation()
        }}
      />
    </label>
  )
}

export function NumField({ label, value, onCommit, min, max, step = 0.01, suffix, fmt }: { label: string; value: number; onCommit: (v: number) => void; min: number; max: number; step?: number; suffix?: string; fmt?: (v: number) => string }) {
  return (
    <label className="st-range">
      <span className="st-range__label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onCommit(Number(e.target.value))} />
      <span className="st-range__value mono">{fmt ? fmt(value) : `${Math.round(value * 100) / 100}${suffix ?? ""}`}</span>
    </label>
  )
}

export function Seg<T extends string>({ label, value, options, onChange }: { label?: string; value: T; options: Array<{ v: T; l: string }>; onChange: (v: T) => void }) {
  return (
    <div className="st-seg">
      {label && <span className="st-field__label">{label}</span>}
      <div className="ms-seg">
        {options.map((o) => (
          <button key={o.v} type="button" className={`ms-seg__opt${o.v === value ? " ms-seg__opt--active" : ""}`} onClick={() => onChange(o.v)}>
            {o.l}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="st-section">
      <div className="st-section__head">
        <span className="st-section__title">{title}</span>
        {right}
      </div>
      {children}
    </section>
  )
}

export const hasArabic = (s: string): boolean => /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(s)
