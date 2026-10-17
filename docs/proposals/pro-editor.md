# Pro editor

Rhapsode has two modes and one product. **Quick mode** is the web app: paste a link, cut, dub / PiP / stack,
caption, share. **Pro** is a native non-linear editor for the desktop, built for long, multi-track, colour-
and sound-heavy work. A quick clip opens in Pro; a Pro export publishes to a share link.

The competitive study is in [COMPETITION.md](../COMPETITION.md). This document is the plan and the bars the
plan is measured against.

## Why native

Real-time playback of a multi-track 4K timeline with effects means decoded frames, the compositor and the
viewer live in one process on the GPU. The current studio renders on the server with one ffmpeg command and
previews with two `<video>` elements kept in step by hand; that cannot scrub a 4K multicam.

**UI choice, in one line:** the UI is native (Dear ImGui on SDL3 GPU) because a browser over a local engine
would have to copy or re-encode every viewer frame across a process boundary, which is exactly the cost the
engine exists to avoid.

## Architecture

```
pro/
  engine/            librhap: C++20, no UI
    time.h           rational time in flicks (1/705 600 000 s): every common frame and sample rate is exact
    model/           project, sequences, tracks, clips, keyframes, markers; edit ops; undo
    io/              project files (atomic, journalled), autosave + recovery, interchange
    media/           probe, decode (NVDEC → CPU fallback), frame cache, prefetch, proxies
    gfx/             SDL3 GPU device, compositor, colour, scopes, text and shapes
    audio/           mixer, track FX, loudness (BS.1770-4), playback clock
    render/          export (libavcodec: NVENC, ProRes, DNxHR, AV1), presets, queue, smart render
    ai/              transcription (whisper.cpp, CUDA), silence, scenes, reframe, matte
  app/               rhapsode-pro: the editor
  tools/             rpro: headless import / export / render / bench
  tests/             doctest; GPU tests skip without a Vulkan device
```

- **Time.** One integer tick type. A flick divides 24, 25, 30, 48, 50, 60, 23.976, 29.97, 59.94 fps and 44.1,
  48, 96 kHz exactly, so edits never drift and round trips are exact.
- **Model.** A project is a value: media pool, sequences, settings. A clip refers to a media item or to a
  sequence (nesting, compound clips, multicam). Edit operations are pure functions `Sequence → Sequence` with
  checked invariants (no overlap within a track, no negative durations, sources inside media bounds). Undo is
  a stack of snapshots, so every op is undoable by construction.
- **Decode.** libavformat/libavcodec 8. NVDEC through `hw_device_ctx` (H.264, HEVC 8/10-bit, AV1, VP9),
  software for ProRes, DNxHR and everything else. Frames arrive as NV12 / P010 / planar YUV and are uploaded as
  planes; YUV→RGB happens in the shader with the stream's own matrix, range and transfer. VFR: frames are
  addressed by their real timestamps, never by `n / fps`.
- **Cache and prefetch.** A decoder per (media, track) with a GOP-aware seek; a ring of decoded frames ahead
  of the playhead per layer; an LRU texture cache keyed by (media, pts).
- **Proxies.** Generated in the background on import (H.264 NVENC, ½ or ¼ size, all-intra option), switched
  per viewer, never at export. Original and proxy share one timebase, as in quick mode.
- **Compositor.** Linear-light RGBA16F working buffer. Per layer: YUV → linear in the working space →
  crop / transform / opacity / blend → primary grade (lift, gamma, gain, offset, saturation, curves) → 3D LUT →
  composite. Output transform to the display (Rec.709 / sRGB, or PQ / HLG for HDR monitoring). Titles and
  shapes are layers like any other.
- **Colour management.** Built-in transforms for Rec.709, Rec.2020, Display P3, PQ, HLG, sRGB and an ACEScct
  working space (AP1 primaries, ACEScct grading curve). With OpenColorIO (2.5, built into the build dir) the
  output goes through any display/view of its built-in ACES 2.0 studio config, SDR and HDR, and a clip can be
  tagged with its camera encoding (S-Log3, LogC3/4, V-Log, Canon Log, Apple Log, …). Both transforms are baked
  to 65³ LUTs on a log (ACEScct) signal and checked against OCIO's own CPU processor.
- **Scopes.** Waveform, RGB parade, vectorscope and histogram. The GPU downscales the composited frame to
  480×270; the counts are taken on the CPU from that (every sixth frame while playing). A compute-shader
  path is a later step if the CPU ever becomes the limit.
- **Audio.** Decode to 48 kHz float, a mixer of tracks and buses with gain / pan keyframes, track FX (EQ,
  compressor, gate, limiter, de-noise), a BS.1770-4 meter (momentary, short-term, integrated, true peak, LRA),
  normalise-to-target, auto-duck from dialogue to music. The audio device clock drives playback.
