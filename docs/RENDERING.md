# Rendering

Every render is a single ffmpeg invocation. Two pure functions build its argv:

- `buildArgs` in `server/render/graph.ts` for a Recipe
- `buildSequenceArgs` in `server/render/sequence.ts` for a Sequence

Neither touches the file system, the clock or a process. They take the document,
what is known about each source (path, dimensions, frame rate, duration, whether it
has sound), the job directory, font paths and the encoder, and return the argv, the
filter graph, the output dimensions and duration, and the text files to write before
spawning. `graph.test.ts` and `sequence.test.ts` assert the generated filter strings
directly; the integration tests in `server/app.test.ts` render real clips generated
with lavfi.

The runner (`server/render/run.ts`) writes the caption files, spawns ffmpeg with
`-progress pipe:1` and maps `out_time` to job progress, extracts a poster at
min(1 s, duration / 3), ffprobes the result and moves `out.mp4` and `poster.jpg`
into `renders/`.

## Rules both builders follow

| Rule | Why |
|---|---|
| Output length is an explicit `-t D`; `-shortest` is never used | The length is exact, whichever stream ends first |
| Every audio lane ends in `apad` | A lane shorter than the output would otherwise end the mix early |
| `amix … :normalize=0` | The default halves every input |
| A missing lane becomes `anullsrc` | Referencing `[n:a]` on a file without sound is a hard error, so silence is generated instead |
| `setpts=PTS-STARTPTS` after every trimmed input | Removes edit-list and priming offsets |
| `fps=` before `setpts=PTS+AT/TB` | The timeline shift is the last step of every video chain |
| Caption text goes through `textfile=` | Text never enters the filter string, so no escaping is needed |
| drawtext options in a fixed order: `textfile` before `fontfile`, `expansion=none` last | ffmpeg 9 misparses other orders; a test pins it |
| Paths match `^[A-Za-z0-9_./-]+$` | They appear inside filter strings, where `:`, `,`, `'` and `\` are syntax. The server refuses to boot otherwise |

Audio is normalised to 48 kHz stereo (`aformat`) on every lane and encoded as AAC
160 kb/s.

## Two-piece graph

Inputs: the base (`-ss in -t len`, or `-loop 1 -framerate fps` for a still), the
overlay (`-ss in -t len`), and `anullsrc` when no lane sounds.

The canvas is the fixed size for `9:16`, `1:1`, `16:9` (1080 on the short edge),
or the base's edited dimensions scaled to at most 1920 on the long edge. The frame
rate is the base's, clamped to 24–60, or 30 for a still.

Video, by mode:

- **dub**: the base, fitted to the canvas. The overlay contributes only sound.
- **pip**: the overlay scaled to `box.w` of the canvas width, shifted by `at` on the
  timeline, and overlaid at `box.x, box.y` while `between(t, at, at + len)`.
- **stack**: the canvas is split into two lanes. The base fills one; the overlay is
  laid on a black lane for its span; `vstack` or `hstack` joins them in `dir` order.

`contain` scales down and pads with black; `cover` scales up and crops. Captions
are drawn last, on the composed frame, followed by `format=yuv420p`.

Audio, by `audio.base` and `audio.overlay`:

- both kept: `amix` of the two lanes
- base `duck`: the overlay lane is split; one copy drives
  `sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400` on the base, so
  the base drops only while the overlay is sounding
- one kept: that lane alone
- none: the generated silence

The overlay lane is delayed by `at` with `adelay=…:all=1`.

## Sequence graph

Each visual clip, video or still, gets its own input, so one source can appear any
number of times. Tracks are walked bottom to top, clips in start order. Per clip:

```
[n:v] setpts=PTS-STARTPTS, <edit>, <zoompan>, <placement>, <look>,
      format=yuva420p, <transform>, <opacity>, <fade in>, <fade out>,
      fps=F, setpts=PTS+AT/TB  [vN]
