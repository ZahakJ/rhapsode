# Rhapsode

Clip-and-overlay forge + media host at **rhapsode.avicenna.space** — ῥαψῳδός,
the *song-stitcher*: take a piece of any video (a YouTube link, an X/TikTok
post, a phone clip) and lay it over something unrelated — a photo, another
clip, another link — as a dub, a picture-in-picture, or a stack, with Anton
captions; share the result as an unfurling link. Anyone can watch; adding
sources and rendering need the shared `INVITE_KEY`. Single npm package
(mimema shape): Vite 7 + React 19 client, Hono 4 server run directly by Node
26 (TS type-stripping, no server build), `node:sqlite` metadata + blobs on
disk under gitignored `data/`. Renders happen on the server with ffmpeg
(NVENC when the GPU answers, libx264 otherwise); sources come from yt-dlp or
streamed uploads.

Ports: dev API **5950**, dev Vite **5951**, smoke/preview **6951**, prod
**8013**. Accent: stage coral `--accent-rgb: 255, 122, 89` with the
family's flame→gold sweep on obsidian. Caption face **Anton** (client via
@fontsource, server via the vendored `server/render/fonts/Anton-Regular.ttf`).

## Commands

- `npm run dev:server` + `npm run dev` — dev pair (vite proxies /api, /m, /s → :5950)
- `npm run typecheck` / `npm test` / `npm run build` / `npm run smoke` — the done bar
- `npm start` — prod server (reads `.env`, defaults PORT 8013)

`npm test` renders real clips through ffmpeg (lavfi fixtures, libx264) —
ffmpeg/ffprobe must be on PATH. yt-dlp is only exercised by hand.

## Architecture

- `shared/recipe.ts` — zod **Recipe** (base video cut | image + duration,
  overlay cut + `at`, mode dub|pip|stack, audio keep/duck/mute + gains,
  captions, output aspect/fit) and every DTO. Caps: 180 s output, 6 captions.
- `server/render/graph.ts` — `buildArgs(recipe, sources)`: the **one render
  path**, a pure recipe→ffmpeg-argv function pinned by `graph.test.ts`.
  `run.ts` spawns it with `-progress pipe:1`, makes the poster, ffprobes,
  renames into `data/renders/`. `encoder.ts` probes NVENC once at boot.
- `server/sources/` — `url.ts` (yt-dlp metadata + ≤1080p download, windowed
  via `--download-sections` for long videos), `upload` (raw octet-stream body
  streamed to disk, sniffed, sha-deduped), `probe.ts` (ffprobe → display
  dims with rotation applied), `proxy.ts` (always-transcoded ≤854px h264
  proxy + thumb), `ssrf.ts` (URL gate), `fetch.ts` (the fetch job).
- `server/jobs.ts` — lane-limited in-process queue (2 fetch / 1 render),
  sqlite rows + EventEmitter fan-out, SSE at `/api/jobs/:id/events`.
- `server/store.ts` (sources / renders / render_sources / jobs), `db.ts`
  migration ladder (v1), `sweep.ts` (unreferenced sources after 7 d,
  disk cap eviction; renders are permanent).
- `client/` — hash routes `#/` compose (pieces → cut → compose stepper on
  phones, two columns on desktop), `#/wall`, `#/r/<slug>`, `#/remix/<slug>`.
  `compose/Stage.tsx` is the live preview (two `<video>`s kept in step in
  JS — approximate; the render is truth). Draft in `rhapsode:v1:draft`.

### Invariants (hard-won)

- **Never `-shortest`.** Output duration is an explicit `-t D`; every audio
  lane is `apad`ed; `amix` carries `normalize=0`; a lane the mode wants but
  the file lacks is replaced by an `anullsrc` input (a `[1:a]` on a silent
  file is a hard ffmpeg error). `setpts=PTS-STARTPTS` follows every trim;
  `fps=` precedes the `setpts=PTS+AT/TB` shift.
- **drawtext option order is load-bearing on ffmpeg 9**: `textfile=` before
  `fontfile=`, `expansion=none` last. A test pins it — don't tidy it.
  Caption text goes through a file, never inline. `DATA_DIR` and the font
  path must match `^[A-Za-z0-9_./-]+$` (filter-string syntax); boot refuses
  otherwise. `.woff2` fonts don't load in drawtext — ttf only.
- **One orig, one locally derived proxy per source** — recipe times map 1:1
  between what the browser scrubs and what ffmpeg reads; renders never
  touch the network, so remix works after the video is gone.
- **yt-dlp player clients** are pinned to `mweb,web_embedded,android`
  (`YTDLP_PLAYER_CLIENTS`): yt-dlp's default android_vr answers its own
  downloader but 403s ffmpeg's sectioned fetch. YouTube sometimes serves a
  "SABR-only" session where only 360p survives — that's YouTube, not us;
  a PO-token provider plugin would lift it.
- **Sniffed MIME is truth** (`server/sniff.ts`); ffprobe is the final word.
  MOV/3GP are accepted as *inputs* (transcoded, never hotlinked); HEIC/AVIF
  and SVG are not.
- **No CORS middleware, on purpose**: the non-safelisted `x-rhapsode-key`
  header forces a failing preflight cross-origin — that IS the CSRF defense.
  `/s/:id/*` and `/api/jobs/:id/events` are id-gated only because `<video>`
  and `EventSource` cannot send headers; ids are 96-bit random.
- Uploads are **streamed** (`Readable.fromWeb` → sniff → disk while
  hashing); never `arrayBuffer()` a 500 MB phone clip.
- A restart fails every queued/running job ("server restarted"); the client
  re-submits. SSE disconnects do **not** cancel a job (phones background tabs).
- Rate limiting is in-memory per-IP keyed by `CF-Connecting-IP` (safe only
  because the server binds loopback). `RATE_LIMIT=0` disables.
- DB schema changes append a rung to `MIGRATIONS` in `server/db.ts`.
- CSP includes `font-src 'self' data:` (vite inlines font subsets).
- Derived accent vars live on `body`, NOT `:root` (family pitfall).
- Never `pkill -f "server/index.ts"` — every suite service shares that
  path (and so does your own shell). Kill by port.
- Set `document.body.dataset.appReady = '1'` after first render (smoke waits on it).

## Deploy

systemd user unit in `deploy/rhapsode.service`, symlinked from
`~/.config/systemd/user/` + `avicenna-suite.target.wants/`. It keeps mimema's
sandbox **minus** `PrivateDevices`, with `DeviceAllow` for the nvidia nodes —
drop those and NVENC silently falls back to libx264 (`/healthz` reports the
encoder). `.env` holds `INVITE_KEY` (empty = creation disabled). After
changing client code: `npm run build && systemctl --user restart rhapsode.service`.
Cloudflare: `cf-rhapsode` in `~/containers/tunnels` → `http://localhost:8013`.
