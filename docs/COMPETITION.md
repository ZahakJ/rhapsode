# Competitive study: video editors (October 2026)

Input for the design of a pro non-linear editor: native C++ engine, GPU
playback, local-only AI, open project interchange. It sits beside Rhapsode's
quick web clip tool, not in place of it.

Method and limits:

- Sources are vendor docs, release notes, pricing pages, bug trackers,
  vendor forums (Adobe Community, Blackmagic Forum, Apple Discussions,
  forum.shotcut.org, discuss.kde.org) and trade press, mostly 2024 to 2026.
- reddit.com could not be fetched for this study; forum evidence comes from
  vendor forums and GitHub instead. A forum thread is one user's report,
  not a failure rate.
- Pricing pages from aggregators are flagged where used. Re-check prices
  before quoting them.
- "?" means no source was found, not "no".

---

## 1. Adobe Premiere (Pro)

Renamed "Adobe Premiere" at version 26 (Jan 2026)
([PetaPixel](https://petapixel.com/2026/01/20/rebranded-adobe-premiere-26-arrives-with-one-click-object-tracking)).

### Complaints

- **Stability.** Long-running Adobe Community threads report constant crashes
  with H.265, H.264 and iPhone footage across 25.1 to 25.6
  ([thread](https://community.adobe.com/t5/premiere-pro-bugs/p-crashing-constantly-with-h-265-h-264-and-iphone-footage-happens-in-v25-1-to-v25-6/idc-p/15546630),
  [thread](https://community.adobe.com/bug-reports-728/p-crashing-constantly-with-h-265-footage-happens-in-v25-1-25-2-and-25-3-1331909)).
  Paid users list crashes, freezes and export failures on high-end PCs
  ([thread](https://community.adobe.com/t5/premiere-pro-bugs/premiere-pro-constant-crashes-amp-bugs-despite-paid-subscription/idi-p/15619847)).
- **Lost projects.** "Project appears to be damaged" with every autosave also
  unreadable ([2025 thread](https://community.adobe.com/t5/premiere-pro-bugs/premiere-pro-2025-project-file-corrupted-amp-autosaves-also-won-t-open/idc-p/15457446)).
  An Adobe community manager notes autosave can faithfully save an
  already-corrupt project ([beta thread](https://community.adobe.com/t5/premiere-pro-beta-bugs/ongoing-issue-damaged-project-files-in-premiere-pro-beta/idi-p/15531960)).
- **Playback.** A 15-track 4K H.264 test dropped 950 frames on 25.1 and none
  on 25.0 ([thread](https://community.adobe.com/t5/premiere-pro-discussions/slowing-down-the-premiere-25-1-timeline/m-p/15122435));
  playback degrades after minutes of editing even on strong hardware
  ([thread](https://community.adobe.com/t5/premiere-pro-discussions/premiere-pro-playback-lag-even-with-good-specs-looking-for-reliable-fixes/td-p/15599572)).
- **Proxies.** Timeline got slower *with* proxies after 25.2.3
  ([bug](https://community.adobe.com/t5/premiere-pro-bugs/timeline-lagging-even-with-proxies/idc-p/15362903)).
- **A/V sync with phone footage.** VFR clips drift; the community fix is an
  external CFR transcode, and Media Encoder does not help because it shares
  Premiere's decoders ([thread](https://community.adobe.com/t5/premiere-pro-discussions/alternatives-to-handbrake-handbrake-not-converting-variable-to-constant-like-it-used-to/m-p/8945393/highlight/true),
  [sync thread](https://community.adobe.com/questions-729/audio-video-synch-issue-sometimes-1401997)).
- **Pricing.** Subscription only. All Apps became "Creative Cloud Pro" with a
  price rise in June 2025 ([The Register](https://www.theregister.com/2025/05/20/adobe_price_hikes/),
  [PetaPixel](https://petapixel.com/2025/05/20/if-you-have-adobe-creative-cloud-your-price-could-increase-next-month)).
  Single app is commonly listed at $22.99/mo on annual billing (aggregator:
  [josephnilo.com](https://josephnilo.com/blog/adobe-premiere-pro-cost/)).
  Reviews flag cost and resource weight ([Creative Bloq 25.1](https://www.creativebloq.com/reviews/adobe-premiere-pro-review),
  [G2](https://www.g2.com/survey_responses/adobe-premiere-pro-review-743492)).
- **Cloud AI.** Generative Extend runs on Adobe servers and was announced to
  move to Firefly credits ([NewscastStudio](https://www.newscaststudio.com/2025/04/03/adobe-brings-generative-extend-media-intelligence-to-premiere-pro),
  [ETCentric](https://www.etcentric.org/?p=192114)).
- **Collaboration.** Frame.io panel replacing Effect Controls with a login
  error after 25.1 ([thread](https://community.adobe.com/t5/premiere-pro-discussions/frame-io-unsupported-account-what-is-frame-io/m-p/15228794)).
- **Platform.** Windows and macOS only ([tech requirements](https://helpx.adobe.com/hu/premiere-pro/system-requirements.html)).

### Loved

- Industry default; PCMag's top pick for professionals ([PCMag via Yahoo](https://tech.yahoo.com/general/articles/best-video-editing-software-2024-144511939.html)).
- Text-based editing with automatic ripple ([helpx](https://helpx.adobe.com/premiere-pro/using/video/text-based-editing-video.html)).
- On-device transcription and Enhance Speech, no internet needed
  ([community](https://community.adobe.com/t5/premiere-pro-beta-discussions/discuss-speech-to-text-is-now-on-device/m-p/12529465),
  [Enhance Speech](https://community.adobe.com/announcements-732/now-released-enhance-speech-in-premiere-pro-313485/index3.html)).
- Familiar keymap with FCP7 / Avid layout presets ([PremiumBeat](https://www.premiumbeat.com/blog/premiere-pro-keyboard-shortcuts)).

### Feature specifics

- **Proxy:** Ingest settings queue proxies in Media Encoder in the background;
  Toggle Proxies in the Program monitor ([helpx](https://helpx.adobe.com/premiere-pro-next/organize-media/ingest-proxy-workflow/configure-ingest-settings.html)).
- **Scopes:** Lumetri Scopes, waveform and YUV/HLS vectorscope ([PremiumBeat](https://www.premiumbeat.com/blog/read-lumetri-scopes-premiere-pro)).
- **Colour:** 25.2 added colour-space-aware Lumetri and automatic log/raw
  to SDR/HDR in a wide-gamut ACEScct pipeline ([Puget](https://www.pugetsystems.com/blog/2025/04/07/adobe-premiere-pro-and-after-effects-whats-new-in-version-25-2/),
  [helpx 25.2](https://helpx.adobe.com/au/premiere-pro/using/whats-new/2025-2.html)).
- **Audio:** Essential Sound loudness Auto-Match, Enhance Speech (local,
  dialogue only) ([community](https://community.adobe.com/t5/premiere-pro-discussions/what-is-the-most-efficient-way-to-level-out-audio/m-p/14879200/highlight/true)).
- **AI:** Media Intelligence search runs locally; Object Mask (26.0) runs
  on-device; Generative Extend is cloud ([NewscastStudio](https://www.newscaststudio.com/2025/04/03/adobe-brings-generative-extend-media-intelligence-to-premiere-pro),
  [PetaPixel](https://petapixel.com/2026/01/20/rebranded-adobe-premiere-26-arrives-with-one-click-object-tracking)).
  Scene Edit Detection since 14.4 ([helpx](https://helpx.adobe.com/premiere-pro/using/video/scene-edit-detection-video.html)).
- **Interchange:** OTIO import/export (beta from Oct 2024; 25.6+ per
  [Remotion](https://www.remotion.dev/docs/export-opentimeline)),
  ([Adobe beta post](https://community.adobe.com/t5/premiere-pro-beta-discussions/now-in-beta-otio-import-and-export/m-p/14985932));
  FCP7 XML is the recommended Premiere path ([OTIO docs](https://opentimelineio.readthedocs.io/en/v0.15/tutorials/adapters.html)).
  No UXP scripting access to EDL/AAF/XML/OTIO export ([forum](https://forums.creativeclouddeveloper.com/t/export-apis-for-edl-omf-aaf-xml-opentimelineio/11616)).
- **Export:** Background queue through Media Encoder (same ingest doc).

---

## 2. DaVinci Resolve (free and Studio)

### Complaints

- **Free-tier caps.** Free stops at UHD 60 fps; Studio adds 32K/120 fps,
  multi-GPU, hardware H.264/H.265 encode/decode, 10-bit codecs, HDR grading,
  and nearly all Neural Engine AI ([Studio page](https://www.blackmagicdesign.com/products/davinciresolve/studio)).
  Transcription is reported Studio-only ([FireCut](https://firecut.ai/blog/how-to-use-auto-captions-in-davinci-resolve-a-complete-guide/)).
- **Linux codecs.** AAC audio is unsupported on Linux in any edition
  (Blackmagic staff, [forum](https://forum.blackmagicdesign.com/viewtopic.php?p=1024570));
  free Linux has partial or no H.264/H.265 ([NixOS wiki](https://wiki.nixos.org/wiki/DaVinci%20Resolve),
  [ProVideo Coalition](https://www.provideocoalition.com/aac-audio-kdenlive-beats-davinci-resolve-studio-on-linux/)).
- **Playback and freezes in 20.x.** Whole-app stalls during playback, freezes
  on fast scrubbing, 5 fps 1080p after upgrade
  ([freeze](https://forum.blackmagicdesign.com/viewtopic.php?p=1154069),
  [glitches](https://forum.blackmagicdesign.com/viewtopic.php?p=1153488),
  [stutter](https://forum.blackmagicdesign.com/viewtopic.php?p=1148622)).
- **GPU memory.** "GPU memory full" on cards with ample VRAM
  ([forum](https://forum.blackmagicdesign.com/viewtopic.php?p=765672)); driver-level
  crashes on Fusion-heavy timelines ([NVIDIA forum](https://forums.developer.nvidia.com/t/davinci-resolve-studio-crashes-caused-by-nvoglv64-dll-fatal-app-exit/330043)).
- **Project database.** "Critical error saving project" then project
  invisible despite live save ([forum](https://forum.blackmagicdesign.com/viewtopic.php?p=435085));
  a well-known trainer lost all projects ([Larry Jordan](https://larryjordan.com/articles/how-i-lost-all-my-davinci-resolve-projects-and-how-you-can-save-yours/embed)).
- **VFR.** Resolve cannot convert VFR to CFR; users transcode outside
  ([guide](https://beginnersapproach.com/davinci-resolve-convert-variable-to-constant-frame-rate/)).
- **Learning curve.** Named as the main con in 2025 reviews
  ([Creative Bloq 19](https://www.creativebloq.com/reviews/davinci-resolve-19),
  [TechRadar 20](https://techradar.com/reviews/davinci-resolve-1746)).
- **Collaboration cost.** Blackmagic Cloud hosting was launched at $5 per
  library per month, host pays ([PetaPixel](https://petapixel.com/2022/04/18/blackmagic-adds-cloud-collaboration-to-davinci-resolve-18)).

### Loved

- Free tier that is a real NLE; Studio is a one-time $295 with free major
  upgrades so far ([Studio page](https://www.blackmagicdesign.com/products/davinciresolve/studio)).
- Colour page; editors switching from Premiere "in droves"
  ([PetaPixel](https://petapixel.com/2023/04/18/why-video-editors-are-switching-to-davinci-resolve-in-droves)).
- Edit, colour, Fusion, Fairlight in one app on three OSes.
- Perceived stability vs Premiere and Live Save recovery
  ([2025 comparison](https://videohighlight.com/v/T6U4QpjqXIc),
  [Adobe Community user](https://community.adobe.com:443/t5/user/viewprofilepage/user-id/8867929)).

### Feature specifics

- **Proxy:** Optimized media (.dvcc), proxy media, Smart render cache;
  in-app generation blocks work, so Blackmagic ships a separate Proxy
  Generator app ([frame.io guide](https://workflow.frame.io/guide/resolve-proxies),
  [elements.tv](https://elements.tv/blog/everything-you-need-to-know-about-the-proxy-workflow-in-davinci-resolve/)).
- **Keymap:** Presets for Premiere, FCP X, Avid, Pro Tools
  ([TourBox](https://www.tourboxtech.com/en/news/davinci-resolve-keyboard-shortcuts-guide.html));
  the Premiere preset was called unfaithful ([forum](https://forum.blackmagicdesign.com/viewtopic.php?p=510627)).
- **Colour:** RCM and ACES with AMF; 21 adds OpenFX 1.5 colour APIs,
  per-job RCM/ACES output override, Dolby Vision / HDR10+ trim passes
  ([Newsshooter 21](https://www.newsshooter.com/2026/06/02/davinci-resolve-21-final-release/),
  [Motion Media 21.1](https://www.motionmedia.com/mm-blog/davinci-resolve-21-1-update-new-features)).
  HDR scopes with nits are Studio ([Studio page](https://www.blackmagicdesign.com/products/davinciresolve/studio)).
- **Audio:** Fairlight LUFS meter ([Tella](https://www.tella.com/definition/loudness-metering));
  Voice Isolation, Dialogue Separator, Music Remixer are Studio
  ([Production Expert](https://www.production-expert.com/production-expert-1/davinci-resolve-voice-isolation-tested)).
- **AI:** 20 added IntelliScript (script-to-timeline), Animated Subtitles,
  Multicam SmartSwitch, Audio Assistant ([PVC](https://www.provideocoalition.com/blackmagic-introduces-davinci-resolve-20/));
  21 adds IntelliSearch, CineFocus, UltraNR, speech generator
  ([Newsshooter](https://www.newsshooter.com/2026/06/02/davinci-resolve-21-final-release/));
  21.1 adds MCP for external AI agents, Studio only
  ([Motion Media](https://www.motionmedia.com/mm-blog/davinci-resolve-21-1-update-new-features)).
  Neural Engine features are local; transcription reported offline after model
  download (vendor blog, [BlitzCut](https://blitzcutai.com/blog/davinci-resolve-text-based-editing)).
- **Interchange:** OTIO import/export since 18.5
  ([manual mirror](https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part1410.htm),
  [OTIO wiki](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/wiki/AWS-Picchu-Edit-OTIO-Conversion-Notes)),
  AAF / EDL / XML import and FCP7 XML export ([Emerson](https://support.emerson.edu/hc/en-us/articles/21709259981723-Importing-an-AAF-XML-into-Resolve)),
  FCPXML for FCP 12 in 21 ([Newsshooter](https://www.newsshooter.com/2026/06/02/davinci-resolve-21-final-release/)).
- **Export:** Deliver page render queue; 21 adds per-job colour overrides
  and MultiMaster trim passes (same source).

---

## 3. Final Cut Pro (Mac, iPad)

### Complaints

- **Platform.** Mac only, limited UI customisation, best features gated to
  Apple silicon ([TechRadar 2025](https://www.techradar.com/pro/apple-final-cut-pro-review)).
  Transcript Search, Visual Search, captions need Apple silicon
  ([Newsshooter 12.0](https://www.newsshooter.com/2026/01/28/final-cut-pro-12-0/),
  [release notes](https://support.apple.com/102825)).
- **Captions.** Generate Captions is US English only ([RedShark 12.3](https://www.redsharknews.com/apple-creator-studio-update-includes-final-cut-pro-12.3-and-more)).
  Transcripts can be searched but not viewed or exported
  ([PVC review](https://www.provideocoalition.com/review-apple-creator-studio/)).
- **Interchange.** No native AAF; Logic/Pro Tools handoff needs Resolve or
  X2Pro ([PVC](https://www.provideocoalition.com/review-apple-creator-studio/),
  [Creative COW](https://creativecow.net/?p=2198177)).
- **Audio.** No BS.1770 / R128 normalisation; loudness analysis is a
  percentage; studios use third-party LUFS meters
  ([Apple Discussions](https://discussions.apple.com/thread/256040406)).
  The MultiMeter loudness meter cites AES 128
  ([Apple guide](https://support.apple.com/guide/final-cut-pro-logic-effects/lgex1d0722a3/mac)).
- **Stability.** Freezes with libraries on external drives, crashes on audio
  effects in 11.0.1 ([thread](https://discussions.apple.com/thread/255933377),
  [thread](https://discussions.apple.com/thread/256004544)).
- **Pricing drift.** $299.99 one-time still sold, but Creator Studio
  ($12.99/mo, $129/yr) holds some premium content, and the split is unclear
  to reviewers ([Apple specs](https://www.apple.com/final-cut-pro/specs/),
  [PVC](https://www.provideocoalition.com/review-apple-creator-studio/)).
- **Collaboration.** Rated weaker than Resolve for simultaneous work
  ([comparison](https://davinciresolveclub.com/davinci-resolve-vs-final-cut-pro/)).

### Loved

- Speed on Apple silicon and the magnetic timeline ([TechRadar](https://www.techradar.com/pro/apple-final-cut-pro-review)).
- One-time price ([Apple specs](https://www.apple.com/final-cut-pro/specs/)).
- On-device ML: Magnetic Mask, Auto Mask, Edit Detection, Match Color
  ([RedShark](https://www.redsharknews.com/apple-creator-studio-update-includes-final-cut-pro-12.3-and-more)).

### Feature specifics

- **Proxy:** Proxy media switched from H.264 to HEVC in 12.3; background
  rendering now off by default ([RedShark](https://www.redsharknews.com/apple-creator-studio-update-includes-final-cut-pro-12.3-and-more)).
- **Scopes:** Waveform, vectorscope; scopes reflect HDR levels
  ([Apple guide](https://support.apple.com/en-kg/guide/final-cut-pro/ver761c9f95/10.5.1/mac)).
- **Colour:** HDR editing, LUTs, wheels and curves; ACES/OCIO not listed
  ([Apple specs](https://www.apple.com/final-cut-pro/specs/)).
- **Audio:** Voice Isolation, Logic effects ([Apple specs](https://www.apple.com/final-cut-pro/specs/)).
- **AI:** Transcribe/Generate Captions, Magnetic Mask, Auto Mask, Edit
  Detection, Beat Detection; 12.3 described as on-device
  ([RedShark](https://www.redsharknews.com/apple-creator-studio-update-includes-final-cut-pro-12.3-and-more)).
- **Interchange:** FCPXML (1.14 in 12.0) ([Newsshooter](https://www.newsshooter.com/2026/01/28/final-cut-pro-12-0/)).
- **Export:** Compressor batch export, hardware encode ([Apple specs](https://www.apple.com/final-cut-pro/specs/)).

---

## 4. Kdenlive (KDE, MLT)

### Complaints

- **Stability.** 25.08 was a stabilisation release fixing 15+ crashes; 26.08
  fixed 11 more ([25.08](https://kdenlive.org/news/releases/25.08.0),
  [26.08](https://linuxiac.com/kdenlive-26-08-adds-track-reordering-better-timeline-editing/)).
- **Proxies.** Proxy clips playing slower than originals
  ([bug 384764](https://bugs.kde.org/show_bug.cgi?id=384764)); freezes
  generating proxies in 26.04.1 ([discuss.kde.org](https://discuss.kde.org/t/crashes-aftter-proxy-videos/47303));
  memory blow-up when rendering 4K without proxies ([forum](https://forum.kde.org/viewtopic.php%3Ff=265&t=167487.html)).
- **Colour depth.** 10-bit sources drop to 8-bit as soon as compositing or
  non-avfilter effects are used ([UbuntuHandbook](https://ubuntuhandbook.org/index.php/2025/08/kdenlive-25-08-0-released-with-nvidia-10-bit-x265-encoding/));
  OCIO has to be built in MLT and the team says colour is not its strength
  ([mailing list](https://mail.kde.org/pipermail/kdenlive/2024-April/011583.html)).
  10/12-bit is on the roadmap ([State 2026](https://kdenlive.org/news/2026/state-2026/)).
- **VFR.** Phone VFR clips trigger an edit-friendly transcode prompt
  ([discuss.kde.org](https://discuss.kde.org/t/frame-rate-transcoding/4178)).
- **Crash recovery.** Recovery historically worked only for unsaved projects
  ([bug 348674](https://bugs.kde.org/show_bug.cgi?id=348674));
  user reports of non-working recovery ([discuss.kde.org](https://discuss.kde.org/t/crash-recovery-not-working/2181)).
- **Bus factor.** Eight active members, two developers; donations fell to
  €9,345 in 2025 ([State 2026](https://kdenlive.org/news/2026/state-2026/)).

### Loved

- Free, no paid tiers, Linux-native ([VideoProc review](https://www.videoproc.com/video-editor/kdenlive-review.htm)).
- Local AI: SAM2 object masks and Whisper/VOSK subtitles, no cloud
  ([Linuxiac](https://linuxiac.com/kdenlive-introduces-new-background-removal-feature/),
  [docs](https://docs.kdenlive.org/en/effects_and_filters/speech_to_text.html)).
- Track-based timeline with proxies, nested sequences, scopes
  ([review](https://atomisystems.com/screencasting/kdenlive-review-2026-honest-expert-verdict-for-serious-creators/), vendor-authored).
- Versioned save backups (20 per hour/day/week/older) ([docs](https://docs.kdenlive.org/cs/project_and_asset_management/file_management/backup.html)).

### Feature specifics

- **Interchange:** OTIO import/export rewritten on the C++ library in 25.04;
  effects and transitions not carried ([AlternativeTo](https://alternativeto.net/news/2025/4/kdenlive-25-04-is-out-with-background-removal-opentimelineio-import-export-and-much-more)).
- **Encode:** 10-bit HEVC on NVENC, SVT-AV1 ([OMG! Ubuntu](https://www.omgubuntu.co.uk/2025/08/kdenlive-2508-rleased-10-bit-encoding-support));
  hardware decoding option added as groundwork only ([Phoronix](https://phoronix.com/news/Kdenlive-25.08-Released)).
- **Audio:** Mixer redesigned in 25.08 ([kdenlive.org](https://kdenlive.org/news/releases/25.08.0)).

---

## 5. Shotcut (Meltytech, MLT)

### Complaints

- **UI lag.** Interface near-unusable on a faster PC
  ([forum](https://forum.shotcut.org/t/faster-better-computer-but-shotcut-interface-more-laggy/18741));
  whole UI lagging during playback ([forum](https://forum.shotcut.org/t/entire-shotcut-ui-lags-like-crazy-while-playing-any-video-often-to-the-point-of-not-responding/50776));
  dated UI and preview lag in reviews ([G2](https://www.g2.com/products/Shotcut/reviews)).
- **Recovery.** Autosave runs about once a minute; recovery prompt sometimes
  fails or restores older work ([forum](https://forum.shotcut.org/t/autosave-restored-version-behind-current-project/34118),
  [forum](https://forum.shotcut.org/t/autosave-file-didnt-automatically-open-after-crash/32134)).
- **VFR.** Needs "Convert to Edit-friendly" before editing
  ([blog 17.12](https://shotcut.org/blog/new-release-1712/),
  [forum](https://forum.shotcut.org/t/variable-frame-rate-not-reliable-for-editing-what-can-happen/15932)).
- **Pro features arriving late and experimental:** HDR preview, OpenFX and
  VST2/LV2 in 26.6, not yet on every OS ([AlternativeTo](https://alternativeto.net/news/2026/6/shotcut-26-6-brings-hdr-enhancements-initial-plugin-support-and-vulkan-display-on-linux/)).

### Loved

- Free, cross-platform, wide format support ([G2](https://www.g2.com/products/Shotcut/reviews)).
- Steady cadence: 26.2, 26.4, 26.6, 26.7, 26.9 in one year
  ([Phoronix 26.9](https://www.phoronix.com/news/Shotcut-26.9)).
- Local Whisper subtitles via whisper.cpp, Vulkan-accelerated in 26.4
  ([Linuxadictos](https://en.linuxadictos.com/Shotcut-26.4-arrives-with-improvements-to-the-timeline-and-Vulkan.html)).

### Feature specifics

- **Proxy:** Since 20.06; proxy height follows Preview Scaling, 540p default
  ([forum doc](https://forum.shotcut.org/t/proxy-editing/18517)).
- **Audio:** EBU R128 normalise one/two pass ([blog](https://shotcut.org/blog/improved-stabilize-and-normalize-ebu/)),
  Audio Loudness scope since 16.04 ([blog](https://shotcutapp.com/blog/new-release-1604/)),
  RNNoise (26.6), auto ducking and 32-bit float pipeline (26.9)
  ([Phoronix](https://www.phoronix.com/news/Shotcut-26.9)).
- **Speech to text:** model downloader in 25.07 ([Phoronix](https://www.phoronix.com/news/Shotcut-25.07-Released)).
- **Export:** Jobs panel queue (speech-to-text runs as jobs)
  ([forum doc](https://forum.shotcut.org/t/settings-proxy-editing/18517)).

---

## 6. Olive

- **Status.** Last commit 2024-12-05; only a "0.2.0-nightly, Unstable
  Development Build"; README: "alpha software and is considered highly
  unstable" ([GitHub](https://github.com/olive-editor/olive)). Site says
  "Olive will return" ([olivevideoeditor.org](https://olivevideoeditor.org/)).
  A March 2025 developer update, reported second-hand, described a rebuild on
  Godot with a C# node editor ([post](https://scribe.disroot.org/post/2429686)).
- **Why it mattered (loved):** OpenColorIO colour management, half/full-float
  render, node editor, background disk cache, configurable shortcuts
  ([Debugpoint](https://www.debugpoint.com/olive-0-2-video-editor-review/)).
  The rewrite started because the 0.1 pipeline was 8-bit
  ([kdenlive list](https://mail.kde.org/pipermail/kdenlive/2020-July/010896.html)).
- **Lesson:** OCIO + node graph + cache is the design users wanted; a single
  maintainer and repeated rewrites is the failure mode.

---

## 7. CapCut (desktop)

### Complaints

- **Paywall drift.** 2025 restructure added a Standard tier and raised Pro;
  captions and effects moved behind the paywall ([eesel](https://www.eesel.ai/blog/capcut-pricing),
  [Veed](https://www.veed.io/learn/capcut-review)). Users report basic tools
  locked mid-use and Pro not honoured on desktop
  ([Şikayetvar](https://www.sikayetvar.com/en/capcut-us/capcut-locked-everything-behind-pronow-we-cant-use-basic-features),
  [Şikayetvar](https://www.sikayetvar.com/en/capcut-us/capcut-pro-subscription-not-working-on-desktop-cant-access-pro-features)).
- **Terms.** June 2025 terms grant a perpetual, irrevocable licence over user
  content; disputed scope ([TechRadar](https://www.techradar.com/pro/popular-video-editing-app-capcut-wants-to-use-any-content-you-produce-for-free-forever-heres-what-you-should-know),
  [Larry Jordan](https://larryjordan.com/articles/caution-capcut-changed-their-license-and-may-own-your-content/)).
- **Availability.** Went dark in the US on 18-19 Jan 2025 and was pulled from
  app stores ([Tribune](https://tribune.com.pk/story/2523081/capcut-suspends-us-services-amid-tiktok-ban-bytedance-apps-face-nationwide-shutdown),
  [Hooked](https://www.hooked.so/guides/is-capcut-getting-banned)).
- **Cloud AI.** Several AI features need an internet connection; no scopes or
  colour wheels; long multi-track projects feel constrained
  ([review](https://atomisystems.com/screencasting/capcut-pc-review-2026-is-free-video-editing-really-worth-your-time/), vendor-authored).
- **Lock-in.** No project import/export with other editors
  ([CapCut help](https://www.capcut.com/help/how-to-export-pro-project)).

### Loved

- Fast, template-driven short-form workflow, platform presets, styled auto
  captions, background removal ([review](https://atomisystems.com/screencasting/capcut-pc-review-2026-is-free-video-editing-really-worth-your-time/)).
- Cross-device sync across Windows, macOS, mobile, web (same source).

### Feature specifics

- **AI:** auto captions, background removal, partly cloud (same source).
- **Interchange:** none (CapCut help, above).
- **Platforms:** Windows, macOS, iOS, Android, web; no Linux build found.

---

## 8. Descript

### Complaints

- **Metered pricing.** Sept 2025 switch to "media minutes" plus AI credits;
  per-action credit cost not shown ([Sonix](https://sonix.ai/resources/descript-pricing/amp/), competitor;
  [Hackceleration](https://hackceleration.com/labs/review/descript)).
  Current plans: Free 720p and 1 hr; Hobbyist 1080p; 4K from Creator
  ([pricing](https://www.descript.com/pricing)).
- **Cloud dependence.** "Descript does not support offline editing"
  ([help](https://help.descript.com/hc/en-us/articles/13520561812237-Save-your-work-to-the-cloud));
  users ask for a true offline mode and not uploading originals
  ([feedback](https://feedback.descript.com/feature-requests/p/true-offline-mode),
  [feedback](https://feedback.descript.com/feature-requests/p/offline-editing)).
  Green Screen needs a network connection and spends AI credits
  ([help](https://help.descript.com/hc/en-us/articles/10327693275405-Green-screen)).
- **Stability.** Laggy, buggy, lost work in 2025 reviews
  ([Trustpilot](https://ca.trustpilot.com/review/descript.com)).
- **Interchange gated.** Timeline export only on Creator+; no Sequences or
  Avatars ([help](https://help.descript.com/hc/en-us/articles/10255813481613-Timeline-exports)).

### Loved

- Edit video by editing the transcript; Studio Sound; Overdub for small fixes
  ([eesel review](https://www.eesel.ai/blog/descript-reviews)).
- Underlord automation: filler-word removal, promo-clip extraction, bulk edits
  ([review](https://www.ki-syndikat.de/tools/descript/)).

### Feature specifics

- **Interchange:** Premiere XML, FCPXML, EDL (Reaper), SESX, AAF
  ([help](https://help.descript.com/hc/en-us/articles/10255813481613-Timeline-exports)).
- **Not a finishing tool:** reviewed as a poor fit for editors needing
  grading, VFX and deep multitrack audio ([review](https://www.ki-syndikat.de/tools/descript/)).

---

## 9. New open-source and AI-built editors (2025-2026)

Stars and dates read from the GitHub API on 2026-10-16.

| Project | What | Stack | Activity | Stars |
|---|---|---|---|---|
| [OpenCut](https://github.com/OpenCut-app/OpenCut) | "Open-source CapCut alternative"; main branch is a ground-up rewrite (Rust core, plugins, MCP, headless); classic editor [archived](https://github.com/opencut-app/opencut-classic) May 2026 | TS/Next.js (classic), Rust core planned | push 2026-09-24 | 94.9k |
| [FilmCraft](https://github.com/storytold/filmcraft) | "Clean-room" Premiere reimplementation; self-rated ~86% breadth, ~56% ready for real work; mostly AI-written per [Phoronix](https://www.phoronix.com/news/Photocraft-Filmcraft-AI), [PetaPixel](https://petapixel.com/2026/10/07/someone-rebuilt-free-open-source-versions-of-photoshop-premiere-and-lightroom-using-ai/) | Rust, WASM build | v0.8.0 2026-10-14; 1,100+ open issues | 14.2k |
| [Palmier Pro](https://github.com/palmier-io/palmier-pro) | "Video editor built for AI", MCP-driven; GPLv3 to v0.7.6, later binaries proprietary | Swift, macOS 26 Apple silicon | v0.11.0 2026-10-05 | 14.6k |
| [OpenReel Video](https://github.com/Augani/openreel-video) | Browser + desktop CapCut alternative | TypeScript | v1.0.0-alpha.17 2026-08-29 | 5.4k |
| [Clypra](https://github.com/AIEraDev/Clypra) | HW-accelerated editor; ships timing telemetry | Rust, Tauri v2, React 19 | v1.6.0 2026-10-11 | 3.3k |
| [OpenChatCut](https://github.com/0xsline/OpenChatCut) | Local-first conversational editor for Codex / Claude Code agents | TS, Remotion, AGPL | v0.2.17 2026-10-15 | 2.4k |
| [OpenVideo editor](https://github.com/openvideodev/react-video-editor) | Client-side editor + SaaS starter | WebCodecs, PixiJS | push 2026-06-30 | 1.8k |
| [Omniclip](https://github.com/omni-media/omniclip) | Browser-only, no accounts, no uploads; 2.0 in development | WebCodecs, TS | push 2026-10-16 | 1.5k |
| [Gausian](https://github.com/gausian-AI/Gausian_native_editor) | Native editor for AI video production | Rust, wgpu | push 2026-07-01 | 1.0k |
| [Tooscut](https://github.com/mohebifar/tooscut) | Browser NLE | Rust/WASM, WebGPU | push 2026-10-12 | 0.7k |
| [OpenShot](https://github.com/OpenShot/openshot-qt) | Long-running FOSS editor | Python/Qt, C++ libopenshot | v4.0.1 2026-09-27 | 6.6k |
| [Flowblade](https://github.com/jliljebl/flowblade) | Linux-only MLT editor | Python, MLT | v2.24.2 2026-05-29 | 3.1k |

### Recurring issues in new editors

- **RAM hogging on import (browser).** OpenCut
  [#628 out of memory](https://github.com/OpenCut-app/OpenCut/issues/628),
  [#656 import devours RAM until desktop crash](https://github.com/OpenCut-app/OpenCut/issues/656);
  OpenReel [#21](https://github.com/Augani/openreel-video/issues/21).
- **Laggy playback.** OpenCut [#580](https://github.com/OpenCut-app/OpenCut/issues/580),
  [#877](https://github.com/OpenCut-app/OpenCut/issues/877); FilmCraft
  [#1645 Linux stutter despite VA-API](https://github.com/storytold/filmcraft/issues/1645),
  [#525 lag after 0.5](https://github.com/storytold/filmcraft/issues/525);
  Tooscut [#18 Linux Chromium lag](https://github.com/mohebifar/tooscut/issues/18);
  Clypra [#174 WebGL context loss blanks preview](https://github.com/AIEraDev/Clypra/issues/174).
- **Decode speed and codec coverage.** FilmCraft
  [#1039 HEVC software decode 2.7-4x slower than ffmpeg](https://github.com/storytold/filmcraft/issues/1039),
  [#1998 iPhone HLG HEVC import fails](https://github.com/storytold/filmcraft/issues/1998),
  [#30 GPU decode/effects/export](https://github.com/storytold/filmcraft/issues/30).
- **A/V sync and timestamps.** FilmCraft
  [#2183 export audio 0.2 s late on phone HEVC](https://github.com/storytold/filmcraft/issues/2183),
  [#1137 MP3 encoder delay not trimmed](https://github.com/storytold/filmcraft/issues/1137),
  [#1276 edit-list start offset one frame early](https://github.com/storytold/filmcraft/issues/1276);
  OpenChatCut [#1 VFR crashes export](https://github.com/0xsline/OpenChatCut/issues/1);
  OpenShot [#5644 audio out of sync](https://github.com/OpenShot/openshot-qt/issues/5644),
  [#1069 popping in exported audio](https://github.com/OpenShot/openshot-qt/issues/1069).
- **Export bugs.** OpenCut [#586 export failed](https://github.com/OpenCut-app/OpenCut/issues/586);
  OpenReel [#102 long vertical export silently clamped to 608x1080](https://github.com/Augani/openreel-video/issues/102);
  Palmier [#68 export hangs on deep seeks, 60 fps source in 30 fps timeline](https://github.com/palmier-io/palmier-pro/issues/68).
- **Recovery.** OpenReel [#101 recovery crashes when a media blob is missing](https://github.com/Augani/openreel-video/issues/101).
- **Agent-driven editing.** Palmier [#58 freeze at 100% CPU during agent edits](https://github.com/palmier-io/palmier-pro/issues/58),
  [#320 undo-manager crash during MCP edits](https://github.com/palmier-io/palmier-pro/issues/320);
  OpenChatCut [#195 MCP session destroyed on state change](https://github.com/0xsline/OpenChatCut/issues/195),
  [#120 local Whisper errors at any model size](https://github.com/0xsline/OpenChatCut/issues/120).
- **Browser reach.** Omniclip [#11 WebKit support](https://github.com/omni-media/omniclip/issues/11)
  (WebCodecs dependence noted in its README).
- **Interchange asked for early.** Palmier [#110 XML export to Resolve](https://github.com/palmier-io/palmier-pro/issues/110);
  OpenChatCut [#27 FCPXML referencing original media](https://github.com/0xsline/OpenChatCut/issues/27).
- **Licence and continuity.** Palmier moved from GPL to proprietary binaries;
  OpenCut paused its shipped editor for a rewrite; Olive went quiet after a
  rewrite. Users of these projects carry rewrite risk.

---

## 10. Comparison table

Legend: Y = sourced yes; S = Studio only; P = paid tier; N = sourced no;
? = no source found. Sources are in the sections above.

| Capability | Premiere | Resolve free | Resolve Studio | FCP | Kdenlive | Shotcut | Olive | CapCut | Descript |
|---|---|---|---|---|---|---|---|---|---|
| Real-time multi-track 4K | Y, regressions reported | capped UHD60, no HW HEVC | Y, multi-GPU | Y on Apple silicon | stutter reports | UI lag reports | ? | lag on long projects | ? |
| Background proxies | Y (Media Encoder) | separate app | separate app | Y (HEVC) | Y, bugs | Y | disk cache | ? | ? |
| Video scopes | Y | Y | Y + HDR nits | Y | Y | ? | ? | N | ? |
| OCIO / ACES | ACEScct pipeline | Y (ACES) | Y (ACES) | N listed | N (planned via MLT) | ? | OCIO | N | ? |
| LUFS metering | ? | Y | Y | MultiMeter (AES 128), no R128 normalise | ? | Y (R128) | ? | ? | ? |
| Local transcription | Y | N | Y | Y (US English captions) | Y (Whisper/VOSK) | Y (whisper.cpp) | ? | cloud reported | N (cloud) |
| Text-based editing | Y | ? | IntelliScript | N (search only) | ? | ? | ? | ? | Y |
| Scene / edit detection | Y | N | S | Y (12.3) | ? | ? | ? | ? | ? |
| Background removal | Object Mask, local | N | S | Magnetic / Auto Mask | SAM2, local | ? | ? | Y, partly cloud | P, cloud |
| OTIO | Y (25.6+) | Y | Y | N | Y (no effects) | ? | ? | N | N |
| FCPXML | ? | Y | Y | Y | ? | ? | ? | N | Y (P) |
| EDL | ? | Y | Y | ? | ? | ? | ? | N | Y (P) |
| Premiere / FCP7 XML | Y | Y | Y | ? | ? | ? | ? | N | Y (P) |
| AAF | ? | Y (import) | Y (import) | N (X2Pro) | ? | ? | ? | N | Y (P) |
| Autosave / recovery | Y, corrupt autosaves reported | Live Save, DB corruption reported | same | ? | backups; recovery bugs | Y (1 min) | ? | ? | cloud only |
| Price | sub, ~$22.99/mo | $0 | $295 once | $299.99 or $12.99/mo | $0 | $0 | $0 | free + Pro sub | $0-65/mo |
| Linux | N | Y (no AAC) | Y (no AAC) | N | Y | Y | Y | N | ? |

---

## 11. Their problems, our answers

Each row is a recurring complaint and the measurable bar this editor must
clear. "Proof" names the test that holds the bar, or says plainly what is still open (as of 2026-10-16).

| # | Complaint | Evidence | Test / benchmark we must pass | Proof |
|---|---|---|---|---|
| 1 | Crash loses work; autosave saves corruption | [Premiere](https://community.adobe.com/t5/premiere-pro-bugs/premiere-pro-2025-project-file-corrupted-amp-autosaves-also-won-t-open/idc-p/15457446), [Premiere beta](https://community.adobe.com/t5/premiere-pro-beta-bugs/ongoing-issue-damaged-project-files-in-premiere-pro-beta/idi-p/15531960), [Resolve DB](https://forum.blackmagicdesign.com/viewtopic.php?p=435085), [Kdenlive](https://bugs.kde.org/show_bug.cgi?id=348674), [Shotcut](https://forum.shotcut.org/t/autosave-restored-version-behind-current-project/34118), [Descript](https://ca.trustpilot.com/review/descript.com) | 1,000 `kill -9` at random points during scripted edits: project always reopens, ≤2 s of edits lost, journal checksum valid; a corrupt snapshot never replaces the last good one | **Partly met.** 25 random `kill -9` during scripted edits never leave an unreadable autosave (`session_test` "kill -9…"); a truncated or altered project file is refused, not misread (`io_test`). Autosave runs 2 s after the last change. The 1,000-kill run is not done yet |
| 2 | Long-GOP HEVC / phone footage crashes or stutters | [Premiere H.265](https://community.adobe.com/t5/premiere-pro-bugs/p-crashing-constantly-with-h-265-h-264-and-iphone-footage-happens-in-v25-1-to-v25-6/idc-p/15546630), [Resolve 20](https://forum.blackmagicdesign.com/viewtopic.php?p=1154069), [FilmCraft #1645](https://github.com/storytold/filmcraft/issues/1645) | 3x 4K60 HEVC 10-bit tracks + 1 grade play at 60 fps with 0 dropped frames for 60 s on the reference GPU box | Pending: `rpro bench playback` is written and waits for a free GPU (see BENCHMARKS.md) |
| 3 | Playback degrades over a session | [Premiere](https://community.adobe.com/t5/premiere-pro-discussions/premiere-pro-playback-lag-even-with-good-specs-looking-for-reliable-fixes/td-p/15599572), [Kdenlive](https://forum.kde.org/viewtopic.php%3Ff=265&t=171404.html) | 4 h scripted soak: p99 frame time drifts ≤5%, RSS growth ≤5% after warm-up | Pending: no soak test yet |
| 4 | Proxies slow, buggy or block the UI | [Premiere 25.2.3](https://community.adobe.com/t5/premiere-pro-bugs/timeline-lagging-even-with-proxies/idc-p/15362903), [Kdenlive 384764](https://bugs.kde.org/show_bug.cgi?id=384764), [Kdenlive 26.04](https://discuss.kde.org/t/crashes-aftter-proxy-videos/47303), [Resolve](https://elements.tv/blog/everything-you-need-to-know-about-the-proxy-workflow-in-davinci-resolve/) | Proxying 100 clips in background while editing keeps UI p99 frame ≤16 ms; proxy/original toggle is frame-identical in timing; a failed proxy never blocks editing | **Partly met.** Proxies are all-intra H.264 made by background ffmpeg children (the UI thread never waits on them); proxy and original share one timebase. UI p99 under load is not measured yet |
| 5 | VFR phone clips drift or need transcoding | [Resolve](https://beginnersapproach.com/davinci-resolve-convert-variable-to-constant-frame-rate/), [Kdenlive](https://discuss.kde.org/t/frame-rate-transcoding/4178), [Shotcut](https://shotcut.org/blog/new-release-1712/), [Premiere](https://community.adobe.com/t5/premiere-pro-discussions/alternatives-to-handbrake-handbrake-not-converting-variable-to-constant-like-it-used-to/m-p/8945393/highlight/true), [OpenChatCut #1](https://github.com/0xsline/OpenChatCut/issues/1) | VFR phone clip imported with no transcode: every frame's PTS preserved on passthrough export; A/V drift <1 ms over 60 min | **Partly met.** VFR clips decode by timestamp with no transcode (`decode_test` "variable frame rate…"). Exports are constant-rate at the sequence rate; passthrough-PTS export and the 60-minute drift run are not done |
| 6 | Constant A/V offsets (encoder delay, edit lists) | [FilmCraft #2183](https://github.com/storytold/filmcraft/issues/2183), [#1137](https://github.com/storytold/filmcraft/issues/1137), [#1276](https://github.com/storytold/filmcraft/issues/1276), [OpenShot #5644](https://github.com/OpenShot/openshot-qt/issues/5644) | Corpus of MP3/AAC/Opus priming and MP4 edit-list files: first audio sample and first frame match an ffmpeg reference to ±1 sample / 0 frames | **Partly met.** Audio reads are sample-exact anywhere in a file (`decode_test`); exports keep sound length within one AAC frame (`export_test`). The priming/edit-list corpus is not built |
| 7 | RAM hogging on import or render | [OpenCut #656](https://github.com/OpenCut-app/OpenCut/issues/656), [#628](https://github.com/OpenCut-app/OpenCut/issues/628), [OpenReel #21](https://github.com/Augani/openreel-video/issues/21), [Kdenlive](https://forum.kde.org/viewtopic.php%3Ff=265&t=167487.html) | Importing a 2 h 4K clip and a 500-clip project: peak RSS bounded by a fixed budget (e.g. ≤2 GB) and independent of file length | Pending: no RSS budget test yet |
| 8 | GPU memory / driver crashes | [Resolve](https://forum.blackmagicdesign.com/viewtopic.php?p=765672), [NVIDIA](https://forums.developer.nvidia.com/t/davinci-resolve-studio-crashes-caused-by-nvoglv64-dll-fatal-app-exit/330043), [Clypra #174](https://github.com/AIEraDev/Clypra/issues/174) | VRAM cap forced to 2 GB: heavy timeline degrades (lower cache) but never errors; injected device-lost recovers playback in ≤1 s | Not done |
| 9 | Codec gaps on Linux | [Resolve AAC](https://forum.blackmagicdesign.com/viewtopic.php?p=1024570), [NixOS](https://wiki.nixos.org/wiki/DaVinci%20Resolve) | CI decode matrix on Linux: H.264, HEVC 8/10-bit, AV1, ProRes, AAC, Opus all import, play and export | **Met for decode/encode here.** Frame-exact decode of H.264, HEVC 10-bit, AV1, ProRes, DNxHR on NVDEC and software, AAC/Opus/PCM sound (`decode_test`); every export preset checked frame by frame (`export_test`) |
| 10 | Free tier capped (resolution, fps, 10-bit) | [Resolve Studio page](https://www.blackmagicdesign.com/products/davinciresolve/studio), [Descript pricing](https://www.descript.com/pricing), [CapCut](https://www.eesel.ai/blog/capcut-pricing) | Same build exports 8K, 120 fps, 10-bit HDR; no feature flag keyed to a licence | **Met by design.** One build, no licence checks; 4K, HEVC 10-bit and HDR10 presets ship. 8K/120 fps export is not tested |
| 11 | AI needs the cloud, credits or an account | [Generative Extend](https://www.newscaststudio.com/2025/04/03/adobe-brings-generative-extend-media-intelligence-to-premiere-pro), [Descript offline](https://help.descript.com/hc/en-us/articles/13520561812237-Save-your-work-to-the-cloud), [Descript Green Screen](https://help.descript.com/hc/en-us/articles/10327693275405-Green-screen), [CapCut](https://atomisystems.com/screencasting/capcut-pc-review-2026-is-free-video-editing-really-worth-your-time/) | Full test suite, including transcription, masking and denoise, passes inside a network namespace with no route (`unshare -n`); zero outbound connections logged | **Met.** Transcription, noise reduction, voice isolation, background removal, silence, scene and reframe tests pass inside `unshare -rn` (ctest `ai_offline`) |
| 12 | Transcription limited by language or hardware | [FCP US English](https://www.redsharknews.com/apple-creator-studio-update-includes-final-cut-pro-12.3-and-more), [Resolve Studio-only](https://firecut.ai/blog/how-to-use-auto-captions-in-davinci-resolve-a-complete-guide/), [OpenChatCut #120](https://github.com/0xsline/OpenChatCut/issues/120) | Local transcription on a CPU-only box in ≥10 languages incl. Arabic; WER on a fixed reference set recorded per release; 1 h audio in ≤real time on the reference GPU | **Partly met.** Local whisper.cpp at ~12× real time on 8 CPU threads (this machine, base model); words land on the sound (`transcribe_test`). Language coverage and WER are not measured yet |
| 13 | No standards loudness | [FCP thread](https://discussions.apple.com/thread/256040406), [Apple MultiMeter](https://support.apple.com/guide/final-cut-pro-logic-effects/lgex1d0722a3/mac) | Meter passes EBU Tech 3341/3342 conformance files within ±0.1 LU; normalise-to-target lands within ±0.5 LU integrated | **Partly met.** Integrated loudness within 0.1 LU of FFmpeg's `ebur128` on gated programmes and −23.0 LUFS on the EBU tone (`audio_test`); normalising lands within 0.5 LU. The full Tech 3341/3342 file set is not run |
| 14 | Interchange missing, gated or lossy | [FCP no AAF](https://creativecow.net/?p=2198177), [CapCut none](https://www.capcut.com/help/how-to-export-pro-project), [Descript Creator+](https://help.descript.com/hc/en-us/articles/10255813481613-Timeline-exports), [Kdenlive OTIO](https://alternativeto.net/news/2025/4/kdenlive-25-04-is-out-with-background-removal-opentimelineio-import-export-and-much-more), [Palmier #110](https://github.com/palmier-io/palmier-pro/issues/110) | 50-clip reference timeline round-trips OTIO, FCPXML, FCP7 XML, EDL, AAF through Resolve and Premiere: every cut frame-exact, track/role and markers preserved | **Partly met.** Frame-exact round trips through OTIO, FCPXML, FCP7 XML and EDL (`interchange_test`), and both directions agree with OpenTimelineIO's reference adapters (ctest `otio_reference`). No AAF; Resolve and Premiere are not installed here to test against |
| 15 | Colour drops to 8-bit; no OCIO | [Kdenlive 8-bit](https://ubuntuhandbook.org/index.php/2025/08/kdenlive-25-08-0-released-with-nvidia-10-bit-x265-encoding/), [Kdenlive OCIO](https://mail.kde.org/pipermail/kdenlive/2024-April/011583.html) | 10-bit source through composite + grade + title exports 10-bit, max error ≤1 code value vs float reference; ACES OCIO config transforms match `ociocheck` reference | **Partly met.** 10-bit P010 and ProRes return their own code values through decode → composite → encode, and PQ/HLG within one 10-bit code (`render_test`). No OCIO yet |
| 16 | Silent or hanging exports | [OpenReel #102](https://github.com/Augani/openreel-video/issues/102), [Palmier #68](https://github.com/palmier-io/palmier-pro/issues/68), [OpenCut #586](https://github.com/OpenCut-app/OpenCut/issues/586) | Export asserts output dims/fps/duration equal the request or fails loudly; mixed-fps deep-seek export finishes; render queue resumes after `kill -9` | **Partly met.** Exports are checked for size, rate, frame count and content (`export_test`); a failed export is a failed child process, never a hung editor. Resuming the queue after `kill -9` is not done |
| 17 | Scripted / agent edits freeze or break undo | [Palmier #58](https://github.com/palmier-io/palmier-pro/issues/58), [#320](https://github.com/palmier-io/palmier-pro/issues/320), [OpenChatCut #195](https://github.com/0xsline/OpenChatCut/issues/195) | 10,000 random API edit ops then full undo returns a byte-identical project; UI p99 ≤16 ms throughout | **Met for the model.** 100,000 random edits keep every invariant and a refused edit changes nothing; undo restores exact snapshots (`edit_test`). UI p99 is not measured |
| 18 | Pricing churn, ToS, availability | [Adobe](https://www.theregister.com/2025/05/20/adobe_price_hikes/), [CapCut ToS](https://www.techradar.com/pro/popular-video-editing-app-capcut-wants-to-use-any-content-you-produce-for-free-forever-heres-what-you-should-know), [CapCut US outage](https://tribune.com.pk/story/2523081/capcut-suspends-us-services-amid-tiktok-ban-bytedance-apps-face-nationwide-shutdown), [Descript](https://hackceleration.com/labs/review/descript) | App launches, edits and exports with no account and no network; no licence server in the code path | **Met by design.** No account, no licence server; the network is touched only when you open or publish a web render |
| 19 | Project dies with the app (abandonment, rewrites) | [Olive](https://github.com/olive-editor/olive), [OpenCut classic archived](https://github.com/opencut-app/opencut-classic), [Kdenlive bus factor](https://kdenlive.org/news/2026/state-2026/) | Project file has a published schema; a fixture project converts to OTIO with stock `otioconvert` and plays in Resolve without our app | **Partly met.** The project file is documented JSON and converts to OTIO that OpenTimelineIO reads with identical cuts (ctest `otio_reference`); playback in Resolve is not tested here |

---

## 12. Gaps to exploit

- Local-first AI with no account: Descript cannot edit offline and Premiere's
  Generative Extend spends cloud credits, so a fully offline AI stack is a
  clear differentiator ([Descript](https://help.descript.com/hc/en-us/articles/13520561812237-Save-your-work-to-the-cloud), [Adobe](https://www.newscaststudio.com/2025/04/03/adobe-brings-generative-extend-media-intelligence-to-premiere-pro)).
- Crash-proof projects: journaled saves that never overwrite a good snapshot
  answer the Premiere "autosaves also corrupt" and Resolve database-loss
  threads ([Premiere](https://community.adobe.com/t5/premiere-pro-bugs/premiere-pro-2025-project-file-corrupted-amp-autosaves-also-won-t-open/idc-p/15457446), [Resolve](https://forum.blackmagicdesign.com/viewtopic.php?p=435085)).
- Native VFR handling: every major editor tells phone users to transcode
  first, so frame-exact VFR import is a day-one win ([Resolve](https://beginnersapproach.com/davinci-resolve-convert-variable-to-constant-frame-rate/), [Kdenlive](https://discuss.kde.org/t/frame-rate-transcoding/4178), [Shotcut](https://shotcut.org/blog/new-release-1712/)).
- Proxies that never block or slow editing, unlike Resolve's separate
  generator app and Premiere/Kdenlive proxy regressions ([Resolve](https://elements.tv/blog/everything-you-need-to-know-about-the-proxy-workflow-in-davinci-resolve/), [Premiere](https://community.adobe.com/t5/premiere-pro-bugs/timeline-lagging-even-with-proxies/idc-p/15362903)).
- First-class Linux with full codecs, including AAC, where Resolve has none
  and Premiere/FCP do not ship ([Blackmagic staff](https://forum.blackmagicdesign.com/viewtopic.php?p=1024570)).
- No free-tier ceilings: Resolve free stops at UHD60 without hardware HEVC,
  CapCut and Descript gate resolution behind plans ([Studio](https://www.blackmagicdesign.com/products/davinciresolve/studio), [Descript](https://www.descript.com/pricing)).
- Interchange as a feature, not an upsell: OTIO + FCPXML + AAF everywhere,
  where FCP lacks AAF, CapCut has none and Descript gates export ([PVC](https://www.provideocoalition.com/review-apple-creator-studio/), [CapCut](https://www.capcut.com/help/how-to-export-pro-project), [Descript](https://help.descript.com/hc/en-us/articles/10255813481613-Timeline-exports)).
- Float/10-bit pipeline with OCIO on every platform, which Kdenlive lacks and
  Olive proved users want ([Kdenlive](https://ubuntuhandbook.org/index.php/2025/08/kdenlive-25-08-0-released-with-nvidia-10-bit-x265-encoding/), [Olive](https://www.debugpoint.com/olive-0-2-video-editor-review/)).
- Broadcast-grade loudness (R128/BS.1770 meter and normalise) built in, which
  FCP users currently buy as plug-ins ([Apple Discussions](https://discussions.apple.com/thread/256040406)).
- Multilingual local transcription, including Arabic, versus FCP's US-English
  captions and Resolve's Studio-only transcription ([RedShark](https://www.redsharknews.com/apple-creator-studio-update-includes-final-cut-pro-12.3-and-more), [FireCut](https://firecut.ai/blog/how-to-use-auto-captions-in-davinci-resolve-a-complete-guide/)).
- Text-based editing with a pro timeline in one free app, since Descript is
  not a finishing tool and FCP only searches transcripts ([review](https://www.ki-syndikat.de/tools/descript/), [PVC](https://www.provideocoalition.com/review-apple-creator-studio/)).
- A stable scripting/agent API with transactional undo, where early
  agent-first editors freeze or crash under scripted edits and Resolve keeps
  MCP in Studio ([Palmier #58](https://github.com/palmier-io/palmier-pro/issues/58), [Motion Media](https://www.motionmedia.com/mm-blog/davinci-resolve-21-1-update-new-features)).
