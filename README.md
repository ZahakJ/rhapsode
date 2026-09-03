<p align="center">
  <img src="docs/assets/og.png" alt="Rhapsode" width="720">
</p>

# Rhapsode

**ῥαψῳδός — the song-stitcher.** Take a piece of one thing and lay it on another.

Paste a YouTube link (or X, TikTok, Instagram, Vimeo — anything yt-dlp reads) or drop a clip from your phone, cut the seconds you want, and stitch them onto a photo, a clip, or another link:

- **dub** — the clip's sound over the base; keep, duck, or mute the base's own
- **picture-in-picture** — the clip in a box you drag and resize
- **stack** — the two side by side or one above the other
- **captions** — bold outlined text, dragged into place, timed if you like

Then render on your own GPU and get a two-word link that unfurls in WhatsApp, Telegram, X and iMessage — or download the mp4, or remix any render into your own.

Landing page: **https://zahakj.github.io/rhapsode/**

## Run it

```
cp .env.example .env        # set INVITE_KEY — viewing is public, creating needs the key
npm install
npm run dev:server          # API on :5950
npm run dev                 # UI on :5951
```

Needs Node ≥ 24, `ffmpeg` / `ffprobe` and `yt-dlp` on PATH. Renders use `h264_nvenc` when an NVIDIA GPU answers, `libx264` otherwise.

The done bar: `npm run typecheck && npm test && npm run build && npm run smoke`. The tests render real clips through ffmpeg from generated fixtures; the smoke drives the entire UI in headless Chromium on desktop and phone.

## Shape

Single package: `client/` (Vite + React), `server/` (Hono, run directly by Node's type-stripping — no server build), `shared/recipe.ts` (the zod recipe and DTOs both sides speak). Media and a SQLite file live under `data/`.

**The recipe is the whole composition.** `server/render/graph.ts` turns it into one ffmpeg command — a pure function, unit-tested by asserting the argv down to the filter strings — and that is the only render path. Sources (link fetches and uploads alike) become one original plus one locally derived scrub proxy, so what you trim in the browser is exactly what ffmpeg cuts.

Things the code is careful about, because each one bit once:

- never `-shortest`; output length is an explicit `-t`, every audio lane is padded, every `amix` carries `normalize=0`
- ducking is a sidechain compressor, not a volume step
- a lane the mode wants but the file lacks is replaced by generated silence
- captions go through files; ffmpeg 9's drawtext option order is pinned by a test
- yt-dlp player clients are pinned so sectioned fetches of long videos are not refused
- uploads stream to disk while being sniffed and hashed; phone clips are never buffered in memory
- a restart marks in-flight jobs failed; nothing pretends

## Deploy

`deploy/rhapsode.service` is a systemd user unit (sandboxed, with the device rules NVENC needs). The server binds loopback only; put a Cloudflare tunnel or a reverse proxy in front of it. Set `PUBLIC_ORIGIN` so share links carry your domain.

## License

MIT.
