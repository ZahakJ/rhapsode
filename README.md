# rhapsode

ῥαψῳδός — *the song-stitcher*. Take a piece of one thing and lay it on another.

Paste a YouTube (or X, TikTok, Instagram, Vimeo…) link or pick a clip from
your phone, cut the seconds you want, and stitch it onto a photo, another
clip, or another link:

- **dub** — the clip's sound over the base (keep, duck, or mute the base's own)
- **picture-in-picture** — the clip in a box you drag and resize
- **stack** — the two side by side or one above the other
- **captions** — bold outlined text, dragged into place, timed if you like

Then render and get a link that unfurls in WhatsApp, Telegram, X, iMessage —
or download the mp4, or remix someone's render into your own.

## Run it

```
cp .env.example .env        # set INVITE_KEY
npm install
npm run dev:server          # API on :5950
npm run dev                 # UI on :5951
```

Needs Node ≥ 24, ffmpeg/ffprobe and yt-dlp on PATH. Renders use `h264_nvenc`
when an NVIDIA GPU answers, `libx264` otherwise.

`npm run typecheck && npm test && npm run build && npm run smoke` is the done bar.

## Shape

Single package: `client/` (Vite + React), `server/` (Hono, run directly by
Node's type-stripping), `shared/recipe.ts` (the zod recipe + DTOs both sides
speak). Media and sqlite live under `data/`.

The recipe is the whole composition. `server/render/graph.ts` turns it into
one ffmpeg command — pure, unit-tested by asserting the argv — and that is the
only render path. Sources (link fetches and uploads alike) become one
original plus one locally derived scrub proxy, so what you trim in the browser
is what ffmpeg cuts.

Viewing is public. Adding sources and rendering need the invite key.
