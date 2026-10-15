# Data model

An edit is a document. The client builds one of two shapes, both defined with zod
in `shared/` and validated by the same schema on the server: a **Recipe** for the
two-piece cut and a **Sequence** for the studio. A render stores the document it was
made from, so any render can be reopened and remixed.

All times are seconds on the source's own timeline. All positions and sizes are
fractions of the output canvas, so a document does not depend on resolution.

## Recipe (`shared/recipe.ts`)

```ts
{
  v: 1,
  base:    { kind: "video", source, in, out, edit? }
         | { kind: "image", source, duration?, edit? },     // duration defaults to the overlay's length
  overlay: { source, in, out, at = 0, edit? },               // at: start on the output timeline
  mode:    { kind: "dub" }
         | { kind: "pip", box: { x, y, w } }                 // height follows the overlay's aspect
         | { kind: "stack", dir: "top" | "bottom" | "left" | "right" },
  audio:   { base: "keep" | "duck" | "mute" = "duck", overlay: "keep" | "mute" = "keep",
             baseGain = 1, overlayGain = 1 },                // gains 0..2
  captions: [{ text, x = 0.5, y = 0.85, size = 0.07, align = "center", from?, to? }],
  output:  { aspect: "source" | "9:16" | "1:1" | "16:9" = "source", fit: "contain" | "cover" = "contain" },
}
```

`edit` is applied to a source before anything else: an optional fractional `crop`,
then a quarter-turn `rotate` (0, 90, 180, 270), then `flipH`.

Output length is the base cut (`out − in`) for a video base, or `duration` for an
image base. The overlay is clipped to whatever of it fits after `at`.

Validation, beyond types and ranges:

| Rule | Limit |
|---|---|
| Output length | > 0 and ≤ 180 s (`OUT_MAX_S` on the server) |
| Overlay length | > 0 and ≤ 180 s |
| Overlay start | `at` before the end of the output |
| Picture-in-picture box | `x + w ≤ 1`, `w` 0.1–1 |
| Captions | ≤ 6, each ≤ 200 characters, `to > from` |
| Crop | inside the frame, each side ≥ 5 % |

The server then checks what the schema cannot: both sources exist and are ready,
cut points lie inside the media, the overlay is a video (or a sound, and then only in
`dub` mode), and a dub's overlay actually has sound.

## Sequence (`shared/sequence.ts`)

```ts
{
  v: 1,
  canvas: { aspect: "16:9" | "9:16" | "1:1" | "4:5" | "source" = "16:9",
            fps: 24 | 25 | 30 | 60 = 30, background: "000000", sourceOf? },
  duration?,                    // default: the end of the last clip on any track
  tracks: [                     // 1..12, visual tracks stack in array order, bottom first
    { id, kind: "visual", name, muted, clips: VisualClip[] },
    { id, kind: "audio",  name, muted, clips: AudioClip[] },
    { id, kind: "text",   name, muted, clips: Cue[] },
  ],
}
```

**VisualClip** — a video or a still.

| Field | Meaning |
|---|---|
| `source`, `at`, `duration`, `in` | Which source, where on the timeline, how long, and (video) where in the source |
| `edit` | Crop, quarter-turn, mirror, as in the recipe |
| `fit` | `contain` (transparent bars), `cover`, or `free` with a `box {x, y, w}` |
| `opacity`, `fadeIn`, `fadeOut` | Alpha; fades are alpha fades, so overlapping clips dissolve |
| `kenBurns` | Stills only: a visible window `{x, y, w}` at the start and at the end |
| `transform` | `{x, y, scale, rotate}`: offset in canvas fractions, scale about the centre, rotation in degrees |
| `look` | `{brightness, contrast, saturation, gamma, blur, vignette, grayscale}`, neutral by default |
| `volume` | The video's own sound, 0–2 |

**AudioClip** — `{source, at, in, out, gain, fadeIn, fadeOut}`. Any source with
sound can sit on an audio track, including a video.

**Cue** — `{at, duration, text, sub?, style, size, x, y, align, color, subColor}`.
`sub` is a second, smaller line under the first, for a translation or a speaker.
`style` is `outline`, `clean` (shadow) or `box`. Cues import from and export to SRT
(`parseSrt`, `formatSrt`).

Validation: length > 0 and ≤ 600 s (`SEQ_MAX_S`), at most 80 clips and 400 cues,
ids unique across the whole sequence, `out > in` on audio clips, `free` placement
needs a box, a `source` aspect needs `sourceOf`. The server cross-checks that every
source is ready, sounds sit only on audio tracks, and in points fall inside the media.

## Tables (`server/db.ts`)

```sql
sources (
  id TEXT PRIMARY KEY,                       -- 24 hex chars, 96 random bits
  kind  TEXT CHECK (kind IN ('url','upload')),
  media TEXT CHECK (media IN ('video','image','audio')),
  status TEXT CHECK (status IN ('pending','ready','failed')),
  url, title, ext, duration, width, height, fps, has_audio,
  window_start, window_end,                  -- set when only part of a long video was fetched
  sha256, bytes, error, job_id, created_at, last_used_at
)
renders (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE,  -- adjective-noun
  title, recipe_json, duration, width, height, bytes, job_id, created_at
)
render_sources (render_id → renders ON DELETE CASCADE, source_id → sources)
jobs (
  id, kind CHECK (kind IN ('fetch','render')),
  status CHECK (status IN ('queued','running','done','failed','cancelled')),
  stage, progress, error, payload_json, result_json, created_at, started_at, finished_at
)
```

`renders.recipe_json` holds `{"recipe": …}` or `{"sequence": …}`; a bare recipe
object is also read, for renders stored before the studio existed.
`render_sources` records which sources a render used, which is what keeps them out of
the sweep.

Migrations are an append-only array in `server/db.ts`; rung *i* takes
`PRAGMA user_version` from *i* to *i + 1*. Version 2 widened the `media` check to
admit audio, which in SQLite means rebuilding the table with foreign keys off.

## Lifetimes

- **Sources are a cache.** A source no render references is deleted after 7 days
  without use (`SOURCE_TTL_HOURS`). When total storage exceeds `DISK_CAP_BYTES`, the
  sweep evicts unreferenced sources, least recently used first.
  `POST /api/storage/sweep` deletes every unreferenced source at once.
- **Renders are permanent** until deleted through the API. New renders are refused
  with 507 when renders alone exceed `RENDER_CAP_BYTES` or everything exceeds
  `DISK_CAP_BYTES`.
- **Jobs** finished more than 7 days ago are deleted.

## Slugs

A render's slug is an adjective and a noun from `shared/slugWords.ts`, checked
against existing renders and the slugs reserved by queued jobs. After eight
collisions a two-character base-36 suffix is added. A failed render releases its slug.
