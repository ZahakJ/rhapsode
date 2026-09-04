import { useEffect, useState } from "react"
import type { JobDto, RenderDto, SourceDto } from "../../shared/recipe.ts"
import { MAX_CAPTIONS, OUT_MAX_SECONDS } from "../../shared/recipe.ts"
import { api } from "../api/client.ts"
import { stageLabel, watchJob } from "../api/jobs.ts"
import { useAuth } from "../store/authStore.ts"
import { useCompose, saveDraft, readDraft, applyDraft, clearDraft, validateRecipe } from "../store/composeStore.ts"
import { toast } from "../components/Toasts.tsx"
import { InviteKeyDialog } from "../components/InviteKeyDialog.tsx"
import { navigate } from "../router.ts"
import { usePhone } from "../usePhone.ts"
import { SourcePicker } from "./SourcePicker.tsx"
import { Trimmer } from "./Trimmer.tsx"
import { Stage } from "./Stage.tsx"
import { Timeline } from "./Timeline.tsx"
import { useIngest, isHttpUrl, routeFile, routeUrl } from "./ingestStore.ts"
import { clamp, fmtTime, isTyping, round1 } from "../util/time.ts"
import { recipeSchema } from "../../shared/recipe.ts"
import { sequenceFromRecipe, useStudio } from "../studio/studioStore.ts"

type Step = "sources" | "cut" | "compose"
type RenderPhase = { kind: "idle" } | { kind: "submitting" } | { kind: "job"; job: JobDto; slug: string; stage: string | null; progress: number | null }

