# Architecture

Rhapsode is one npm package with three source roots and one runtime process.

```
shared/   zod schemas both sides import: the two-piece Recipe and the studio Sequence
server/   Hono on Node, run directly from TypeScript (type stripping, no server build)
client/   Vite + React 19 + zustand, built to dist/ and served by the same process
```

The server owns the database, the media files, the job queue and every ffmpeg
and yt-dlp process. The client edits a recipe or a sequence, posts it, and follows
the resulting job over Server-Sent Events.

## Request flow

```
link / upload ──► POST /api/sources ──► fetch job ──► sources/<id>/{orig, proxy, thumb}
                                                          │
browser scrubs proxy ◄── /s/<id>/proxy.mp4 ◄──────────────┘
      │
      ▼ recipe | sequence
POST /api/renders ──► schema + cross-check ──► render job ──► renders/<slug>.{mp4,jpg}
                                                              │
                         /m/<slug> (share page, OG tags) ◄────┘
```

1. **Source.** A link is checked against the SSRF gate, its metadata read with
   `yt-dlp --dump-single-json`, and a row inserted as `pending`. An upload is
   streamed to disk while its first 4 KB are sniffed and the whole body hashed;
   an identical, already-ready file (same SHA-256) is returned instead of stored twice.
2. **Fetch job.** Downloads the original (links only), probes it with ffprobe,
   derives a proxy and a thumbnail, and flips the row to `ready`.
3. **Edit.** The client scrubs the proxy. Proxy and original come from the same
   file, so a time on one is the same frame on the other.
4. **Render.** The body is validated by the shared schema, then cross-checked
   against the database (sources ready, cut points inside the media, a dub needs
   sound). A slug is reserved and a render job enqueued. The job builds one ffmpeg
   argv with a pure function, runs it, makes a poster, probes the output and moves
   both files into `renders/`.
5. **Share.** `/m/<slug>` is a server-rendered page with OpenGraph and Twitter
   player tags; `/m/<slug>.mp4` and `.jpg` are served with Range support and
   immutable caching.

## Server modules

| Module | Role |
|---|---|
| `server/index.ts` | Boot: config, path checks, encoder detection, drawtext self-test, DB open, stale-job recovery, sweeper, listeners on `127.0.0.1` and `::1` |
| `server/app.ts` | `createApp()`: security headers and CSP, rate limits, key gate, route mounting, SPA fallback. Listen-free so tests drive `app.request()` |
| `server/auth.ts` | `requireKey`: compares SHA-256 digests of the given and expected key with `timingSafeEqual` |
| `server/store.ts` | All SQL and all paths under the data directory; DTO mapping |
| `server/db.ts` | `node:sqlite` in WAL mode; append-only migration ladder keyed on `PRAGMA user_version` |
| `server/jobs.ts` | In-process queue with lanes (2 fetch, 1 render), SQLite rows as the record, an `EventEmitter` for live updates |
| `server/sources/` | `ssrf.ts` URL gate, `url.ts` yt-dlp, `probe.ts` ffprobe, `proxy.ts` proxies, thumbs and posters, `fetch.ts` the fetch job |
| `server/render/` | `graph.ts` (two-piece recipe), `sequence.ts` (studio), `run.ts` (render job), `encoder.ts` (NVENC probe), `fonts/` |
| `server/sniff.ts` | Magic-byte type detection; the declared content type is ignored |
| `server/sweep.ts` | Hourly cleanup of stale sources, orphaned job dirs and old job rows; disk-cap eviction |
| `server/share.ts` | The share page HTML |

## Jobs

A job row moves `queued → running → done | failed | cancelled`. Each lane runs at
most its limit concurrently; the rest wait in FIFO order. Every job gets
`data/jobs/<id>/` as scratch space, removed when it ends (kept on failure when
`JOB_KEEP_FAILED=1`).

Progress reaches subscribers on every tick and SQLite at most every 500 ms or on a
stage change. `GET /api/jobs/:id/events` streams `state`, `progress`, `done` and
`failed` events with a ping every 15 s; the client falls back to polling
`GET /api/jobs/:id` if the stream drops. Closing the stream does not cancel the job.

At boot every `queued` or `running` row is marked `failed` ("server restarted"):
the queue is in memory, so nothing left over from a previous process can finish.

Child processes run through `server/proc.ts`: argv only, never a shell; abort
sends SIGTERM, then SIGKILL after a grace period; each has a timeout (30 min for
renders and proxies).

## HTTP API

Write routes require the `x-rhapsode-key` header.

