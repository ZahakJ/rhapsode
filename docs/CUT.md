# rhapsode cut

A command line and an MCP server for taking exact pieces out of a video: frames
at given times, fixed-interval strips, the first frame of each shot, clips, and
contact sheets. The source is a link (fetched once with yt-dlp, only the part you
need) or a local file. Every run writes its files and a `manifest.json` that says
where each one came from.

It runs on its own: no server, no key, nothing to do with the web app's data.

## Install

Needs what the app needs: Node 24+, `ffmpeg`, `ffprobe`, and `yt-dlp` for links.

```sh
npm ci
npm link                      # puts `rhapsode` on PATH
rhapsode cut probe ./clip.mp4
```

Without `npm link`: `node cut/cli.ts cut ...` or `npm run cut -- ...`.

## Commands

```sh
rhapsode cut probe  <url|file>
rhapsode cut fetch  <url> [--from T --to T] [--height 720] [--no-audio]
rhapsode cut frames <src> --at 12.5,1:03.2
rhapsode cut strip  <src> --from 12 --to 14 --every 67ms      # or --fps 15
rhapsode cut scenes <src> [--from T --to T] [--threshold 0.3] [--max 60] [--no-extract]
rhapsode cut clip   <src> --range 12-20 --range 1:05+3 [--mode auto|copy|encode]
rhapsode cut sheet  <manifest.json | images...> [--cols 6] [--width 320]
rhapsode mcp
```

Times: `12.5`, `1:02.5`, `01:02:03`, `1500ms`. Ranges: `12-20`, `1:00-1:05`,
`12+3` (start plus length).

Options for the image commands (`frames`, `strip`, `scenes`):

| Option | Meaning |
|---|---|
| `--size 640x360` | Output size. `--fit cover` (default) scales and centre-crops, `contain` letterboxes, `stretch` distorts |
| `--size 640x`, `--size x360` | Width or height only; the other side keeps the aspect |
| `--crop w:h:x:y` | Crop in source pixels, before `--size` |
| `--format png\|jpg\|webp` | Default `png` (RGB). `jpg` is full-range 4:4:4 |
| `--quality N` | jpg `-q:v` (2 best, default 3); webp 0–100 |
| `--sheet` | Also tile the frames into labelled `sheet_NN.jpg` (48 per sheet) |
| `--sheet-width N` | Thumbnail width in the sheet (default 320) |

`clip` takes `--size`, `--fit` and `--crop` too; any of them forces a re-encode.

Common: `--out DIR` (default `./rhapsode-cut/<op>-<title>-<start>s`),
`--height N` (fetch cap for links, default 1080), `--jobs N`, `--hw auto|cuda|cpu`,
`--json` (print the manifest instead of a summary).

### Examples

Two seconds of a run cycle at 15 fps, 640 wide, as JPEGs with a sheet:

```sh
rhapsode cut strip 'https://www.youtube.com/watch?v=VIDEO' \
  --from 5:00 --to 5:02 --fps 15 --size 640x --format jpg --sheet
```

The first frame of every shot in a minute of footage, 1280×720:

```sh
rhapsode cut scenes ./match.mp4 --from 10:00 --to 11:00 --size 1280x720 --sheet
```

A clip without re-encoding when the start falls on a keyframe:

```sh
rhapsode cut clip ./match.mp4 --range 10:04-10:09
```

## What you get

Frames are named `NNNN_tSSSS.mmm.<ext>`: the order, then the source time of the
frame actually written. `manifest.json` in the same directory:

```jsonc
{
  "rhapsode": "cut/1",
  "op": "strip",
  "source": {
    "kind": "url", "url": "...", "id": "...", "extractor": "Youtube",
    "title": "...", "uploader": "...", "uploadDate": "20250904", "duration": 1274,
    "file": "~/.cache/rhapsode/cut/Youtube-.../s298.000-304.000-h1080-noaudio.mp4",
    "sha256": "...",            // of the cached media file
    "offset": 298,              // source seconds at that file's t=0
    "media": { "width": 1920, "height": 1080, "fps": 60, "vcodec": "h264", ... }
  },
  "params": { ... },            // exactly what was asked
  "decode": "cpu", "encode": null,
  "outputs": [
    { "kind": "frame", "path": "...", "requested": 300.067, "t": 300.083333,
      "tc": "00:05:00.083", "sha256": "...", "bytes": 2981446 }
  ],
  "notes": []
}
```