export function ComposeView() {
  const phone = usePhone()
  const s = useCompose()
  const verified = useAuth((x) => x.verified)
  const [step, setStep] = useState<Step>("sources")
  // a new step starts at its top — the "next" button sits at the bottom of the previous one
  useEffect(() => {
    document.querySelector(".rh-compose__scroll")?.scrollTo({ top: 0 })
  }, [step])
  const [keyOpen, setKeyOpen] = useState(false)
  const [render, setRender] = useState<RenderPhase>({ kind: "idle" })
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

  // ——— paste anywhere: files go to a slot, links go to the empty slot ———
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const dt = e.clipboardData
      if (!dt) return
      const file = Array.from(dt.files).find((f) => f.type.startsWith("image/") || f.type.startsWith("video/") || f.type.startsWith("audio/"))
      if (file) {
        e.preventDefault()
        const slot = routeFile(file)
        if (!slot) return
        toast(`pasted ${file.type.startsWith("image/") ? "an image" : file.type.startsWith("audio/") ? "a sound" : "a video"} into ${slot === "base" ? "A · the base" : "B · the clip"}`)
        void useIngest.getState().ingestFile(slot, file)
        return
      }
      if (isTyping(e.target)) return
      const text = dt.getData("text/plain").trim()
      if (!text || !isHttpUrl(text)) return
      const slot = routeUrl()
      if (!slot) {
        toast("both slots are full — swap one first", "warn")
        return
      }
      e.preventDefault()
      toast(`fetching that link into ${slot === "base" ? "A · the base" : "B · the clip"}`)
      void useIngest.getState().ingestUrl(slot, text)
    }
    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
  }, [])

  const ready = !!s.base && !!s.overlay
  const D = s.outputDuration()

  const startRender = async () => {
    if (!verified) {
      setKeyOpen(true)
      return
    }
    const v = validateRecipe()
    if (!v.ok) {
      toast(v.error, "warn")
      return
    }
    setRender({ kind: "submitting" })
    try {
      const res = await api.createRender(v.recipe, s.title.trim() || undefined)
      setRender({ kind: "job", job: res.job, slug: res.slug, stage: null, progress: null })
    } catch (e) {
      toast(e instanceof Error ? e.message : "render failed", "danger")
      setRender({ kind: "idle" })
    }
  }

  // follow the render job
  useEffect(() => {
    if (render.kind !== "job") return
    const slug = render.slug
    const stop = watchJob(render.job.id, (ev) => {
      if (ev.type === "progress") setRender((r) => (r.kind === "job" ? { ...r, stage: ev.stage, progress: ev.progress } : r))
      else if (ev.type === "state") setRender((r) => (r.kind === "job" ? { ...r, stage: ev.job.stage, progress: ev.job.progress } : r))
      else if (ev.type === "done") {
        const out = ev.result as RenderDto | undefined
        setRender({ kind: "idle" })
        clearDraft()
        navigate(`#/r/${encodeURIComponent(out?.slug ?? slug)}`)
      } else {
        toast(ev.error, "danger")
        setRender({ kind: "idle" })
      }
    })
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render.kind === "job" ? render.job.id : null])

  const missing = !s.base ? "pick a base (A)" : !s.overlay ? "pick the clip on top (B)" : D <= 0 ? "the base cut is empty" : D > OUT_MAX_SECONDS ? `renders are capped at ${OUT_MAX_SECONDS}s` : null

  const renderLabel =
    render.kind === "submitting"
      ? "queued…"
      : render.kind === "job"
        ? `${stageLabel(render.stage, "render")}${render.progress !== null ? ` ${Math.round(render.progress * 100)}%` : "…"}`
        : verified
          ? "render"
          : "render · needs the key"

  const sourcesPanel = (
    <div className="rh-col">
      <SourcePicker slot="base" source={s.base} onSource={(x) => s.setBase(x)} allowImage edit={s.baseEdit} onEdit={(e) => s.patch({ baseEdit: e })} />
      <SourcePicker slot="overlay" source={s.overlay} onSource={(x) => s.setOverlay(x)} allowImage={false} edit={s.overlayEdit} onEdit={(e) => s.patch({ overlayEdit: e })} />
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
          onChange={(a, b) => s.patch({ baseIn: a, baseOut: b, at: clamp(s.at, 0, Math.max(0, round1(b - a - 0.1))) })}
          label="A · base"
        />
      )}
      {s.base?.media === "image" && s.overlay && (
        <div className="rh-field rh-panel">
          <label className="rh-field__label">the photo stays up for</label>
          <div className="rh-row">
            <div className="ms-search rh-grow">
              <input
                inputMode="decimal"
                placeholder={`${fmtTime(s.ovOut - s.ovIn)} — the clip's length`}
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
          label="B · clip"
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

  const openInStudio = () => {
    const v = validateRecipe()
    if (!v.ok || !s.base || !s.overlay) {
      toast(v.ok ? "pick both pieces first" : v.error, "warn")
      return
    }
    const seq = sequenceFromRecipe(recipeSchema.parse(v.recipe), s.base, s.overlay)
    useStudio.getState().setSequence(seq, s.title, [s.base, s.overlay])
    toast("opened in the studio — tracks, music, subtitles from here")
    navigate("#/studio")
  }

  const renderBar = (
    <div className="rh-renderbar">
      <button className="ms-btn ms-btn--ghost rh-studiolink" disabled={!ready} onClick={openInStudio} title="continue this composition as a multitrack sequence">
        open in studio →
      </button>
      <div className="ms-search rh-grow">
        <input placeholder="title (optional)" value={s.title} maxLength={120} onChange={(e) => s.patch({ title: e.target.value })} />
      </div>
      <button
        className={`ms-btn ms-btn--primary rh-renderbtn${render.kind !== "idle" ? " rh-renderbtn--busy" : ""}`}
        disabled={!ready || render.kind !== "idle" || !!missing}
        onClick={() => void startRender()}
        title={missing ?? undefined}
      >
        {render.kind === "job" && <span className="rh-renderbtn__bar" style={{ width: `${Math.round((render.progress ?? 0) * 100)}%` }} />}
        <span className="rh-renderbtn__label">{renderLabel}</span>
      </button>
    </div>
  )

  const stagePanel = (
    <div className="rh-col rh-center">
      <Stage />
      <Timeline />
      {missing && ready && <p className="rh-hint rh-missing">{missing}</p>}
      {phone && (
        <>
          <Inspector />
          {renderBar}
          {render.kind === "job" && (
            <p className="rh-hint">
              you can leave this screen — the render finishes on its own and lands on the wall as <span className="mono">{render.slug}</span>
            </p>
          )}
        </>
      )}
    </div>
  )

  if (phone) {
    return (
      <div className="rh-compose rh-compose--phone">
        <div className="rh-steps">
          {(["sources", "cut", "compose"] as Step[]).map((k, i) => (
            <button key={k} className={`rh-steps__tab${step === k ? " rh-steps__tab--active" : ""}`} disabled={k !== "sources" && !ready} onClick={() => setStep(k)}>
              <span className="rh-steps__n mono">{i + 1}</span>
              {k === "sources" ? "pieces" : k === "cut" ? "cut" : "compose"}
            </button>
          ))}
        </div>
        <div className="rh-compose__scroll">
          {step === "sources" && sourcesPanel}
          {step === "cut" && cutPanel}
          {step === "compose" && stagePanel}
        </div>
        {keyOpen && <InviteKeyDialog onClose={() => setKeyOpen(false)} />}
      </div>
    )
  }

  return (
    <div className="rh-editor">
      <aside className="rh-editor__rail">
        {sourcesPanel}
        {ready && cutPanel}
      </aside>
      <section className="rh-editor__center">
        {ready ? (
          <>
            {stagePanel}
            {render.kind === "job" && (
              <p className="rh-hint rh-center__note">
                you can leave this screen — the render finishes on its own and lands on the wall as <span className="mono">{render.slug}</span>
              </p>
            )}
          </>
        ) : (
          <EmptyEditor hasBase={!!s.base} />
        )}
      </section>
      <aside className="rh-editor__inspector">
        {ready ? (
          <>
            <Inspector />
            {renderBar}
          </>
        ) : (
          <div className="rh-inspector__empty">
            <div className="rh-inspector__emptytitle">inspector</div>
            <p className="rh-hint">mode, canvas, sound and captions appear here once both pieces are in.</p>
          </div>
        )}
      </aside>
      {keyOpen && <InviteKeyDialog onClose={() => setKeyOpen(false)} />}
    </div>
  )
}

function EmptyEditor({ hasBase }: { hasBase: boolean }) {
  return (
    <div className="rh-empty">
      <div className="rh-empty__frame">
        <div className="rh-empty__mark mono">A ▸ B</div>
        <div className="rh-empty__title">{hasBase ? "now the clip on top" : "stitch a piece of one thing onto another"}</div>
        <ol className="rh-empty__steps">
          <li>
            <b>A</b> the base — a photo, a clip, or a link
          </li>
          <li>
            <b>B</b> the piece on top — a song, a line, a moment
          </li>
          <li>cut both, place the clip on the timeline, render</li>
        </ol>
        <p className="rh-hint">
          paste a link or an image anywhere on this page · drop files on a slot · <span className="mono">⌘V</span>
        </p>
      </div>
    </div>
  )
}

function Seg<T extends string>({ value, options, onChange, label, block }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label?: string; block?: boolean }) {
  return (
    <div className={`rh-seg${block ? " rh-seg--block" : ""}`} role="group" aria-label={label}>
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

function Inspector() {
  const s = useCompose()
  const D = s.outputDuration()
  const baseIsVideo = s.base?.media === "video"
  const sel = s.selectedCaption
  const cap = sel !== null ? s.captions[sel] : undefined

  return (
    <div className="rh-inspector">
      <div className="rh-insp">
        <div className="rh-insp__title">mode</div>
        <Seg
          block
          value={s.mode.kind}
          onChange={(k) => s.setMode(k)}
          options={[
            { v: "dub", l: "dub" },
            { v: "pip", l: "picture-in-picture" },
            { v: "stack", l: "stack" },
          ]}
        />
        {s.overlay?.media === "audio" && <p className="rh-hint">a sound can only be dubbed — its picture does not exist</p>}
        {s.mode.kind === "stack" && (
          <Seg
            block
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
          <Range
            label="box width"
            value={s.mode.box.w}
            min={0.1}
            max={1}
            step={0.01}
            onChange={(w) => s.mode.kind === "pip" && s.patch({ mode: { kind: "pip", box: { ...s.mode.box, w: clamp(w, 0.1, 1 - s.mode.box.x) } } })}
            fmt={(v) => `${Math.round(v * 100)}%`}
          />
        )}
        {s.mode.kind === "dub" && <p className="rh-hint">the clip's sound over the base; its picture stays hidden</p>}
        {s.mode.kind === "pip" && <p className="rh-hint">drag the box on the stage; the corner grip resizes it</p>}
      </div>

      <div className="rh-insp">
        <div className="rh-insp__title">canvas</div>
        <Seg
          block
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
          block
          label="fit"
          value={s.output.fit}
          onChange={(fit) => s.patch({ output: { ...s.output, fit } })}
          options={[
            { v: "contain", l: "contain · pad" },
            { v: "cover", l: "cover · crop" },
          ]}
        />
      </div>

      <div className="rh-insp">
        <div className="rh-insp__title">sound</div>
        <Seg
          block
          label="base"
          value={s.audio.base}
          onChange={(base) => s.patch({ audio: { ...s.audio, base } })}
          options={[
            { v: "keep", l: "keep" },
            { v: "duck", l: "duck" },
            { v: "mute", l: "mute" },
          ]}
        />
        <Seg
          block
          label="clip"
          value={s.audio.overlay}
          onChange={(overlay) => s.patch({ audio: { ...s.audio, overlay } })}
          options={[
            { v: "keep", l: "keep" },
            { v: "mute", l: "mute" },
          ]}
        />
        {!baseIsVideo && s.audio.base !== "mute" && <p className="rh-hint">a photo has no sound; base sound applies to video bases</p>}
        <Range label="base gain" value={s.audio.baseGain} min={0} max={2} step={0.05} onChange={(v) => s.patch({ audio: { ...s.audio, baseGain: v } })} fmt={(v) => `${Math.round(v * 100)}%`} />
        <Range label="clip gain" value={s.audio.overlayGain} min={0} max={2} step={0.05} onChange={(v) => s.patch({ audio: { ...s.audio, overlayGain: v } })} fmt={(v) => `${Math.round(v * 100)}%`} />
      </div>

      <div className="rh-insp">
        <div className="rh-insp__head">
          <div className="rh-insp__title">captions</div>
          <button className="ms-btn ms-btn--small" disabled={s.captions.length >= MAX_CAPTIONS} onClick={() => s.addCaption()}>
            + caption
          </button>
        </div>
        {s.captions.length === 0 && <p className="rh-hint">bold outlined text, dragged into place on the stage</p>}
        {s.captions.length > 1 && (
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
            <textarea className="rh-textarea" rows={2} maxLength={200} value={cap.text} onChange={(e) => s.updateCaption(sel, { text: e.target.value })} />
            <Range label="size" value={cap.size} min={0.02} max={0.2} step={0.005} onChange={(v) => s.updateCaption(sel, { size: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
            <Seg
              block
              label="align"
              value={cap.align}
              onChange={(align) => s.updateCaption(sel, { align })}
              options={[
                { v: "left", l: "left" },
                { v: "center", l: "center" },
                { v: "right", l: "right" },
              ]}
            />
            <Range label="from" value={cap.from ?? 0} min={0} max={Math.max(0, round1(D))} step={0.1} onChange={(v) => s.updateCaption(sel, { from: v === 0 ? undefined : round1(v) })} fmt={(v) => fmtTime(v)} />
            <Range label="to" value={cap.to ?? round1(D)} min={0} max={Math.max(0, round1(D))} step={0.1} onChange={(v) => s.updateCaption(sel, { to: v >= D ? undefined : round1(v) })} fmt={(v) => fmtTime(v)} />
            <div className="rh-row rh-row--between">
              <span className="rh-hint">drag the text on the stage to place it</span>
              <button className="ms-btn ms-btn--small ms-btn--danger" onClick={() => s.removeCaption(sel)}>
                remove
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