| Method and path | Key | Purpose |
|---|---|---|
| `GET /healthz` | | `{ok, encoder, ytdlp}` |
| `POST /api/verify-key` | yes | 204 when the key matches |
| `POST /api/sources` | yes | JSON `{url, around?}` for a link, or a raw `application/octet-stream` body with `x-filename` for an upload. 202 with `{source, job}`; 200 with `job: null` for a duplicate upload; 409 `needs around` for a long video |
| `GET /api/sources`, `GET /api/sources/:id` | yes | The 50 most recently used ready sources; one source |
| `DELETE /api/sources/:id` | yes | 409 while a render references it |
| `POST /api/renders` | yes | `{recipe, title?}` or `{sequence, title?}`; 202 with `{job, slug}` |
| `GET /api/renders?cursor=&limit=` | | The wall, newest first, cursor-paginated |
| `GET /api/renders/:slug` | | One render |
| `GET /api/renders/:slug/recipe` | yes | The stored recipe or sequence with its sources, for remixing |
| `DELETE /api/renders/:slug` | yes | Delete a render and its files |
| `GET /api/jobs/:id`, `DELETE /api/jobs/:id` | yes | Read or cancel a job |
| `GET /api/jobs/:id/events` | | SSE stream, gated by the 96-bit job id |
| `GET /api/storage`, `POST /api/storage/sweep` | yes | Usage report; delete every unreferenced source now |
| `GET /m/:slug`, `/m/:slug.mp4`, `/m/:slug.jpg` | | Share page, video, poster |
| `GET /s/:id/{proxy.mp4,proxy.m4a,proxy.jpg,thumb.jpg}` | | Source proxies and thumbnails, gated by the 96-bit source id |

Error bodies are `{error: string}`. Status codes carry meaning: 401 bad key,
413 upload too large, 415 unsupported file, 422 invalid body or link, 429 queue or
rate limit, 507 storage cap reached.

## Security model

- **One shared key.** Viewing renders is public; adding sources, rendering,
  deleting and reading recipes need `INVITE_KEY`. An empty key disables every
  write route. The server warns at boot when the key is shorter than 12 characters.
- **CSRF.** There is no CORS middleware. `x-rhapsode-key` is not a CORS-safelisted
  header, so a cross-origin request carrying it needs a preflight, which the server
  never answers.
- **Id-gated media.** `<video>` and `EventSource` cannot send headers, so source
  files and job event streams are reachable by id alone. Ids are 12 random bytes.
- **SSRF.** Links must be `http(s)` without credentials; `localhost`, `.local`,
  `.internal`, and any host resolving to a private, loopback, link-local, CGNAT,
  multicast or documentation address are refused. yt-dlp then runs with the
  generic extractor disabled (`--use-extractors default,-generic`), so it only
  contacts hosts a site-specific extractor recognises.
- **Uploads.** Type is decided by magic bytes. SVG is never accepted; HEIC and
  AVIF are refused; MOV and 3GP are accepted as inputs because they are always
  transcoded.
- **Headers.** A strict CSP (`script-src 'self'`, no inline script), `nosniff`,
  `frame-ancestors 'none'`, `same-origin` opener policy.
- **Rate limits.** Per-IP sliding windows: key verification, fetches, other writes
  and reads each have their own budget. The client IP is taken from
  `CF-Connecting-IP` when present, which is only sound because the server binds
  loopback and is reached through a proxy.

## Client

Hash routes: `#/` (cut), `#/studio`, `#/studio/<slug>`, `#/wall`, `#/r/<slug>`,
`#/remix/<slug>`.

- **Cut** (`client/compose/`): two source pickers, a frame-accurate trimmer per
  piece, a stage that previews the composition, and an inspector for mode, canvas,
  sound and captions. On a phone the same parts become a three-step stepper.
- **Studio** (`client/studio/`): media bin, program monitor, multitrack timeline,
  inspector, subtitle table and markers, arranged by a docking window system with
  saved layouts. One command registry drives the menu bar, context menus and
  keyboard shortcuts, so a menu always shows the key that fires it.
- **Preview.** The stage and the monitor play HTML media elements kept in step by a
  small clock. They approximate the render; the ffmpeg output is authoritative.
- **State.** zustand stores. The studio edits through `edit()`, which pushes a
  snapshot for undo. Drafts, the auth key, the window layout and custom key bindings
  persist in `localStorage` under `rhapsode:v1:*`. Lock, solo, markers and the work
  area are client-only; solo and the work area are applied to the sequence just
  before it is sent.

## Data directory

```
data/
  rhapsode.sqlite             sources, renders, render_sources, jobs
  sources/<id>/orig.<ext>     the original, as downloaded or uploaded
  sources/<id>/proxy.mp4      ≤854 px h264/aac, keyframe every 2 s (video)
  sources/<id>/proxy.m4a      aac (audio)
  sources/<id>/proxy.jpg      ≤1280 px (image)
  sources/<id>/thumb.jpg      360 px high; a waveform for audio
  renders/<slug>.mp4          the render
  renders/<slug>.jpg          its poster
  jobs/<id>/                  per-job scratch
  tmp/                        yt-dlp metadata scratch
```

See [DATA-MODEL.md](DATA-MODEL.md) for the schemas and tables,
[RENDERING.md](RENDERING.md) for the ffmpeg graphs, and
[DEPLOYMENT.md](DEPLOYMENT.md) for configuration and running it as a service.
