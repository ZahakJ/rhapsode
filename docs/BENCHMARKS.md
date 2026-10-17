# Benchmarks

Everything here was measured or counted on one machine and says so. Where another editor is not installed
here, the comparison is with its own documentation, never with a number we made up.

## Workflow: steps to a finished file

One step is one user action, or one dialog filled and confirmed; a repeated action (deleting many sentences,
pressing angle keys while playing) counts once. Premiere's and Resolve's steps are their documented
workflows, each step cited, in [benchmarks/premiere-resolve-workflows.md](benchmarks/premiere-resolve-workflows.md)
(researched 2026-10-16). Rhapsode Pro's are the actions in the editor as built at the same date.

| Task | Rhapsode Pro | Premiere | Resolve |
|---|---|---|---|
| 1. A 20-minute interview cut to 5 minutes, with captions | **10** | 20 | 10 (transcription and subtitles need Studio) |
| 2. A 3-camera podcast synced by sound | **8** | 17 | 9 |
| 3. A 60 s 9:16 social video: reframed, a title, music ducked, −14 LUFS | **9** | 17 | 9 (Smart Reframe needs Studio) |

Rhapsode Pro matches Resolve's count and halves Premiere's. Every step below runs on this machine with no
account and no network; the same is true of Premiere's speech-to-text once its language pack is installed,
and of Resolve's free features.

**1. Interview** — (1) drop the file on the window (the empty sequence takes its size and rate); (2) `.` to
lay it on the timeline; (3) click the clip; (4) Clip ▸ Transcribe; (5) in the Transcript, select the
sentences to lose and press Delete, as often as needed; (6) Remove filler words; (7) Remove pauses;
(8) Captions; (9) the Export tab; (10) Queue export (captions are titles, so they burn in). An SRT sidecar
is one more press (Export SRT).

**2. Podcast** — (1) drop the three camera files on the window; (2) ctrl-click them in Media; (3) Multicam
(sync by sound) — the clip lands at the playhead with its sound and the viewer shows every angle; (4) play
and press 1, 2, 3 to cut; (5) play it back; (6) fix a cut with the Roll tool (N, drag); (7) the Export tab;
(8) Queue export. Nothing needs flattening first.

**3. Social** — (1) Sequence ▸ Vertical copy, reframed; (2) Sequence ▸ Add title ▸ Lower third; (3) type
the name in the Inspector; (4) drag the music onto A2; (5) Sequence ▸ Duck music under dialogue;
(6) Sequence ▸ Normalise loudness to −14 LUFS; (7) the Export tab; (8) the "Social vertical" preset;
(9) Queue export.

Task 1 also runs end to end without a person, as `rpro bench interview`: a synthesised 20-minute talk
(espeak-ng, so the words are known) is imported, transcribed, stripped of fillers, cut to one sentence in
four, captioned and exported, each step timed. Its numbers are below.

## Machine

Measured on 2026-10-17 with `pro/tools/bench.sh` on an RTX 4070 SUPER (driver 610.57), a Ryzen 7 7800X3D
and Linux 7.1. The GPU is shared with other work, so every GPU step waited until the GPU had been idle for
a minute (no other compute process, under 10% use), then ran holding the machine's GPU lock. Only the
last step (the proxies run) also recorded what was on the GPU when it ended: nothing else
([benchmarks/gpu-steps.txt](benchmarks/gpu-steps.txt)); for the others, whether another job started
mid-step is not recorded. [benchmarks/gpu-state.txt](benchmarks/gpu-state.txt) is the GPU when the
campaign started and ended, before its first wait and after its last step. The raw results are the JSON files in
[benchmarks/](benchmarks/).

The composition is the same in every tool: three tracks of 4K60 HEVC 10-bit, the base full frame and two
graded, scaled and rotated pictures-in-picture over it. The sources are synthetic test patterns at 60 Mb/s
CBR (`rpro bench playback --prepare`), which is easier on a decoder than camera footage of the same
bitrate.

### Playback

| Run | fps | Dropped | Frame p50 / p99 / max | Seek p50 / p95 |
|---|---|---|---|---|
| 4K60 × 3, real time, 60 s | 60.0 | **0** | 8.7 / 13.6 / 22.8 ms | 382 / 658 ms |
| 4K60 × 3, as fast as it goes | 85.9 | — | 10.6 / 29.3 / 55.4 ms | 367 / 647 ms |
| 4K60 × 3 on all-intra proxies, real time | 60.0 | 0 | 0.4 / 0.6 / 2.5 ms | **26 / 34 ms** |
| 1080p30 H.264 × 3, real time, 60 s | 30.0 | 0 | 0.8 / 1.9 / 3.0 ms | 122 / 204 ms |

The playback bar (60 fps, 0 dropped frames over 60 s) is **met**. The seek bar (under 100 ms on 4K
long-GOP) is **not met**: a seek decodes forward from the last keyframe, and on these sources that takes
380 ms at the median. On the editor's own proxies (half size, all-intra H.264, made with Make proxies) a seek takes 26 ms at
the median and 34 ms at p95, so editing long-GOP 4K with proxies on stays under the bar. The slowest seek,
368 ms, is the first one, when the decoders open.

Kdenlive's engine (MLT 7.43, flatpak) renders the same 20 s of the composition to a null consumer at
**15.6 fps** (1200 frames in 76.9 s), against 85.9 fps for Rhapsode Pro.

### Export (the first 20 s of the composition)

| Tool | Encoder | Time | fps | × real time |
|---|---|---|---|---|
| Rhapsode Pro, youtube-4k | hevc_nvenc, 10-bit | 20.6 s | 58.2 | 0.97 |
| Rhapsode Pro, prores-hq | prores_ks (CPU) | 80.8 s | 14.9 | 0.25 |
| Kdenlive (melt) | libx265 (its flatpak has no NVENC) | 127.8 s | 9.4 | 0.16 |
| ffmpeg, one filter graph | NVDEC + hevc_nvenc, filters on the CPU | 118.7 s | 10.1 | 0.17 |

The ffmpeg graph decodes on the GPU but grades, scales and rotates on the CPU (`eq`, `scale`, `rotate`),
as most ffmpeg pipelines do. It is the plain-ffmpeg way to make this composition, not a lower bound.
Kdenlive's export is held back by its CPU encoder; its null-consumer run above isolates its compositing.

### Task 1 without a person

`rpro bench interview`: a synthesised 19.1-minute talk (espeak-ng) cut to 4.4 minutes with captions.

| Step | Time |
|---|---|
| Import | 0.01 s |
| Transcribe (whisper.cpp, ggml-base, CUDA), 3639 words | 8.1 s (141× real time) |
| Remove 61 filler words | < 0.01 s |
| Delete sentences by text, 100 cuts | < 0.01 s |
| Captions, 76 cues | < 0.01 s |
| Export 720p H.264 (NVENC) | 18.5 s |
| **Total** | **26.7 s** |

The transcription bar (a 20-minute interview faster than 10× real time) is **met** with the base model.
Synthesised speech is cleaner than a real interview, and a larger model is slower. Word error rate is not
measured here.