```

- **edit**: `crop`, `transpose`, `hflip`.
- **zoompan** (stills with Ken Burns): zoom and position interpolated linearly from
  the `from` window to the `to` window over the clip's frames.
- **placement**: `contain` pads with transparent black so lower tracks show through
  the bars; `cover` crops to the canvas; `free` scales to `box.w` and positions at
  `box.x, box.y`.
- **look**: one `eq` with only the non-neutral terms, then `gblur`, `vignette`.
  Grayscale is saturation 0.
- **transform**: scale about the centre, then `rotate` with a transparent fill and
  the output grown to the rotated bounds. The overlay position becomes an expression,
  `base + (placed − w)/2 + dx`, so the rotated frame stays centred where the unrotated
  one sat.
- **opacity** and **fades** act on the alpha channel (`colorchannelmixer=aa`,
  `fade … :alpha=1`), so overlapping clips cross-dissolve.

The clips are then overlaid in order on a `color` source of the canvas size,
background colour and full duration, each enabled only for its own span.

Text cues are appended as `drawtext` filters, each enabled for its span. A cue with a
`sub` line draws two filters: the main line above the anchor, the second line at
80 % size below it in `subColor`.

Audio: each video clip with sound and `volume > 0`, and each audio clip, becomes a
lane with `volume`, optional `afade` in and out, `adelay` to its start and `apad`.
One lane is used as is; several are mixed with `amix … normalize=0`; none gives
`anullsrc`.

Muted tracks are skipped. Solo and the work area are applied by the client before
the sequence is sent.

## Fonts

Vendored in `server/render/fonts/`:

| Face | Used for |
|---|---|
| Anton Regular (`.ttf`) | `outline` captions and cues |
| IBM Plex Sans Bold (`.woff`) | `clean` and `box` cues |
| IBM Plex Sans Arabic Bold (`.ttf`) | Any line containing Arabic script, whatever the style |

`fontFor()` switches a line to the Arabic face when it contains a character in the
Arabic blocks; with an ffmpeg built against fribidi and harfbuzz, drawtext then
shapes and orders it correctly. FreeType loads `.ttf` and `.woff` but not `.woff2`.
At boot the server renders one frame with the caption font and logs a warning if
drawtext fails.

## Encoders

At boot the server encodes 0.2 s of `testsrc2` with `h264_nvenc`. If that succeeds,
renders and proxies use NVENC (`-preset p4 -rc vbr -cq 23`, capped at 12 Mb/s);
otherwise `libx264` (`-preset veryfast -crf 22`). `RENDER_ENCODER` forces either.
Output is H.264 High, `yuv420p`, `+faststart`, metadata stripped. `/healthz` reports
the encoder in use.

## Sources

**Links.** yt-dlp downloads the best H.264 + AAC at or below 1080p, merged to mp4,
with a size cap enforced both by `--max-filesize` and by a watchdog on the job
directory (the flag is advisory for sectioned downloads). Videos longer than
`FETCH_WHOLE_MAX_S` (15 min) need an `around` time; the server then fetches a
`FETCH_WINDOW_S` window starting a third of the window before it, with
`--download-sections`. YouTube player clients are pinned to
`mweb,web_embedded,android` (`YTDLP_PLAYER_CLIENTS`): these serve URLs that both
yt-dlp's own downloader and ffmpeg's sectioned fetch accept.

**Proxies.** Every video source is transcoded, never copied: at most 854 px on the
long edge, 30 fps, H.264 Main with a keyframe every 2 s, AAC 96 kb/s. This
normalises HEVC, VP9, AV1, variable frame rate, rotation metadata and edit lists into
something every browser seeks accurately. Audio sources get an AAC proxy and a
waveform thumbnail (`showwavespic`); images a JPEG of at most 1280 px.

Renders read only the originals on local disk. Once fetched, a source can be remixed
even if the link it came from is gone.
