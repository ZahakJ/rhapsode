import { useEffect, useState } from "react"
import type { JobDto, RenderDto, SourceDto } from "../../shared/recipe.ts"
import { MAX_CAPTIONS, OUT_MAX_SECONDS } from "../../shared/recipe.ts"
import { api } from "../api/client.ts"
import { useAuth } from "../store/authStore.ts"
import { useCompose, saveDraft, readDraft, applyDraft, clearDraft, validateRecipe } from "../store/composeStore.ts"
import { toast } from "../components/Toasts.tsx"
import { InviteKeyDialog } from "../components/InviteKeyDialog.tsx"
import { navigate } from "../router.ts"
import { usePhone } from "../usePhone.ts"
import { SourcePicker } from "./SourcePicker.tsx"
import { Trimmer } from "./Trimmer.tsx"
import { Stage } from "./Stage.tsx"
import { JobProgress } from "./JobProgress.tsx"
import { clamp, fmtTime, round1 } from "../util/time.ts"

type Step = "sources" | "cut" | "compose"

export function ComposeView() {
  const phone = usePhone()
  const s = useCompose()
  const verified = useAuth((x) => x.verified)
  const [step, setStep] = useState<Step>("sources")
  const [keyOpen, setKeyOpen] = useState(false)
  const [renderJob, setRenderJob] = useState<{ job: JobDto; slug: string } | null>(null)
  const [restored, setRestored] = useState(false)

  // restore a draft once, only if its sources still exist server-side
  useEffect(() => {
    if (restored) return
    setRestored(true)
    if (s.base || s.overlay) return
    const draft = readDraft()
    if (!draft || (!draft.baseId && !draft.overlayId)) return
    const get = (id: string | null): Promise<SourceDto | null> =>
      id ? api.getSource(id).then((x) => (x.status === "ready" ? x : null)).catch(() => null) : Promise.resolve(null)
    void Promise.all([get(draft.baseId), get(draft.overlayId)]).then(([b, o]) => {
      if (!b && !o) return
      applyDraft(draft, b, o)
      if (b && o) setStep("compose")
      toast("draft restored")
    })
  }, [restored, s.base, s.overlay])

  // persist on every change (cheap; the draft is tiny)
  useEffect(() => {
    const unsub = useCompose.subscribe(() => saveDraft())
    return unsub
  }, [])

  const ready = !!s.base && !!s.overlay
  const D = s.outputDuration()

  const render = async () => {
    if (!verified) {
      setKeyOpen(true)
      return
    }
    const v = validateRecipe()
    if (!v.ok) {
      toast(v.error, "warn")
      return
    }
    try {
      const res = await api.createRender(v.recipe, s.title.trim() || undefined)
      setRenderJob(res)
    } catch (e) {
      toast(e instanceof Error ? e.message : "render failed", "danger")
    }
  }

  const onRendered = (result: unknown) => {
    const r = result as RenderDto | undefined
    const slug = r?.slug ?? renderJob?.slug
    setRenderJob(null)
    clearDraft()
    if (slug) navigate(`#/r/${encodeURIComponent(slug)}`)
  }

  const sourcesPanel = (
    <div className="rh-col">
      <SourcePicker slot="base" source={s.base} onSource={(x) => s.setBase(x)} allowImage />
      <SourcePicker slot="overlay" source={s.overlay} onSource={(x) => s.setOverlay(x)} allowImage={false} />
      {phone && ready && (
        <button className="ms-btn ms-btn--primary rh-next" onClick={() => setStep("cut")}>
          next — cut the pieces →
        </button>
      )}
    </div>
  )

  const cutPanel = (
    <div className="rh-col">
      {s.base?.media === "video" && (
        <Trimmer
          source={s.base}
          inT={s.baseIn}
          outT={s.baseOut}
          onChange={(a, b) => s.patch({ baseIn: a, baseOut: b, at: clamp(s.at, 0, Math.max(0, b - a - 0.1)) })}
          label="the base"
        />
      )}
      {s.base?.media === "image" && s.overlay && (
        <div className="rh-field">
          <label className="rh-field__label">the photo stays up for</label>
          <div className="rh-row">
            <div className="ms-search rh-grow">
              <input
                inputMode="decimal"
                placeholder={`${fmtTime(s.ovOut - s.ovIn)} (the clip's length)`}
                value={s.imageDuration ?? ""}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  s.patch({ imageDuration: e.target.value === "" || !Number.isFinite(n) || n <= 0 ? null : Math.min(OUT_MAX_SECONDS, n) })
                }}
              />
            </div>
            <span className="rh-hint">seconds</span>
          </div>
        </div>
      )}
      {s.overlay && (
        <Trimmer
          source={s.overlay}
          inT={s.ovIn}
          outT={s.ovOut}
          onChange={(a, b) => s.patch({ ovIn: a, ovOut: b })}
          label="the clip on top"
          hint={s.mode.kind === "dub" ? "dub uses only this clip's sound; its picture is not shown" : undefined}
        />
      )}
      {phone && ready && (
        <button className="ms-btn ms-btn--primary rh-next" onClick={() => setStep("compose")}>
          next — compose →
        </button>
      )}
    </div>
  )

  const composePanel = (
    <div className="rh-col">
      <Stage />
      <Controls />
      <div className="rh-renderbar">
        <div className="ms-search rh-grow">
          <input
            placeholder="a title (optional)"
            value={s.title}
            maxLength={120}
            onChange={(e) => s.patch({ title: e.target.value })}
          />
        </div>
        <button
          className="ms-btn ms-btn--primary rh-renderbtn"
          disabled={!ready || !!renderJob || D <= 0 || D > OUT_MAX_SECONDS}
          onClick={() => void render()}
        >
          {verified ? "render ◈" : "render — needs the key"}
        </button>
      </div>
      {renderJob && (
        <div className="rh-renderjob ms-panel">
          <div className="ms-panel__body">
            <JobProgress
              job={renderJob.job}
              onDone={onRendered}
              onFail={(err) => {
                toast(err, "danger")
                setRenderJob(null)
              }}
            />
            <p className="rh-hint">
              you can leave this screen — the render finishes on its own; it will appear on the wall as{" "}
              <span className="mono">{renderJob.slug}</span>
            </p>
          </div>
        </div>
      )}
    </div>
  )

  if (phone) {
    return (
      <div className="rh-compose rh-compose--phone">
        <div className="rh-steps">
          {(["sources", "cut", "compose"] as Step[]).map((k, i) => (
            <button
              key={k}
              className={`rh-steps__tab${step === k ? " rh-steps__tab--active" : ""}`}
              disabled={k !== "sources" && !ready}
              onClick={() => setStep(k)}
            >
              <span className="rh-steps__n mono">{i + 1}</span>
              {k === "sources" ? "pieces" : k === "cut" ? "cut" : "compose"}
            </button>
          ))}
        </div>
        <div className="rh-compose__scroll">
          {step === "sources" && sourcesPanel}
          {step === "cut" && cutPanel}
          {step === "compose" && composePanel}
        </div>
        {keyOpen && <InviteKeyDialog onClose={() => setKeyOpen(false)} />}
      </div>
    )
  }

  return (
    <div className="rh-compose">
      <div className="rh-compose__left">
        {sourcesPanel}
        {ready && cutPanel}
      </div>
      <div className="rh-compose__right">
        {ready ? (
          composePanel
        ) : (
          <div className="ms-empty rh-compose__empty">
            <div className="rh-compose__glyph">🎼</div>
            <div className="ms-empty__title">stitch a piece of one thing onto another</div>
            <div>pick a base and a clip on the left; cut them; lay one over the other; render; share the link.</div>
          </div>
        )}
      </div>
      {keyOpen && <InviteKeyDialog onClose={() => setKeyOpen(false)} />}
    </div>
  )
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="rh-seg" role="group" aria-label={label}>
      {label && <span className="rh-seg__label">{label}</span>}
      <div className="ms-seg">
        {options.map((o) => (
          <button key={o.v} className={`ms-seg__opt${o.v === value ? " ms-seg__opt--active" : ""}`} onClick={() => onChange(o.v)}>
            {o.l}
          </button>
        ))}
      </div>
    </div>
  )
}

