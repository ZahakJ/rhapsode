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

Measured with `pro/tools/bench.sh`, holding the machine's GPU lock so no other job shares the GPU. The raw
results are the JSON files in [benchmarks/](benchmarks/). The composition is the same in every tool: three
tracks of 4K60 HEVC 10-bit, the base full frame, two graded, scaled and rotated pictures-in-picture over it.
The sources are synthetic test patterns at 60 Mb/s CBR (`rpro bench playback --prepare`), which is easier on
a decoder than camera footage of the same bitrate would be.

*The campaign is queued behind another job holding the GPU at the time of writing; this section is filled
from its output when it runs. No number appears here before it is measured.*
