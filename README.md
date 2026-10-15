<p align="center"><img src="docs/media/banner.png" width="820" alt="Rhapsode: the studio with a media bin, program monitor, multitrack timeline and inspector"></p>

Rhapsode is a self-hosted video editor: cut a few seconds from a link or an upload, lay them over a photo, a clip or a multitrack sequence, render with ffmpeg, and share the result as a short link.

<p align="center">
  <img src="docs/media/studio.webp" width="400" alt="The studio: stills with pan and zoom, a bilingual subtitle track and a music track on the timeline">
  <img src="docs/media/compose.webp" width="400" alt="The cut view: two trimmed pieces composed as a picture-in-picture with a caption">
</p>
<p align="center">
  <img src="docs/media/wall.webp" width="400" alt="The wall of finished renders">
  <img src="docs/media/result.webp" width="400" alt="A finished 9:16 stack render with its share link">
</p>

<p align="center"><sub>Footage: <i>Big Buck Bunny</i> and <i>Sintel</i>, © Blender Foundation, CC BY.</sub></p>

## Run

Needs Node 24 or newer, `ffmpeg`/`ffprobe` and `yt-dlp` on `PATH`.

```sh
git clone https://github.com/ZahakJ/rhapsode && cd rhapsode
npm ci
cp .env.example .env          # set INVITE_KEY
npm run build && npm start    # http://127.0.0.1:8013
```

For development, `npm run dev:server` (API on :5950) and `npm run dev` (UI on :5951).
Checks: `npm run typecheck && npm test && npm run build && npm run smoke`.

## Use

Viewing renders is open; adding sources and rendering need the key from `.env`,
entered through the **guest** button in the top bar.

- **Cut** (`#/`): choose a base (video or photo) and a clip to lay on top, from a
  link, a file, a paste or a drop. Trim each with typed in and out points or the
  keyboard (space, ← →, `I`, `O`). Pick a mode: **dub** (the clip's sound over the
  base, with the base kept, ducked or muted), **picture-in-picture**, or **stack**.
  Add captions, choose a canvas, render.
- **Studio** (`#/studio`): video, audio and text tracks; stills with pan and zoom,
  fades, free placement, rotation and colour; subtitles with a second line and SRT
  import and export. Press `?` for the shortcuts.
- **Share**: every render gets a two-word address, `/m/<slug>`, that previews as a
  video in chat apps. **Remix** reopens the recipe behind any render.

## How it works

The browser edits a document: a two-piece recipe or a multitrack sequence, both
zod schemas shared with the server. Each source is stored once as an original plus
a browser-friendly proxy derived from it, so times picked in the browser are exact
in the render. A render job turns the document into a single ffmpeg command through
a pure function whose output the tests assert, runs it with NVENC or libx264, and
keeps the document with the result.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): modules, request flow, jobs, HTTP API, security model
- [Data model](docs/DATA-MODEL.md): recipe and sequence schemas, tables, lifetimes
- [Rendering](docs/RENDERING.md): the ffmpeg graphs, fonts, encoders, source proxies
- [Deployment](docs/DEPLOYMENT.md): configuration, systemd, development and tests

## License

[MIT](LICENSE). The bundled fonts (Anton, IBM Plex) are under the SIL Open Font License.