function Range({ label, value, min, max, step, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <label className="ms-slider">
      <span className="ms-slider__label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="ms-slider__value">{fmt ? fmt(value) : value}</span>
    </label>
  )
}

function Controls() {
  const s = useCompose()
  const D = s.outputDuration()
  const baseIsVideo = s.base?.media === "video"
  const sel = s.selectedCaption
  const cap = sel !== null ? s.captions[sel] : undefined

  return (
    <div className="rh-controls">
      <Seg
        label="mode"
        value={s.mode.kind}
        onChange={(k) => s.setMode(k)}
        options={[
          { v: "dub", l: "dub" },
          { v: "pip", l: "picture-in-picture" },
          { v: "stack", l: "stack" },
        ]}
      />
      {s.mode.kind === "stack" && (
        <Seg
          label="clip goes"
          value={s.mode.dir}
          onChange={(dir) => s.patch({ mode: { kind: "stack", dir } })}
          options={[
            { v: "top", l: "top" },
            { v: "bottom", l: "bottom" },
            { v: "left", l: "left" },
            { v: "right", l: "right" },
          ]}
        />
      )}
      {s.mode.kind === "pip" && (
        <Range label="box width" value={s.mode.box.w} min={0.1} max={1} step={0.01}
          onChange={(w) => s.mode.kind === "pip" && s.patch({ mode: { kind: "pip", box: { ...s.mode.box, w: clamp(w, 0.1, 1 - s.mode.box.x) } } })}
          fmt={(v) => `${Math.round(v * 100)}%`} />
      )}

      <div className="rh-controls__row">
        <Seg
          label="canvas"
          value={s.output.aspect}
          onChange={(aspect) => s.patch({ output: { ...s.output, aspect } })}
          options={[
            { v: "source", l: "source" },
            { v: "9:16", l: "9:16" },
            { v: "1:1", l: "1:1" },
            { v: "16:9", l: "16:9" },
          ]}
        />
        <Seg
          label="fit"
          value={s.output.fit}
          onChange={(fit) => s.patch({ output: { ...s.output, fit } })}
          options={[
            { v: "contain", l: "contain" },
            { v: "cover", l: "cover" },
          ]}
        />
      </div>

      {D > 0 && (
        <Range
          label="clip starts at"
          value={s.at}
          min={0}
          max={Math.max(0, round1(D - 0.1))}
          step={0.1}
          onChange={(v) => s.patch({ at: round1(v) })}
          fmt={(v) => `${fmtTime(v)} s`}
        />
      )}

      <div className="rh-controls__row">
        <Seg
          label="base sound"
          value={s.audio.base}
          onChange={(base) => s.patch({ audio: { ...s.audio, base } })}
          options={[
            { v: "keep", l: "keep" },
            { v: "duck", l: "duck" },
            { v: "mute", l: "mute" },
          ]}
        />
        <Seg
          label="clip sound"
          value={s.audio.overlay}
          onChange={(overlay) => s.patch({ audio: { ...s.audio, overlay } })}
          options={[
            { v: "keep", l: "keep" },
            { v: "mute", l: "mute" },
          ]}
        />
      </div>
      {!baseIsVideo && s.audio.base !== "mute" && <p className="rh-hint">a photo has no sound of its own; base sound applies to video bases</p>}
      <div className="rh-controls__row">
        <Range label="base gain" value={s.audio.baseGain} min={0} max={2} step={0.05} onChange={(v) => s.patch({ audio: { ...s.audio, baseGain: v } })} fmt={(v) => `${Math.round(v * 100)}%`} />
        <Range label="clip gain" value={s.audio.overlayGain} min={0} max={2} step={0.05} onChange={(v) => s.patch({ audio: { ...s.audio, overlayGain: v } })} fmt={(v) => `${Math.round(v * 100)}%`} />
      </div>

      <div className="rh-caps">
        <div className="rh-caps__head">
          <span className="rh-seg__label">captions</span>
          <button className="ms-btn" disabled={s.captions.length >= MAX_CAPTIONS} onClick={() => s.addCaption()}>
            + caption
          </button>
        </div>
        {s.captions.length > 0 && (
          <div className="rh-caps__list">
            {s.captions.map((c, i) => (
              <button key={i} className={`rh-caps__item${sel === i ? " rh-caps__item--sel" : ""}`} onClick={() => s.patch({ selectedCaption: i })}>
                {c.text}
              </button>
            ))}
          </div>
        )}
        {cap && sel !== null && (
          <div className="rh-caps__edit">
            <textarea
              className="rh-textarea"
              rows={2}
              maxLength={200}
              value={cap.text}
              onChange={(e) => s.updateCaption(sel, { text: e.target.value })}
            />
            <div className="rh-controls__row">
              <Range label="size" value={cap.size} min={0.02} max={0.2} step={0.005} onChange={(v) => s.updateCaption(sel, { size: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
              <Seg
                value={cap.align}
                onChange={(align) => s.updateCaption(sel, { align })}
                options={[
                  { v: "left", l: "left" },
                  { v: "center", l: "center" },
                  { v: "right", l: "right" },
                ]}
              />
            </div>
            <div className="rh-controls__row">
              <Range label="from" value={cap.from ?? 0} min={0} max={Math.max(0, round1(D))} step={0.1} onChange={(v) => s.updateCaption(sel, { from: v === 0 ? undefined : round1(v) })} fmt={(v) => `${fmtTime(v)}`} />
              <Range label="to" value={cap.to ?? round1(D)} min={0} max={Math.max(0, round1(D))} step={0.1} onChange={(v) => s.updateCaption(sel, { to: v >= D ? undefined : round1(v) })} fmt={(v) => `${fmtTime(v)}`} />
            </div>
            <div className="rh-row">
              <button className="ms-btn ms-btn--danger" onClick={() => s.removeCaption(sel)}>
                remove
              </button>
              <span className="rh-hint">drag the text on the stage to place it</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