`requested` is the asked time (or grid point); `t` is the time of the frame
written. A frame is always the first one at or after the asked time, so `t` is
never earlier than `requested`, and a strip asked at a rate above the source's
gets fewer frames than grid points (a note says so). Scene frames carry the cut
`score`; the first entry is the window's start.

## Sources and the cache

A link is resolved to its site id once; `~/.cache/rhapsode/cut/index.json` maps
the URL to it, so a repeat costs no network at all. For a window, only that
section is fetched (`--download-sections`, padded by 2 s each side). Any cached
file that covers the asked window at the asked height or better is reused, so a
later strip inside an earlier window is instant. Frame commands fetch video only;
`clip` and `fetch` include audio. One run fetches one span, from its earliest to
its latest time, so frames minutes apart are cheaper as separate runs.

Section fetches go through ffmpeg and YouTube paces them at roughly real time, so
fetch narrow windows: six seconds of 1080p60 took 11 s, three minutes took 135 s.
YouTube sometimes serves a session with nothing above 360p; the fetch is retried up
to three times and a lower-resolution result is never reused once a better one is
possible. `YTDLP_PLAYER_CLIENTS` overrides the player clients
(`mweb,web_embedded,android`). Sections fetched separately line up to the frame.

| Variable | Default |
|---|---|
| `RHAPSODE_CUT_CACHE` | `$XDG_CACHE_HOME/rhapsode/cut` |
| `RHAPSODE_CUT_OUT` | `./rhapsode-cut` |

The cache is never swept; delete the directory to clear it.

## Speed

On a 16-thread desktop with an RTX 4070 Super, 1080p60 H.264:

| Task | Time |
|---|---|
| 2 s strip at 15 fps (30 PNGs), cached | 0.9 s |
| same, 30 JPEGs | 0.6 s |
| same, first run (metadata + 6 s section fetch) | 15 s |
| scene scan of 3 minutes | 4.3 s |

Seeking is accurate (decode from the keyframe before, drop until the time).
Strips run as one ffmpeg pass per chunk of at least 2 s, chunks in parallel;
single frames and scene frames run in parallel. `--hw auto` decodes on the CPU:
NVDEC was slower on every case measured here (3 min scene scan 13.7 s vs 4.3 s,
for H.264, HEVC and AV1 alike), and only wins on machines with few cores, where
auto picks it. Clips stream-copy when the start is on a keyframe and nothing is
resized; otherwise they encode with NVENC when present, libx264 if not.

## MCP

`rhapsode mcp` speaks MCP over stdio. It opens no port. Tools:

| Tool | Does |
|---|---|
| `probe` | Title, uploader, duration and cache state of a link; size, fps, codec of a file |
| `fetch` | Cache a link (or a window of it) and return the file |
| `list_scenes` | Shot cuts with scores, plus a frame per shot unless `extract: false` |
| `frames` | Frames at timestamps |
| `strip` | Fixed-interval frames over a window |
| `clip` | Clips by range |
| `contact_sheet` | Sheets from a manifest or image paths |

Arguments match the CLI (`from`, `to`, `every`, `at`, `ranges`, `size`, `fit`,
`crop`, `format`, `sheet`, ...). Each result is the manifest, as text and as
`structuredContent`; read the `outputs[].path` files with your own image tools.

Claude Code:

```sh
claude mcp add rhapsode-cut -- node /path/to/rhapsode/cut/cli.ts mcp
```

Other clients: command `node`, args `["/path/to/rhapsode/cut/cli.ts", "mcp"]`.
Outputs land under the client's working directory unless `out` is given.

## Use and terms

This is for personal and reference use. Fetch only what you are allowed to
watch, and follow the terms of the site you fetch from; some sites forbid
downloading outright. Frames and clips are for looking at: studying how a game
animates, comparing your own work against published footage, quoting a moment.
The intended case is private visual reference, such as scoring a game's own
frames against a few published ones; that use keeps the frames on the machine,
does not redistribute them, and does not train models on them. Rhapsode adds no
rights to what you download.
