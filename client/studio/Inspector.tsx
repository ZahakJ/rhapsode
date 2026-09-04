import { useEffect, useRef, useState } from "react"
import type { Edit } from "../../shared/recipe.ts"
import type { AudioClip, Cue, VisualClip } from "../../shared/sequence.ts"
import { CropPanel } from "../compose/CropPanel.tsx"
import { isRealEdit } from "../store/composeStore.ts"
import { clamp, fmtTime } from "../util/time.ts"
import { NumField, NumInput, Section, Seg, TimeField } from "./fields.tsx"
import { NEUTRAL_T } from "./Gizmo.tsx"
import { NEUTRAL_LOOK } from "./studioStore.ts"
import { KB_PRESETS, clipLength, findClip, useStudio } from "./studioStore.ts"

/** Everything about the selected clip (or track), in typed, exact fields. */
export function Inspector() {
  const seq = useStudio((s) => s.seq)
  const primary = useStudio((s) => s.primary)
  const selectedTrack = useStudio((s) => s.selectedTrack)
  const sources = useStudio((s) => s.sources)
  const found = primary ? findClip(seq, primary) : null

  if (!found) {
    const track = selectedTrack ? seq.tracks.find((t) => t.id === selectedTrack) : undefined
    return (
      <div className="st-inspector">
        {track ? (
          <Section title={`${track.kind} track`}>
            <p className="rh-hint">“{track.name}” · {track.clips.length} {track.kind === "text" ? "cues" : "clips"}{track.muted ? " · muted" : ""}</p>
            <p className="rh-hint">select a clip to edit it. double-click a track name to rename; M mutes.</p>
          </Section>
        ) : (
          <Section title="inspector">
            <p className="rh-hint">select a clip on the timeline, or a cue on the monitor.</p>
            <p className="rh-hint mono st-keys">space · ←→ frame · ⇧ 1s · S split · ⌘D dup · ⌫ delete · ⌘Z undo</p>
          </Section>
        )}
      </div>
    )
  }

  const { track, clip } = found
  const visualTracks = seq.tracks.filter((t) => t.kind === "visual")
  const layer = track.kind === "visual" ? `layer ${visualTracks.indexOf(track) + 1} of ${visualTracks.length}` : undefined
  if (track.kind === "visual") return <VisualInspector clip={clip as VisualClip} srcName={sources[(clip as VisualClip).source]?.title} layer={layer} />
  if (track.kind === "audio") return <AudioInspector clip={clip as AudioClip} srcName={sources[(clip as AudioClip).source]?.title} />
  return <CueInspector cue={clip as Cue} />
}