- **Export.** The same compositor, offline, frame-exact, into libavcodec. Presets: YouTube 1080p / 4K, social
  verticals, ProRes 422 HQ master, DNxHR HQX, HEVC 10-bit HDR. Renders run in a separate process (`rpro
  render`), so a crash in an export never takes the editor down, and they queue.
- **Smart render.** Exports are cut into closed-GOP segments keyed by a hash of everything that affects their
  pixels and samples; an unchanged segment is reused from the last export, not re-encoded.
- **Project files.** JSON with a checksum, written to a temp file, fsynced and renamed; the previous five
  versions are kept. An autosave beside the project is written two seconds after the last change (atomic,
  checksummed like the project) and offered on the next open. A journal was planned; the autosave met the
  bar without one.
- **Interchange.** OTIO, FCPXML 1.10, CMX 3600 EDL export and import; Premiere / FCP7 XML (xmeml) import.
  The web studio's sequence JSON opens directly.
- **Local AI.** whisper.cpp for transcripts with word times (CPU build here; CUDA is a build flag); the transcript is an editing surface
  (delete words → ripple delete). Silence, scene and loudness analysis in the engine. Background matte and
  voice isolation run local models (Demucs is already used by quick mode). No network calls, no accounts.

## Milestones and bars

Each bar is a test in `pro/tests` or a measurement in `docs/BENCHMARKS.md`. A milestone is done when its
bars pass on this machine (RTX 4070 SUPER, 16 threads, Linux).

### M1 — core
- Flicks time, project model, all edit ops: insert, overwrite, lift, extract, ripple delete, razor, ripple /
  roll / slip / slide trim, nest, markers; undo / redo.
  *Bar:* a property test runs 100 000 random edits and checks the invariants after each; save → load is
  byte-identical.
- Decode (NVDEC and software), frame-exact seek, VFR by timestamp.
  *Bar:* frame-exact seek on CFR and VFR fixtures in H.264, HEVC 10-bit, AV1, ProRes, DNxHR.
- GPU compositor, transforms, opacity, primary grade, LUT; headless frame render.
  *Bar:* rendered frames match references (PSNR > 45 dB).
- Export with NVENC / ProRes / DNxHR and audio.
  *Bar:* export of a 3-track 1080p sequence is frame-accurate (each output frame's timestamp and content
  checked).

### M2 — the editor
- Viewer, timeline, media bin, inspector, J/K/L, Premiere keymap and Rhapsode's own default map.
- Real-time playback with prefetch; proxies in the background.
  *Bar:* 3 layers of 4K60 HEVC 10-bit with transform + grade play at 60 fps with 0 dropped frames over
  60 s; seek-to-frame under 100 ms on 4K long-GOP.
- Autosave and crash recovery.
  *Bar:* `kill -9` during an edit session loses at most the last 2 s of edits; a truncated project file
  never loads as a different project.

### M3 — colour and sound
- Scopes, curves, wheels, LUTs, colour management, HDR output.
  *Bar:* scopes match a CPU reference; PQ / HLG round trips within 1 code value at 10-bit.
- Mixer, track FX, keyframes, LUFS meter, normalise, duck.
  *Bar:* the meter reads within 0.1 LU of ffmpeg's `ebur128` on the EBU test signals; normalising lands
  within 0.5 LU of target.

### M4 — titles, graphics and motion
- Text with shaping (Arabic included), shapes, keyframes with easing curves, motion paths, templates.

### M5 — local AI
- Transcripts to editable captions, text-based editing, silence removal, scene detection, auto-reframe,
  background removal, voice isolation.
  *Bar:* a 20-minute interview transcribes faster than 10× real time; silence removal is sample-exact on
  synthetic fixtures.

### M6 — delivery and interchange
- Presets, render queue, smart render; OTIO / FCPXML / EDL in and out, Premiere XML in; web round trip
  (open a quick clip in Pro, publish a Pro export to a share link).
  *Bar:* interchange fixtures round-trip; re-exporting an unchanged project re-encodes nothing.

## Benchmarks

Tasks, timed in steps and seconds, against each editor's documented workflow:

1. Cut a 20-minute interview to 5 minutes with captions.
2. A 3-camera podcast edit, synced by sound.
3. A 60-second vertical with titles, music ducked under speech, loudness at −14 LUFS.

Machine measurements: playback fps and dropped frames on the M2 timeline, export speed for each preset,
seek latency, time to first frame after opening a project. Compared with Kdenlive (installed from Flathub)
and with ffmpeg as a floor. Resolve and Premiere are not installed on this machine; where they are compared,
the comparison is with their documented workflow, never with invented numbers.

## Status (2026-10-16)

Built and tested: M1 in full; M2 except the playback bar, which is measured and recorded in
[BENCHMARKS.md](../BENCHMARKS.md) when the GPU is free of other work; M3 (scopes on the CPU as above); M4 except motion paths drawn on the viewer and title templates; M5 (transcription, text editing,
captions, silence, scenes, reframe, background removal, noise reduction, voice isolation); M6 except
smart render. The tests named in [pro/README.md](../../pro/README.md#tests) are the proof for each.
