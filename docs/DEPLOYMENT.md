# Deployment

## Requirements

- Node 24 or newer (runs the server's TypeScript directly and provides `node:sqlite`)
- `ffmpeg` and `ffprobe` with libx264, libfreetype, and for right-to-left captions
  libfribidi and libharfbuzz; `h264_nvenc` is used when an NVIDIA GPU is available
- `yt-dlp` on `PATH` for link sources

## Build and start

```sh
npm ci
npm run build                 # client → dist/
cp .env.example .env          # set INVITE_KEY and PUBLIC_ORIGIN
npm start                     # node --env-file-if-exists=.env server/index.ts
```

The server serves `dist/` itself. It binds `127.0.0.1` and `::1` only; put a
reverse proxy or a tunnel in front of it for outside access. Share pages build
absolute OpenGraph URLs from `PUBLIC_ORIGIN`, so it must be the public address.

After a client change, run `npm run build` and restart the process. Server changes
need only the restart.

## Configuration

All settings are environment variables, read once at boot. `.env.example` lists them.

| Variable | Default | Meaning |
|---|---|---|
| `INVITE_KEY` | empty | Shared key for every write route. Empty disables creation |
| `HOST`, `PORT` | `127.0.0.1`, `8013` | Listen address |
| `PUBLIC_ORIGIN` | `http://localhost:<PORT>` | Origin used in share-page tags |
| `DATA_DIR` | `./data` | Database and media. Must match `[A-Za-z0-9_./-]+` |
| `RENDER_ENCODER` | detected | `h264_nvenc` or `libx264` |
| `FETCH_WHOLE_MAX_S` | 900 | Longer videos are fetched as a window |
| `FETCH_WINDOW_S` | 900 | Length of that window |
| `FETCH_ABS_MAX_S` | 14400 | Longest video accepted at all |
| `FETCH_TIMEOUT_MS` | 900000 | Per-download timeout |
| `FETCH_DISK_CAP_BYTES` | 3 GiB | Largest single download |
| `UPLOAD_MAX_BYTES` | 512 MiB | Largest upload |
| `DISK_CAP_BYTES` | 10 GiB | All sources and renders together |
| `RENDER_CAP_BYTES` | 4 GiB | Renders alone |
| `SOURCE_TTL_HOURS` | 168 | Unreferenced sources are swept after this long unused |
| `MAX_PENDING_RENDERS` | 8 | Queue depth before 429 |
| `MAX_PENDING_FETCHES` | 5 | Queue depth before 429 |
| `OUT_MAX_S` | 180 | Longest two-piece render |
| `SEQ_MAX_S` | 600 | Longest studio sequence |
| `RATE_LIMIT_VERIFY`, `_FETCH`, `_WRITE`, `_READ` | 10, 10, 30, 120 | Requests per IP per window |
| `RATE_LIMIT_WINDOW_MS` | 60000 | Window length |
| `RATE_LIMIT` | | `0` turns the limiter off |
| `JOB_KEEP_FAILED` | | `1` keeps a failed job's scratch directory |
| `YTDLP_PLAYER_CLIENTS` | `mweb,web_embedded,android` | YouTube player clients, in order |
| `FONT_PATH`, `FONTS_DIR` | `server/render/fonts/…` | Caption fonts |

Rate limiting keys on `CF-Connecting-IP` when the header is present, otherwise the
socket address. Behind a proxy that does not set that header, every client shares
the proxy's address and therefore one budget.

## systemd

`deploy/rhapsode.service` is a user unit. Adjust `WorkingDirectory`,
`ReadWritePaths` and `TMPDIR` to the checkout, then:

```sh
ln -s "$PWD/deploy/rhapsode.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now rhapsode.service
```

The unit runs with `ProtectSystem=strict`, a read-only home except the data
directory, no capabilities and a `@system-service` syscall filter, capped at 6 GB of
memory. It does not set `PrivateDevices`: NVENC needs the `/dev/nvidia*` nodes, which
are granted with `DeviceAllow`. Without them ffmpeg falls back to libx264 without an
error; `/healthz` shows which encoder is active.

## Development

```sh
npm run dev:server            # API on :5950, restarts on change
npm run dev                   # Vite on :5951, proxies /api, /m, /s and /healthz to :5950
```

The checks CI runs on every push:

```sh
npm run typecheck
npm test                      # vitest; renders real clips, needs ffmpeg on PATH
npm run build
npm run smoke                 # Playwright, desktop and phone
```

`npm run smoke` starts the built server on :6951 with a throwaway data directory and
libx264, uploads generated clips, a photo and a tone through the API, then drives the
whole interface in headless Chromium: unlock, pick sources, render, the wall, the
share page, remix, a sound over a photo, the studio (tracks, cues, context menu,
shortcuts, layouts, docking, the transform gizmo) and the phone stepper. It fails on
any console error and writes screenshots to `screenshots/`.