function VisualInspector({ clip, srcName, layer }: { clip: VisualClip; srcName?: string; layer?: string }) {
  const [cropOpen, setCropOpen] = useState(false)
  useEffect(() => {
    const open = () => setCropOpen(true)
    document.addEventListener("rh:open-crop", open)
    return () => document.removeEventListener("rh:open-crop", open)
  }, [])
  const patch = useStudio((s) => s.patchClip)
  const sources = useStudio((s) => s.sources)
  const src = sources[clip.source]
  const isVideo = src?.media === "video"
  const srcDur = src?.duration ?? Infinity
  const set = (p: Partial<VisualClip>) => patch(clip.id, p)
  const kbName = (Object.keys(KB_PRESETS) as Array<keyof typeof KB_PRESETS>).find((k) => JSON.stringify(KB_PRESETS[k]) === JSON.stringify(clip.kenBurns)) ?? (clip.kenBurns ? "custom" : "none")

  return (
    <div className="st-inspector">
      <Section title={isVideo ? "video clip" : "still"} right={<span className="rh-hint st-inspector__src">{layer ? `${layer} · ` : ""}{srcName}</span>}>
        <div className="st-grid2">
          <TimeField label="starts at" value={clip.at} onCommit={(t) => set({ at: t })} />
          <TimeField label="duration" value={clip.duration} onCommit={(t) => set({ duration: clamp(t, 0.1, isVideo ? Math.max(0.1, srcDur - clip.in) : 600) })} min={0.1} />
          {isVideo && <TimeField label="source in" value={clip.in} onCommit={(t) => set({ in: clamp(t, 0, Math.max(0, srcDur - 0.1)) })} max={srcDur} />}
          {isVideo && <div className="st-field st-field--ro"><span className="st-field__label">source</span><span className="mono">{fmtTime(srcDur)}</span></div>}
        </div>
      </Section>
      <Section title="placement">
        <Seg value={clip.fit} onChange={(fit) => set({ fit, box: fit === "free" ? (clip.box ?? { x: 0.55, y: 0.05, w: 0.4 }) : clip.box })} options={[{ v: "contain", l: "fit" }, { v: "cover", l: "fill" }, { v: "free", l: "free box" }]} />
        {clip.fit === "free" && clip.box && (
          <div className="st-grid3">
            <NumField label="x" value={clip.box.x} min={-0.9} max={0.95} step={0.005} onCommit={(x) => set({ box: { ...clip.box!, x } })} fmt={(v) => `${Math.round(v * 100)}%`} />
            <NumField label="y" value={clip.box.y} min={-0.9} max={0.95} step={0.005} onCommit={(y) => set({ box: { ...clip.box!, y } })} fmt={(v) => `${Math.round(v * 100)}%`} />
            <NumField label="width" value={clip.box.w} min={0.05} max={2} step={0.005} onCommit={(w) => set({ box: { ...clip.box!, w } })} fmt={(v) => `${Math.round(v * 100)}%`} />
          </div>
        )}
        <div className="rh-row">
          <button className="ms-btn ms-btn--small" onClick={() => setCropOpen(true)}>crop / rotate…</button>
          {isRealEdit(clip.edit ?? null) && <span className="rh-hint">edited{clip.edit?.crop ? " · crop" : ""}{clip.edit?.rotate ? ` · ↻${clip.edit.rotate}` : ""}{clip.edit?.flipH ? " · ↔" : ""}</span>}
        </div>
      </Section>
      <Section title="look">
        <NumField label="opacity" value={clip.opacity} min={0} max={1} step={0.01} onCommit={(opacity) => set({ opacity })} fmt={(v) => `${Math.round(v * 100)}%`} />
        <div className="st-grid2">
          <NumField label="fade in" value={clip.fadeIn} min={0} max={5} step={0.1} onCommit={(fadeIn) => set({ fadeIn })} suffix=" s" />
          <NumField label="fade out" value={clip.fadeOut} min={0} max={5} step={0.1} onCommit={(fadeOut) => set({ fadeOut })} suffix=" s" />
        </div>
        {isVideo && <NumField label="clip sound" value={clip.volume} min={0} max={2} step={0.05} onCommit={(volume) => set({ volume })} fmt={(v) => (v === 0 ? "muted" : `${Math.round(v * 100)}%`)} />}
      </Section>
      <Section title="motion" right={clip.transform ? <button className="st-tl__hb" onClick={() => set({ transform: undefined })} title="reset motion">↺</button> : undefined}>
        <div className="st-grid2">
          <NumInput label="x" value={(clip.transform ?? NEUTRAL_T).x * 100} min={-200} max={200} step={1} unit="%" neutral={0} onCommit={(v) => set({ transform: { ...(clip.transform ?? NEUTRAL_T), x: v / 100 } })} />
          <NumInput label="y" value={(clip.transform ?? NEUTRAL_T).y * 100} min={-200} max={200} step={1} unit="%" neutral={0} onCommit={(v) => set({ transform: { ...(clip.transform ?? NEUTRAL_T), y: v / 100 } })} />
          <NumInput label="scale" value={(clip.transform ?? NEUTRAL_T).scale * 100} min={5} max={800} step={1} unit="%" neutral={100} onCommit={(v) => set({ transform: { ...(clip.transform ?? NEUTRAL_T), scale: v / 100 } })} />
          <NumInput label="rotation" value={(clip.transform ?? NEUTRAL_T).rotate} min={-360} max={360} step={1} unit="°" neutral={0} digits={1} onCommit={(v) => set({ transform: { ...(clip.transform ?? NEUTRAL_T), rotate: v } })} />
        </div>
        <p className="rh-hint">drag the box on the monitor · handles scale · the knob rotates · double-click resets</p>
      </Section>
      <Section title="look" right={<span className="st-presets st-presets--tight">
        {([["none", NEUTRAL_LOOK], ["punchy", { ...NEUTRAL_LOOK, contrast: 1.18, saturation: 1.25, vignette: 0.25 }], ["faded", { ...NEUTRAL_LOOK, contrast: 0.85, saturation: 0.7, brightness: 0.08, gamma: 1.15 }], ["mono", { ...NEUTRAL_LOOK, grayscale: true, contrast: 1.12, vignette: 0.3 }]] as const).map(([n, l]) => (
          <button key={n} className="st-tl__hb st-tl__hb--wide" onClick={() => set({ look: n === "none" ? undefined : { ...l } })}>{n}</button>
        ))}
      </span>}>
        <div className="st-look">
          <NumField label="brightness" value={(clip.look ?? NEUTRAL_LOOK).brightness} min={-1} max={1} step={0.01} onCommit={(brightness) => set({ look: { ...(clip.look ?? NEUTRAL_LOOK), brightness } })} fmt={(v) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}`} />
          <NumField label="contrast" value={(clip.look ?? NEUTRAL_LOOK).contrast} min={0} max={3} step={0.01} onCommit={(contrast) => set({ look: { ...(clip.look ?? NEUTRAL_LOOK), contrast } })} fmt={(v) => `${Math.round(v * 100)}%`} />
          <NumField label="saturation" value={(clip.look ?? NEUTRAL_LOOK).saturation} min={0} max={3} step={0.01} onCommit={(saturation) => set({ look: { ...(clip.look ?? NEUTRAL_LOOK), saturation } })} fmt={(v) => `${Math.round(v * 100)}%`} />
          <NumField label="gamma" value={(clip.look ?? NEUTRAL_LOOK).gamma} min={0.1} max={4} step={0.01} onCommit={(gamma) => set({ look: { ...(clip.look ?? NEUTRAL_LOOK), gamma } })} fmt={(v) => v.toFixed(2)} />
          <NumField label="blur" value={(clip.look ?? NEUTRAL_LOOK).blur} min={0} max={50} step={0.5} onCommit={(blur) => set({ look: { ...(clip.look ?? NEUTRAL_LOOK), blur } })} fmt={(v) => `${v}px`} />
          <NumField label="vignette" value={(clip.look ?? NEUTRAL_LOOK).vignette} min={0} max={1} step={0.01} onCommit={(vignette) => set({ look: { ...(clip.look ?? NEUTRAL_LOOK), vignette } })} fmt={(v) => `${Math.round(v * 100)}%`} />
          <label className="st-toggle st-toggle--look">
            <input type="checkbox" checked={(clip.look ?? NEUTRAL_LOOK).grayscale} onChange={(e) => set({ look: { ...(clip.look ?? NEUTRAL_LOOK), grayscale: e.target.checked } })} /> black & white
          </label>
          {clip.look && <button className="ms-btn ms-btn--small ms-btn--ghost" onClick={() => set({ look: undefined })}>reset look</button>}
        </div>
        <p className="rh-hint">preview approximates the look; gamma shows only in the render</p>
      </Section>
      {!isVideo && src && (
        <Section title="pan & zoom" right={<span className="rh-hint">{kbName}</span>}>
          <div className="st-presets">
            {(["none", "zoomIn", "zoomOut", "panRight", "panLeft"] as const).map((k) => (
              <button key={k} className={`ms-btn ms-btn--small${kbName === k ? " ms-btn--active" : ""}`} onClick={() => set({ kenBurns: KB_PRESETS[k] ? { ...KB_PRESETS[k]! } : undefined })}>
                {k === "none" ? "none" : k === "zoomIn" ? "zoom in" : k === "zoomOut" ? "zoom out" : k === "panRight" ? "pan →" : "pan ←"}
              </button>
            ))}
          </div>
          {clip.kenBurns && <KenBurnsEditor clip={clip} thumb={src.proxyUrl ?? src.thumbUrl ?? ""} aspect={(src.width || 4) / (src.height || 3)} />}
        </Section>
      )}
      {cropOpen && src && (
        <CropPanel
          source={src}
          edit={clip.edit ?? null}
          onClose={() => setCropOpen(false)}
          onDone={(e: Edit | null) => {
            set({ edit: e ?? undefined })
            setCropOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** Two windows over the still — where the view starts and where it ends. Drag to move, corner to resize. */
function KenBurnsEditor({ clip, thumb, aspect }: { clip: VisualClip; thumb: string; aspect: number }) {
  const patch = useStudio((s) => s.patchClip)
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; which: "from" | "to"; kind: "move" | "size"; x0: number; y0: number; win: { x: number; y: number; w: number } } | null>(null)
  const kb = clip.kenBurns!
  const start = (which: "from" | "to", kind: "move" | "size") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    useStudio.getState().snapshot()
    drag.current = { id: e.pointerId, which, kind, x0: e.clientX, y0: e.clientY, win: { ...kb[which] } }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const el = ref.current
    if (!d || d.id !== e.pointerId || !el) return
    const r = el.getBoundingClientRect()
    const dx = (e.clientX - d.x0) / r.width
    const dy = (e.clientY - d.y0) / r.height
    let win = { ...d.win }
    if (d.kind === "move") win = { ...win, x: clamp(d.win.x + dx, 0, 1 - d.win.w), y: clamp(d.win.y + dy, 0, 1 - d.win.w) }
    else {
      const w = clamp(d.win.w + dx, 0.1, 1)
      win = { x: clamp(d.win.x, 0, 1 - w), y: clamp(d.win.y, 0, 1 - w), w }
    }
    useStudio.getState().mutate((seq) => {
      for (const t of seq.tracks)
        if (t.kind === "visual")
          for (const c of t.clips) if (c.id === clip.id && c.kenBurns) c.kenBurns[d.which] = win
    })
  }
  const up = () => (drag.current = null)
  void patch
  return (
    <div ref={ref} className="st-kbed" style={{ aspectRatio: `${aspect}` }}>
      <img src={thumb} alt="" draggable={false} />
      {(["from", "to"] as const).map((which) => {
        const w = kb[which]
        return (
          <div key={which} className={`st-kbed__win st-kbed__win--${which}`} style={{ left: `${w.x * 100}%`, top: `${w.y * 100}%`, width: `${w.w * 100}%`, height: `${w.w * 100}%` }} onPointerDown={start(which, "move")} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            <span className="st-kbed__tag mono">{which === "from" ? "start" : "end"}</span>
            <span className="st-kbed__grip" onPointerDown={start(which, "size")} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          </div>
        )
      })}
    </div>
  )
}

function AudioInspector({ clip, srcName }: { clip: AudioClip; srcName?: string }) {
  const patch = useStudio((s) => s.patchClip)
  const fitMusic = useStudio((s) => s.fitMusic)
  const src = useStudio((s) => s.sources[clip.source])
  const srcDur = src?.duration ?? Infinity
  const set = (p: Partial<AudioClip>) => patch(clip.id, p)
  return (
    <div className="st-inspector">
      <Section title="audio clip" right={<span className="rh-hint st-inspector__src">{srcName}</span>}>
        <div className="st-grid2">
          <TimeField label="starts at" value={clip.at} onCommit={(t) => set({ at: t })} />
          <div className="st-field st-field--ro"><span className="st-field__label">length</span><span className="mono">{fmtTime(clip.out - clip.in)}</span></div>
          <TimeField label="source in" value={clip.in} onCommit={(t) => set({ in: clamp(t, 0, clip.out - 0.1) })} />
          <TimeField label="source out" value={clip.out} onCommit={(t) => set({ out: clamp(t, clip.in + 0.1, srcDur) })} />
        </div>
        <button className="ms-btn ms-btn--small" onClick={() => fitMusic(clip.id)} title="trim to the end of the sequence with a 2 s fade">fit to sequence</button>
      </Section>
      <Section title="level">
        <NumField label="gain" value={clip.gain} min={0} max={2} step={0.05} onCommit={(gain) => set({ gain })} fmt={(v) => `${Math.round(v * 100)}%`} />
        <div className="st-grid2">
          <NumField label="fade in" value={clip.fadeIn} min={0} max={10} step={0.1} onCommit={(fadeIn) => set({ fadeIn })} suffix=" s" />
          <NumField label="fade out" value={clip.fadeOut} min={0} max={10} step={0.1} onCommit={(fadeOut) => set({ fadeOut })} suffix=" s" />
        </div>
      </Section>
    </div>
  )
}

function CueInspector({ cue }: { cue: Cue }) {
  const patch = useStudio((s) => s.patchClip)
  const set = (p: Partial<Cue>) => patch(cue.id, p)
  return (
    <div className="st-inspector">
      <Section title="text cue">
        <textarea className="rh-textarea st-cue-text" rows={2} maxLength={300} value={cue.text} onChange={(e) => set({ text: e.target.value })} onKeyDown={(e) => e.stopPropagation()} placeholder="the line" />
        <textarea className="rh-textarea st-cue-text st-cue-text--sub" rows={2} maxLength={300} value={cue.sub ?? ""} onChange={(e) => set({ sub: e.target.value || undefined })} onKeyDown={(e) => e.stopPropagation()} placeholder="second line — a translation, a name…" />
        <div className="st-grid2">
          <TimeField label="starts at" value={cue.at} onCommit={(t) => set({ at: t })} />
          <TimeField label="duration" value={cue.duration} onCommit={(t) => set({ duration: clamp(t, 0.1, 600) })} min={0.1} />
        </div>
      </Section>
      <Section title="style">
        <Seg value={cue.style} onChange={(style) => set({ style })} options={[{ v: "outline", l: "outline" }, { v: "clean", l: "clean" }, { v: "box", l: "box" }]} />
        <NumField label="size" value={cue.size} min={0.02} max={0.2} step={0.005} onCommit={(size) => set({ size })} fmt={(v) => `${Math.round(v * 100)}%`} />
        <Seg value={cue.align} onChange={(align) => set({ align })} options={[{ v: "left", l: "left" }, { v: "center", l: "center" }, { v: "right", l: "right" }]} />
        <div className="st-grid2">
          <NumField label="x" value={cue.x} min={0} max={1} step={0.005} onCommit={(x) => set({ x })} fmt={(v) => `${Math.round(v * 100)}%`} />
          <NumField label="y" value={cue.y} min={0} max={1} step={0.005} onCommit={(y) => set({ y })} fmt={(v) => `${Math.round(v * 100)}%`} />
        </div>
        <div className="st-grid2">
          <label className="st-color"><span className="st-field__label">colour</span><input type="color" value={`#${cue.color}`} onChange={(e) => set({ color: e.target.value.slice(1) })} /></label>
          <label className="st-color"><span className="st-field__label">second line</span><input type="color" value={`#${cue.subColor}`} onChange={(e) => set({ subColor: e.target.value.slice(1) })} /></label>
        </div>
        <p className="rh-hint">drag the text on the monitor to place it</p>
      </Section>
    </div>
  )
}

export function selectionSummary(): string {
  const s = useStudio.getState()
  if (!s.primary) return ""
  const f = findClip(s.seq, s.primary)
  return f ? `${fmtTime(f.clip.at)} → ${fmtTime(f.clip.at + clipLength(f.track, f.clip))}` : ""
}
