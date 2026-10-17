# Premiere Pro (and DaVinci Resolve) workflows for three edits

Researched 2026-10-16. Adobe now titles the app "Adobe Premiere". The Help pages cited carry "Last updated" dates from Aug 2025 to Sep 2026. Since version 25.0 the Essential Graphics panel is replaced by the **Graphics Templates** panel (<https://helpx.adobe.com/premiere/desktop/add-text-images/use-motion-graphics-templates/where-do-i-get-motion-graphics-templates.html>). Current Resolve is 21 / 21.1 (<https://www.blackmagicdesign.com/products/davinciresolve/whatsnew>).

Counting rule: one step is one user action or one dialog filled and confirmed. "Repeat" loops (deleting many sentences, pressing angle keys many times) count once. Steps marked *(opt)* are listed but not counted.

Short URL keys (all `https://helpx.adobe.com/premiere/desktop/` + path):

| key | path |
|---|---|
| NEWPROJ | `organize-media/create-projects/create-new-project.html` |
| TRANSCRIBE | `edit-projects/edit-video-using-text-based-editing/transcribe-video.html` |
| TBE-SEQ | `edit-projects/edit-video-using-text-based-editing/edit-sequences-using-text-based-editing.html` |
| TBE-PAUSE | `edit-projects/edit-video-using-text-based-editing/detect-and-delete-pauses-in-transcripts.html` |
| TBE-OVER | `edit-projects/edit-video-using-text-based-editing/overview-of-text-based-editing.html` |
| STT | `add-text-images/insert-captions/auto-transcribe-video-using-speech-to-text.html` |
| LANGPACK | `add-text-images/insert-captions/download-language-packs-from-within-premiere.html` |
| LANGPACK-CC | `add-text-images/insert-captions/download-language-packs-from-creative-cloud.html` |
| CAPTIONS | `add-text-images/insert-captions/create-captions.html` |
| CAPSTYLE | `add-text-images/insert-captions/create-styles-for-captions.html` |
| EXPORT | `render-and-export/export-files/export-video.html` |
| EXPSET | `render-and-export/export-files/overview-of-export-settings.html` |
| EXPCAPTRK | `render-and-export/export-files/export-caption-tracks.html` |
| EXPSOCIAL | `render-and-export/export-files/export-videos-for-social-media-channels.html` |
| MC-SRC | `edit-projects/set-up-multi-camera-sequences-for-editing/create-a-multi-camera-source-sequence.html` |
| MC-TGT | `edit-projects/set-up-multi-camera-sequences-for-editing/create-and-edit-a-multi-camera-target-sequence.html` |
| AR-SEQ | `add-video-effects/commonly-used-effects/add-auto-reframe-effect-to-a-sequence.html` |
| AR-OVER | `add-video-effects/commonly-used-effects/auto-reframe-overview.html` |
| MOGRT | `add-text-images/use-motion-graphics-templates/add-motion-graphic-templates-to-a-sequence.html` |
| MOGRT-STOCK | `add-text-images/use-motion-graphics-templates/use-motion-graphics-templates-from-adobe-stock.html` |
| TAG | `add-audio-effects/adjust-volume-and-levels/audio-category-tagging.html` |
| DUCK | `add-audio-effects/adjust-volume-and-levels/automatically-duck-audio.html` |
| AUTOMATCH | `add-audio-effects/adjust-volume-and-levels/auto-match-audio-loudness.html` |
| CLOUDVOICE | `edit-projects/edit-with-generative-ai/about-cloud-based-ai-voice-features.html` |
| GENEXT | `edit-projects/edit-with-generative-ai/generative-extend-overview.html` |

---

## Task 1: 20-minute interview cut to 5 minutes, with captions (Premiere)

1. Home screen: **New Project**, then name it and pick a location. [NEWPROJ]
2. In Import mode, select the interview file. It goes into the Selection Tray. [NEWPROJ]
3. Import Settings: toggle **Create new sequence** on. [NEWPROJ]
4. Import Settings: enable **Automatic transcription** and set the language and speaker labeling. A non-English language needs its pack downloaded first (see the notes below). [TRANSCRIBE]
5. **Create** or **Import**. [NEWPROJ], [TRANSCRIBE]
6. Once transcription finishes, open the **Text-Based Editing** workspace (or **Window > Text**, Transcript tab). [TRANSCRIBE], [STT]
7. Select the **Timeline** panel to switch to the sequence transcript. [TBE-SEQ]
8. Select the unwanted sentences and **Delete** or cut them, repeating until the cut is right. Premiere ripple-deletes them on the timeline. [TBE-SEQ]
9. Transcript panel **filter icon > Filler words > Delete all**. [TBE-PAUSE]
10. Filter icon **> Pauses > Delete all**. This is the documented "remove pauses". [TBE-PAUSE]
11. Trim and refine on the timeline with the normal tools to reach 5:00. [TBE-SEQ]
12. **Window > Workspaces > Captions and Graphics**. [CAPTIONS]
13. **Captions > Create captions from transcript**. [CAPTIONS]
14. Create captions dialog: set preset (Subtitle default), format, style, length/duration/gap and lines (1 or 2), then **Create captions**. [CAPTIONS]
15. Select caption text on the timeline and style it in the **Properties** panel (font, Fill, Stroke, Shadow, Align). [CAPSTYLE]
16. **Track style** menu **+ > Create style**, name it, and **Save to Project**. The style then applies to the caption track. [CAPSTYLE]
17. **File > Export > Media** (Ctrl+M / Cmd+M) or the **Export** header tab. [EXPORT]
18. Pick the **Media File** destination, set file name and location, Format **H.264**, preset **Match Source – Adaptive High Bitrate**. [EXPORT]
19. **Captions** section > Export Options: **Burn Captions Into Video**, or **Create Sidecar File** with format **.srt**. [EXPSET], [EXPCAPTRK]
20. **Export**. [EXPORT]

*(opt)* Sidecar only, without a render: Text panel > Captions tab > **… > Export > SRT** (<https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-captions.html>).

**Count: 20 steps.** If transcription is skipped at import, it can be started later from the Text panel's **Transcribe** button. That adds one step and removes step 4. [TBE-SEQ], [STT]

Cloud, account and AI notes:
- Speech to Text runs on-device. Adobe says it works offline from 22.2 on, and "Once a language pack is installed, you can create transcriptions of your videos without an Internet connection." The feature is included in the subscription with no extra cost or usage cap (<https://www.adobe.com/uk/products/premiere/speech-to-text.html>).
- English ships with the app. Other packs are a one-time download, from the Text panel Language dropdown (Download icon) [LANGPACK] or from Creative Cloud desktop > Premiere > Get add-ons [LANGPACK-CC]. 18 languages are listed (<https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/languages-supported-by-speech-to-text.html>).
- Text-Based Editing, filler and pause detection are included in the subscription [TBE-OVER]. Adobe credits "Adobe Sensei's AI" for transcription [TBE-OVER].
- Help warns: "Text-Based Editing doesn't support the captions workflow. Generate captions using your final edited sequence." [TBE-OVER]
- Cloud-only features nearby, not needed here: **Separate Crosstalk** uploads audio, needs sign-in and internet, and asks for biometric/voice consent [CLOUDVOICE]. **Generative Extend** (Firefly) needs internet and a cloud model [GENEXT]. It does not work with Speech to Text, Text-Based Editing or Captioning [GENEXT].
- The whole app needs an Adobe account and a paid Creative Cloud subscription. No step above needs a paid add-on.

---

## Task 2: 3-camera podcast synced by sound (Premiere)

1. **New Project**, select the three camera files in Import mode (Create new sequence off), **Create**. [NEWPROJ]
2. Select the three clips in the Project panel and choose **Clip > Create Multi-Camera Source Sequence**. [MC-SRC]
3. Synchronize Point: **Audio**. [MC-SRC]
4. Sequence Preset **Automatic** (follows Camera 1). *(opt)* **Offset Audio by** (-100..+100 frames), **Move Source Clips to Processed Clips bin**. [MC-SRC]
5. Audio sequence settings: **Camera 1**, **All Cameras** or **Switch Audio**. For a podcast with a shared mix, use Camera 1 or All Cameras. Only **Switch Audio** allows audio-follows-video. [MC-SRC]
6. Audio channels preset (**Automatic**/Mono/Stereo/5.1/Adaptive) and camera names (**Enumerate Cameras** / track / clip names). [MC-SRC]
7. **OK**. [MC-SRC]
8. Right-click the multicam source in the Project panel, then **New Sequence from Clip**. [MC-TGT]
9. Program Monitor **Button Editor**: drag **Toggle Multi-Camera View** to the button bar. This is a one-time setup. [MC-TGT]
10. Click **Toggle Multi-Camera View** to show all angles. [MC-TGT]
11. *(opt)* Wrench > **Overlays** for angle numbers. [MC-TGT]
12. **Spacebar** to play. While it plays, press **1 / 2 / 3** on the main keyboard to cut to that camera. [MC-TGT]
13. Stop and play back to review the cuts. [MC-TGT]
14. Fix-ups: select a segment and click another angle in the Program Monitor. Use the **Rolling Edit** tool to move a cut. [MC-TGT]
15. *(finish)* Select all multicam clips and choose **Clip > Multi-Camera > Flatten**. Help is silent on this. Flatten cannot be undone later, so keep a copy (Larry Jordan, <https://larryjordan.com/articles/premiere-pro-cc-multicam-cookbook/>, 2013 / updated 2020). Flatten can also miss clips (<https://community.adobe.com/t5/premiere-pro-discussions/flatten-clip-multicam-not-working-on-audio/td-p/15007428>).
16. **File > Export > Media** (Ctrl/Cmd+M). [EXPORT]
17. Media File destination, name/location, H.264, Match Source – Adaptive High Bitrate. [EXPORT]
18. **Export**. [EXPORT]

**Count: 17 steps** (step 11 optional). That falls to 16 if the button bar already has Multi-Camera View, and to 15 if you skip Flatten, which is not required for export.

Keys: current Help says to press "the number key on the main keyboard" [MC-TGT]. Older Larry Jordan guidance gives Ctrl+1–9. Check your keyboard shortcuts.

Cloud/account: nothing in this flow is cloud or AI. Audio sync is local waveform matching. Optional cloud add-on: **Separate Crosstalk** for overlapping podcast voices, which needs sign-in, internet and voice-data consent, and is unavailable on files uploaded from Illinois or Texas [CLOUDVOICE].

---

## Task 3: 60-second 9:16 social video from a 16:9 interview (Premiere)

Assumes the 60 s cut and the music file are already in the project (import as in Task 1, steps 1–5).

1. Select the 16:9 sequence in the Project panel and choose **Sequence > Auto Reframe Sequence**. [AR-SEQ]
2. Target Aspect Ratio **Vertical 9:16**. *(opt)* custom Resolution, e.g. 1080×1920 (new in 2026). [AR-SEQ], [AR-OVER]
3. Motion Tracking **Slower Motion**, which Help recommends for talking-head interviews. [AR-SEQ]
4. Clip nesting off, unless the cut has complex motion keyframes or speed changes. Confirm the dialog. [AR-SEQ]
5. Open the new duplicate sequence from the **Auto Reframe Sequences** bin. [AR-SEQ]
6. Open the **Graphics Templates** panel, **My Templates** tab. [MOGRT]
7. Drag a title template onto a video track above the interview. [MOGRT]
8. Edit the text and look in the **Properties** panel, **Edit** tab. [MOGRT]
9. Drag the music clip onto an empty audio track (uncited: basic timeline action).
10. Select the dialogue and music clips, then **Essential Sound > Auto Tag**. Check that speech shows Dialogue and the song shows Music. [TAG]
11. Select the music clip: **Ducking** on, **Duck Against: Dialogue**, then set Sensitivity, Duck Amount, Fade Duration and Fade Position. [DUCK]
12. **Generate Keyframes**. Premiere adds an Amplify effect with gain keyframes. [DUCK]
13. Select the dialogue clips: **Essential Sound > Loudness > Auto-Match**. The measured LUFS shows under the button. [AUTOMATCH] The target is fixed per type: dialogue -23 LUFS (<https://larryjordan.com/?p=82186>), music -25, SFX -21, ambience -30 (<https://www.lynda.com/Premiere-Pro-tutorials/Using-Essential-Sound-panel-Loudness-dynamics/758641/2215703-4.html>). **It cannot hit -14 LUFS by itself.**
14. **File > Export > Media** (Ctrl/Cmd+M). [EXPORT]
15. Media File destination, name/location, H.264, Match Source – Adaptive High Bitrate. [EXPORT], [EXPSOCIAL]
16. Export **Effects** section: tick **Loudness Normalization**, set Loudness Standard **ITU BS.1770-3** and Target Loudness **-14 LUFS** (<https://producer.musicradiocreative.com/audio-loudness-explained-premiere-pro-secret-feature>). Adobe Help lists the Effects section [EXPSET] but does not document this control. A Community Expert recommends it for YouTube (<https://community.adobe.com/t5/premiere-pro-discussions/is-it-possible-to-normalize-audio-based-on-average-instead-of-peak/m-p/14887160>). A known export error happens when channel counts mismatch (<https://community.adobe.com/t5/premiere-pro-bugs/exporting-video-with-loudness-normalization-produces-empty-error-window/idc-p/15568463>).
17. *(opt)* PUBLISH: toggle TikTok, YouTube and others, sign in, and add a title and tags. [EXPSOCIAL]
18. **Export**. [EXPORT]

**Count: 17 steps** (step 17 optional). That is 16 if you skip Auto-Match (step 13), since the export normalization alone sets the final -14 LUFS.

Cloud, account and AI notes:
- Auto Reframe, Auto Tag and Auto Ducking are Adobe AI features. The Help pages say nothing about sign-in or internet for them, and none mention credits [AR-SEQ], [TAG], [DUCK]. Contrast Generative Extend, which "requires" internet and a cloud model [GENEXT].
- **My Templates** in the Graphics Templates panel are local. **Adobe Stock** templates need sign-in and a license ("Buy License and Download") [MOGRT-STOCK].
- Direct publishing needs you logged in to each social account [EXPSOCIAL].
- Firefly-backed features are unavailable in Russia, Belarus and China, and for some K-12 and CCE v3 enterprise licences [GENEXT].

---

## DaVinci Resolve equivalents (brief; Resolve 20/21)

The cited third-party guides quote the official Reference Manual (a large PDF from documents.blackmagicdesign.com). I did not open it directly. davinciresolveclub.com states page numbers it checked against the 21.1 manual.

### R1: interview cut + captions (Studio-only for transcription and auto-subtitles)
1. Import the clip (Cmd/Ctrl+I) (<https://larryjordan.com/articles/get-started-multicam-editing-in-davinci-resolve/>).
2. Media Pool: right-click **AI Tools > Audio Transcription > Transcribe** (<https://davinciresolveclub.com/transcribe-audio-davinci-resolve.md>).
3. Open the Transcription window and click the **Timeline** icon for timeline mode (same).
4. Select unwanted text and **Delete**. This edits the timeline (same).
5. **… > Remove Silent Portions** (same; <https://davinciresolveclub.com/remove-silence-davinci-resolve.md>).
6. **Timeline > AI Tools > Create Subtitles from Audio**, set language, preset, chars/line and lines, then **Create** (<https://larryjordan.com/articles/transform-horizontal-to-vertical-video-and-create-captions-in-davinci-resolve-20/>; DRC above).
7. Style and edit in **Inspector > Caption** (Larry Jordan R20 above).
8. **Deliver** page. Subtitles burn in by default, or use **File > Export > Subtitle** (SRT/VTT) for a sidecar (same).
9. **Add to Render Queue** (<https://site.creativelive.com/class/davinci-resolve-how-to-use-every-page-casey-faris/lessons/deliver-page-basic-workflow>).
10. **Render All** (same).

**Count: 10.** Studio ($295) is needed for transcription and Create Subtitles from Audio. The free version only imports and edits subtitle files (DRC). Local vs cloud is disputed: DRC (R21.1) says transcription runs locally on the Neural Engine, with language packs downloaded first. Larry Jordan (R20, July 2025) says Resolve sends extracted audio to the cloud.

### R2: 3-camera multicam by sound (free version)
1. Import the three files (Cmd/Ctrl+I) (Larry Jordan Resolve multicam, above).
2. Select them in the Media Pool, right-click **Create Multicam Clip Using Selected Clips** (same; <https://davinciresolveclub.com/davinci-resolve-multicam-editing/>, manual p.1036).
3. Dialog: name, **Angle Sync: Sound**, Multicam Audio, Angle Name, then **Create** (DRC).
4. Drag the multicam clip to the timeline (or Shift+F12) (Larry Jordan).
5. Set the source viewer to **Multicam** (Larry Jordan).
6. Play, then press **1–9** or click angles to cut. **Option/Alt+number** switches without a cut (Larry Jordan; DRC).
7. Right-click the clip > **Flatten Multicam Clip** (Retaining Grades from Angles) (Larry Jordan).
8. Deliver page: **Add to Render Queue** (creativelive above).
9. **Render All** (same).

**Count: 9.** Free version. SmartSwitch (auto angle) is Studio-only (DRC). Larry Jordan advises turning off "Stop playback when dropped frame is detected" first.

### R3: 9:16 social video (Smart Reframe Studio-only)
1. Media Pool: right-click the timeline and choose **Duplicate Timeline** (Larry Jordan R20 vertical, above).
2. Right-click the copy > **Timelines > Timeline Settings**: untick Use Project Settings, tick **Use vertical resolution**, set 1080×1920, **OK** (same).
3. Select all clips (Cmd/Ctrl+A), then **Inspector > Video > Transform > AI Smart Reframe > Reframe** (same). Studio-only per <https://tryuncle.com/learn/davinci-resolve/davinci-resolve-smart-reframe-not-working>.
4. Add a title from the Effects library (Titles) to a track above. Not found in the sources opened; uncited.
5. Music track: Track FX **Ducker** on, **Source** = dialogue track, then tune duck level and recovery (<https://davinciresolveclub.com/davinci-resolve-audio-ducking/>, manual p.1120; <https://blackmagicdesign.com/fairlight>). Free version. AI Audio Assistant (whole-mix ducking) is Studio-only.
6. **Deliver** page (Shift+8), then pick format/preset (<https://larryjordan.com/articles/three-hidden-audio-secrets-that-will-improve-your-audio-in-davinci-resolve/>).
7. **Audio** tab: tick **Normalize Audio**, choose **Optimize to Standard**, Standard **YouTube** (same). Resolve measures, then adjusts in two passes. A YouTube-preset bug was reported in 18.6.3 (<https://forum.blackmagicdesign.com/viewtopic.php?p=1004123>).
8. **Add to Render Queue** (creativelive above).
9. **Render All** (same).

**Count: 9.** Studio is needed for Smart Reframe. Resolve 20 adds direct upload to TikTok, YouTube, X and Vimeo (<https://www.notebookcheck.net/Blackmagic-launches-DaVinci-Resolve-20-with-new-features-social-media-creators-and-film-editors-will-want.993565.0.html>).

---

## Step counts

| Task | Premiere | Resolve |
|---|---|---|
| 1. Interview 20→5 min + captions | 20 | 10 (Studio) |
| 2. 3-cam podcast, audio sync | 17 | 9 (free) |
| 3. 60 s 9:16 social, ducking, -14 LUFS | 17 | 9 (Studio for Smart Reframe) |
