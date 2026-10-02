# Audacity capability matrix

This inventory compares the actual registered tools in the nine local source
checkouts below, including generated static actions. It treats a capability as
covered when a dedicated tool or a strictly validated catalogue command can
perform it in Audacity 3.7.8. Extra aliases for the same command do not count as
extra capabilities. A project-backed equivalent means importing a file, editing
it in Audacity, and exporting the result; it is not a second standalone DSP
engine.

The verification target is English Audacity 3.7.8. Claims made by
another server are research evidence, not live verification of this server.
In particular, upstream headline tool counts include modal actions, optional
Python/ML tools, and Audacity 4 fork APIs. The live test suite and comments beside
catalogue boundaries record verification for this implementation.

## Source snapshots

| Key | Repository | Licence | Commit inspected | Unique registered tool IDs |
| --- | --- | --- | --- | ---: |
| X3 | [xDarkzx/Audacity-MCP](https://github.com/xDarkzx/Audacity-MCP) | Apache-2.0 | `ef7612eb6766ee96d630783d64c1ce94d602dc9e` | 144 |
| X4 | [xDarkzx/Audacity4-MCP](https://github.com/xDarkzx/Audacity4-MCP) | Apache-2.0 | `280c7a3f46c19c8686c53a37f788264630aa4b8c` | 159 |
| MAX | [robworks-code/audacity-mcp-max](https://github.com/robworks-code/audacity-mcp-max) | Apache-2.0 | `a1fd6af1d068f7f81f976265e452722742304d50` | 134 |
| FF | [FFriends/MCP-Audacity](https://github.com/FFriends/MCP-Audacity) | Apache-2.0 | `3f53cdaa37a2339d4c5af6311f7e9f9311a486a8` | 253 |
| DPF | [Dream-Pixels-Forge/audacity-mcp](https://github.com/Dream-Pixels-Forge/audacity-mcp) | MIT | `9d812922e46f504f91cca48338ed68511f8d4243` | 38 |
| AN3 | [An-3/an3-audacity-mcp](https://github.com/An-3/an3-audacity-mcp) | MIT | `5f9705936cb07551214c8cd9aa07f5cb1f7d9531` | 166 |
| PIMP | [PiMPStudios/mcp-audacity](https://github.com/PiMPStudios/mcp-audacity) | MIT | `64a4de11274c594235170abd6f6e47960895a59d` | 179 |
| BUCK | [buckydurddle/audacity-mcp](https://github.com/buckydurddle/audacity-mcp) | MIT | `bf2b08196406629cddae0c9c5799a4e9f396442e` | 10 |
| TACH | [tachyonshuggy/audacity-mcp](https://github.com/tachyonshuggy/audacity-mcp) | MIT | `cd2f38783a76a9ef10aa0be2bf3518d3c04e0888` | 21 |

Counts deduplicate overridden/generated names and exclude mocked tool
decorators in tests. FF contains 146 named tools and 107 generated raw actions.
AN3 and PIMP contain many no-argument menu wrappers; PIMP also replaces several
with parameterized implementations. Tool counts are not a measure of safe live
coverage.

## Decisions and important differences

| Capability | Sources | Decision and implementation |
| --- | --- | --- |
| Hidden-window work | All 3.x pipe servers | First-class `audacity_launch`, `audacity_fresh`, and `audacity_window`; the application still runs and processes audio. |
| Typed command and effect discovery | AN3, PIMP, X3, FF, MAX, X4, BUCK | `audacity_info`, `audacity_describe`, `audacity_command`, and `audacity_effect` use the local live catalogue and strict schemas. Space-bearing parameter keys are quoted; hyphenated keys are retained. |
| Safe pipe sequencing | All | Serialized commands and operations; fresh pipe handles, opening retry, response terminator parsing, and bounded waits. |
| Recovery and project preservation | FF, MAX; integration requirement | Dialog inspection/WM_CLOSE, orderly save-before-quit, backup-before-fresh, overwrite refusal, crash-recovery inspection, and hidden tests. Explicit Windows executable overrides refuse a different running installation before lifecycle pipe access. No process killing or input simulation. |
| Import timing and asynchronous prompt safety | integration requirement; native 3.7.8 behavior | All Import2 paths temporarily disable Music Import prompts/tempo alignment using verified No/DoNothing preferences, then restore prior supported choices or native defaults. Unknown pipe outcomes defer preference restoration until explicit recovery has verified a response. |
| Track, clip, envelope and label inspection | All | `audacity_status`, `audacity_info`, and task tools. Track gain input is dB; reported volume is linear. Public audacity_track_set pan and reported pan are normalized [-1,1]; generic native SetTrack/SetTrackAudio Pan uses percentage [-100,100]. |
| Native setter targeting | Local catalogue; integration requirement | SetTrack/SetTrackStatus/SetTrackAudio/SetTrackVisuals/SetClip/SetEnvelope visit selected tracks. Unlisted Track/TrackCount/Channel/ChannelCount keys are accepted but ignored by Audacity and rejected here. Task tools select targets explicitly; generic setters require audacity_select. |
| Peak, RMS, DC, crest, clipping and silence measurement | X3, FF, MAX, DPF, BUCK | Selection/track export measured in Node; native WAV support, optional ffmpeg loudness/true peak, explicit unavailable metrics. Estimates and discontinuity counts are labelled as such. |
| Foreground/background contrast | X3, FF, MAX | Numeric RMS difference via export. `ContrastAnalyser` is modal and is never offered. |
| Native RMS analyzer | Local catalogue | `MeasureRms` opens blocking result dialogs on this 3.7.8 installation; excluded. Use `audacity_measure`. |
| Native Click Removal | X3, X4, MAX, FF, AN3, PIMP | Skipped: even valid no-click audio opens a blocking error dialog on live 3.7.8. Generic effect/menu calls, macros and pipeline `removeClicks:true` refuse it before editing. |
| Native Repair | X3, X4, MAX, FF, AN3, PIMP | Skipped: native modals occur for selections over 128 samples, missing surrounding context, or pitch/speed clips. GetInfo omits clip pitch/speed state, so bounding length alone cannot guarantee dialog-free repair. Advisory discontinuity measurement remains available. |
| Native spectral Nyquist editing | Local catalogue | Skipped: SpectralEditMultiTool, SpectralEditParametricEq, SpectralEditShelves and SpectralDelete require spectrogram/frequency-selection UI state that GetInfo does not report. Missing state opens a blocking native dialog before the plug-in runs. Ordinary frequency filters remain available. |
| Native sound labeling | X3, X4, MAX, FF, PIMP | Skipped: LabelSounds returns blocking result dialogs when no sound is detected or between-sound labeling finds fewer than two sounds; no silent mode exists. audacity_silence supplies advisory quiet intervals, and audacity_labels_set writes explicitly reviewed markers with different detection semantics. |
| Regular interval labels | X3, X4, MAX, FF | Equivalent: audacity_labels action=regular writes explicit interval markers. Native RegularIntervalLabels is reserved: trace errors leave debug state that opens modals even on later valid VERBOSE=None calls after recovery. Native count/region/adjust modes are not claimed. |
| Nyquist parameter and audio context guards | Local catalogue | Explicit controls and source-rate queries preflight filters, NoiseGate, LegacyLimiter and other retained effects. Processing requires source frames and an intersecting audio clip; CrossfadeClips also checks each participating portion because gaps are removed. See the compact effect requirements in README.md. |
| Native amplification limits | Local catalogue | Amplify Ratio is bounded to 0.003162..316.227766; clip sample gain is -50..36 dB. Native batch processing ignores AllowClipping=false, so the server rejects it instead of promising clipping prevention. Measure headroom before choosing gain. |
| Loudness reports and targets | MAX, DPF, BUCK | File/selection measurement, before/after comparisons and numeric target evaluation. No unsupported compliance or true-peak claim. |
| Cleanup and mastering | X3, FF, MAX, DPF, X4 | Reviewed, parameterized dry-run chains for cleanup, speech, podcast, interview, audiobook, vocals, live recordings, music and lo-fi. Noise capture requires explicit room tone in a known fresh process; reduction uses saved Audacity settings. |
| Native Noise Reduction controls | X3, X4, MAX, FF, AN3, PIMP, TACH | Partial: profile capture and reduction are supported, but 3.7.8 ignores Reduction/Sensitivity/Smoothing wire keys. NoiseReduction accepts only empty params and saved UI settings. One profile is captured per known fresh process; the identical track/interval can reuse it. Capture must fit wholly inside one audio clip and contain at least 4096 rendered and source frames. A silent one-sample SampleDataExport header supplies source rate; GetInfo does not report it. Reduction remains conservatively limited to the same captured audio track with unchanged identity; a different profile requires orderly restart. |
| Duck music under speech | X3, FF, MAX, X4 | Native AutoDuck with control-track topology checks; dry-run describes the edit. |
| Clip and track editing | All | Split, trim, duplicate, cut/copy/paste/delete, silence, join/disjoin, alignment, naming/color, track gain and clip sample gain, fades and mix/render. Trim removes all audio outside the kept range on selected tracks, including separate clips, without shifting time. Clip metadata uses a time strictly inside one clip. |
| Tone, noise, silence, chirp, DTMF, rhythm, pluck and drum generation | AN3, PIMP, X3, FF, MAX, X4 | Task generation plus catalogue generators. Time selection controls duration; unsupported Duration aliases are not guessed. |
| Labels, chapters and segmented audio | X3, FF, X4, TACH | Point/region label writing, querying, editing, files and region operations. Explicit time/track selection avoids label-text focus corrupting export. |
| Playback and recording | All | Play, region playback, pause, stop, cursor/position and recording control. Append requires one explicit audio track matching configured input channels. Recording uses cursor selection and respects the new-track preference; raw recording menus can open mismatch dialogs and are reserved. Timer Record is modal and skipped. |
| Saved macros | AN3, PIMP, FF, TACH | List and replay existing local macros only after every step passes catalogue and modal checks; no Macro Manager/Palette dialog. |
| Undo/redo and backups | All; BUCK checkpoints | Undo/redo of existing native menu/import history entries plus `.aup3` backups. Individual scripted effect/command calls use kSkipState and add no per-call undo entry. Approximate counted-undo checkpoints and per-pipeline rollback promises are skipped. |
| Preferences | AN3, PIMP, FF | Read preferences and set a small safe allowlist; no module, language, crash-recovery, device or pipe settings through unrestricted setters. |
| Audacity 4 realtime effect chains/presets | X4 | Skipped: custom-fork bridge APIs are absent from pinned Audacity 3.7.8. Destructive catalogue effects remain available. |
| Non-destructive clip pitch/speed and hidden-source reveal | X4 | Skipped as non-destructive APIs; destructive pitch/tempo/speed and trim operations cover the audio task with different semantics. |
| Project metadata editor and device/setup managers | AN3, PIMP, X3, FF, MAX, X4 | Modal UI is skipped. Existing file tags can be inspected with optional ffmpeg metadata tooling; no UI automation. |
| Whisper transcription/subtitle/model jobs | X3, FF, MAX, X4, BUCK | Optional feature not taken: upstream implementations require Python/faster-whisper, model downloads and GPU/runtime management. Export plus timestamped labels supports an external transcription stage without a hard dependency. |
| Neural denoise/dereverb/de-echo and stem isolation | DPF | Optional feature not taken: DeepFilterNet, Demucs and RoFormer use a large Python/ML stack and models. Audacity noise reduction and filtering are distinct available alternatives; this host does not expose VocalReductionAndIsolation. |
| General offline DSP/ML CLI, client installation and plugin bootstrap | DPF, MAX, AN3, PIMP | Skipped: this is an Audacity MCP server, not a second audio runtime or a client/plugin installer. |
| BPM/spectral centroid/flatness | DPF | Partial: BeatFinder and ordinary frequency filters are available, but no claimed tempo/centroid/flatness meter. Spectral Nyquist editing is reserved because its required UI state cannot be verified safely. Upstream uses librosa/NumPy; adding an unverified approximate music analyzer is not needed by the integration. |
| Raw modal menus, printing, help browser, configuration reset and UI drags | AN3, PIMP, FF | Skipped: blocking dialogs, actions outside audio editing, or explicitly forbidden mouse/keyboard simulation. Safe menu actions remain catalogue-bound. |
| Export codec coverage | X3, MAX, FF, DPF, PIMP, TACH | WAV/FLAC/MP3/OGG verified live on 3.7.8. AIFF returned Audacity's own `Could not export to AIFF format!`; Opus opened blocking result/error dialogs. AIFF/Opus are not offered, despite upstream extension lists. |
| Result-producing Nyquist modes | FF, PIMP, X3, MAX | SampleDataExport requires explicit FILENAME and MESSAGES=None; its silent one-sample Standard header supplies source rate, with selection restored and scratch removed after confirmed replies. RegularIntervalLabels and NoiseGate MODE=Analyze are refused because native dialogs can block the pipe. Task regular labels and exported measurement avoid those modes. |

Noise Reduction parameter/profile limitations were measured on live Audacity
3.7.8 and checked against its official
[NoiseReductionBase implementation](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-builtin-effects/NoiseReductionBase.cpp).
It initializes profiling state in the process, loads saved effect preferences,
and switches to reduction after profiling. Successful acceptance of an
unlisted wire key is insufficient evidence that the key changes processing.

Source-frame profile preflight was verified with 8 kHz and 48 kHz tracks in a
48 kHz project. The silent header from
[Sample Data Export](https://github.com/audacity/audacity/blob/Audacity-3.7.8/plug-ins/sample-data-export.ny)
reports the selected track's source rate, passed to Nyquist by
[NyquistBase](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-nyquist-effects/NyquistBase.cpp).
A higher-rate render can contain enough output frames while native profiling
still has too few source frames; both minima are checked before capture.

The official 3.7.8
[Nyquist host](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-nyquist-effects/NyquistBase.cpp)
shows nonempty plug-in result strings in message boxes, even during scripted
processing. The spectral plug-ins also require UI state before processing.
Their exclusions and the LabelSounds exclusion apply to generic commands,
effects, menus and saved macros. RegularIntervalLabels enables trace: evaluation
errors open a modal debug window and leave persistent debug state, including
after dialog closure and pipe recovery. It is reserved in favor of typed regular
markers. Untraced evaluation errors and printed log messages are distinct from
those blocking result/debug dialogs.

Individual scripting effect/command calls use `kSkipState` in the official
[3.7.8 batch command path](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/BatchCommands.cpp).
History operates existing native menu/import undo states; per-effect, per-macro
or per-pipeline rollback is not promised. Preserve a project backup first.
Batch options exclude noiseProfile because successive temporary tracks cannot
share the single process's verified source-track profile.

## Complete named-tool inventory

All **541 unique registered IDs** are accounted for: **255 named tools** below
and **286 generated/parameterized wrapper IDs** in the next table. Wrapper IDs
share 179 underlying actions. Source tool identifiers are retained verbatim;
descriptions and decisions here are original summaries of the implementation.
“Equivalent” covers the audio operation with safer composition or different
lifecycle semantics; “Partial” explicitly identifies the missing semantics.
Coverage describes implemented capability, not a claim that each historical
wrapper name or every possible parameter combination was live-tested. A
covered export operation uses the host-verified WAV/FLAC/MP3/OGG formats; the
AIFF/Opus exclusions above apply to every relevant upstream export wrapper.

The totals count each distinct upstream ID once, including wrapper aliases:

| Status | Named IDs | Wrapper IDs | Total IDs |
| --- | ---: | ---: | ---: |
| Covered | 165 | 124 | 289 |
| Equivalent | 35 | 76 | 111 |
| Partial | 19 | 1 | 20 |
| Skipped | 36 | 85 | 121 |
| Total | 255 | 286 | 541 |

| Upstream named tool | Sources | Status | Coverage or reason |
| --- | --- | --- | --- |
| `add_label` | TACH | Covered | audacity_labels_set writes point/region markers into a named track with correct flat-index bookkeeping. |
| `add_realtime_effect` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `add_realtime_effects` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `amplify` | TACH | Covered | audacity_effect native Amplify/FadeIn/FadeOut/BassAndTreble; audacity_fade adds explicit track/time scope. |
| `analyze_beat_finder` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `BeatFinder`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `analyze_contrast` | X3, MAX, FF | Equivalent | audacity_contrast measures foreground/background RMS difference by temporary export; ContrastAnalyser is modal. |
| `analyze_find_clipping` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `FindClipping`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `analyze_label_sounds` | X3, X4, MAX, FF | Skipped | LabelSounds opens blocking result dialogs on empty detections and insufficient between-sound regions; no silent mode exists. audacity_silence and audacity_labels_set provide advisory quiet intervals and explicit markers with different detection semantics. |
| `analyze_plot_spectrum` | X3, MAX, FF | Skipped | PlotSpectrum opens a modal window. Spectral Nyquist editing also requires UI state that GetInfo cannot verify; no speculative spectrum meter. |
| `analyze_sample_data_export` | X3, X4, MAX, FF | Covered | SampleDataExport via audacity_command requires MESSAGES=None and explicit FILENAME, avoiding result dialogs; explicit output ran live on 3.7.8. |
| `analyze_selection` | BUCK | Covered | audacity_measure reports selection peak/RMS/clipping and optional ffmpeg LUFS/true peak, with explicit unavailable metrics and restored selection. |
| `apply_effect` | BUCK | Covered | audacity_info/describe discovers installed typed effects; audacity_effect or ordered audited macro/pipeline steps applies them. |
| `apply_effect_preset` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `apply_effects` | X4 | Covered | audacity_info/describe discovers installed typed effects; audacity_effect or ordered audited macro/pipeline steps applies them. |
| `apply_macro` | TACH | Equivalent | `audacity_macros` parses and preflights saved macro steps; no palette dialog. |
| `auda_analyze` | DPF | Partial | audacity_measure/file reports peak/RMS/DC/crest/defects/silence and optional LUFS/LRA/true peak. BPM/spectral centroid/flatness and automatic subjective preset recommendations are skipped. |
| `auda_audacity_apply_master` | DPF | Covered | audacity_pipeline supplies reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi presets, explicit parameters and dryRun; no compliance promises. |
| `auda_audacity_do` | DPF | Equivalent | audacity_command/menu validates command names and parameters; arbitrary raw command injection is not exposed. |
| `auda_audacity_export` | DPF | Covered | audacity_export with explicit track/time selection. |
| `auda_audacity_import` | DPF | Covered | audacity_import. |
| `auda_audacity_status` | DPF | Covered | audacity_status and audacity_recover. |
| `auda_batch` | DPF | Covered | audacity_batch applies supported reviewed pipelines to isolated temporary tracks with dryRun and optional before/after reports. Options exclude noiseProfile: a process cannot safely profile successive temporary tracks. |
| `auda_compare` | DPF | Covered | audacity_compare_files with measurement deltas/targets; unavailable metrics remain unknown. |
| `auda_compressor` | DPF | Equivalent | Native Compressor through audacity_effect; no pedalboard dependency. |
| `auda_concat` | DPF | Equivalent | Import files, audacity_track_edit align_end_to_end or explicit clip positions, then export mix. |
| `auda_convert` | DPF | Equivalent | Import + SetProject Rate + export channels/container performs Audacity-rendered conversion; codec bitrate and arbitrary ffmpeg transcode switches are not exposed. |
| `auda_declick` | DPF | Partial | Advisory discontinuity analysis only. ClickRemoval opens a blocking no-change error on valid audio; Repair can also open modal errors for hidden clip pitch/speed state. Neither processing command is offered, and upstream Python median-filter DSP is not copied. |
| `auda_declip` | DPF | Equivalent | Native ClipFix through audacity_effect; reconstructed peaks cannot restore lost source information. |
| `auda_decrackle` | DPF | Partial | Advisory discontinuity analysis only. ClickRemoval and Repair can open modal errors and are refused; the separate Python median-blend crackle DSP engine is not taken. |
| `auda_deecho` | DPF | Skipped | Optional Python RoFormer models/runtime not taken. |
| `auda_dereverb` | DPF | Skipped | Optional Python RoFormer models/runtime not taken; not a clean Node-only Audacity capability. |
| `auda_eq` | DPF | Equivalent | FilterCurve/GraphicEq/High-passFilter/Low-passFilter/ShelfFilter/NotchFilter through the installed catalogue. |
| `auda_fade` | DPF | Equivalent | audacity_fade for linear fades; AdjustableFade/StudioFadeOut through audacity_effect cover other curves. |
| `auda_health` | DPF | Equivalent | audacity_status/recover inspect Audacity/pipe; optional measurement backends report availability. No ML runtime installer/device manager. |
| `auda_isolate_bass` | DPF | Skipped | Optional Demucs/Python/model stack not taken. |
| `auda_isolate_drums` | DPF | Skipped | Optional Demucs/Python/model stack not taken. |
| `auda_isolate_vocals` | DPF | Skipped | Optional Demucs/Python/model stack not taken. |
| `auda_karaoke` | DPF | Skipped | Upstream Demucs stem-mixing stack is not taken; no unsupported vocal-isolation claim. |
| `auda_limiter` | DPF | Partial | Native Limiter plus measured true peak when ffmpeg exists. Native limiter is not claimed to be a guaranteed brickwall true-peak processor. |
| `auda_loudness_normalize` | DPF | Covered | Native LoudnessNormalization plus audacity_loudness_target when a true-peak guard is wanted. |
| `auda_master` | DPF | Covered | audacity_pipeline supplies reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi presets, explicit parameters and dryRun; no compliance promises. |
| `auda_mix` | DPF | Equivalent | Import files, audacity_track_set gainDb/pan/mute, then export or mix/render. |
| `auda_peak_normalize` | DPF | Covered | Native Normalize through audacity_effect or audacity_pipeline loudness=peak. |
| `auda_probe` | DPF | Covered | audacity_probe_file, using optional ffprobe. |
| `auda_reduce_noise` | DPF | Partial | Native NoiseReduction with explicit room tone in a known fresh process and saved UI settings; programmable reduction/sensitivity/smoothing and Python spectral/DeepFilterNet engines are not included. |
| `auda_remove_silence` | DPF | Equivalent | audacity_silence finds quiet regions, then audacity_edit delete removes chosen ranges; native TruncateSilence offers automatic truncation. Timing changes explicitly. |
| `auda_reverb_add` | DPF | Equivalent | Native Reverb through audacity_effect. |
| `auda_separate_stems` | DPF | Skipped | Optional Demucs/Python/model stack not taken. |
| `auda_speed` | DPF | Equivalent | ChangeTempo or ChangeSpeedAndPitch through audacity_effect. |
| `auda_split_on_silence` | DPF | Equivalent | audacity_silence finds quiet gaps; split their boundaries with audacity_edit and write the intervening sound regions with audacity_labels_set, then audacity_label_regions_export. |
| `auda_stereo_widen` | DPF | Skipped | Upstream mid-side Python DSP has no installed catalogue equivalent; adding a second DSP engine is outside Audacity-only scope. |
| `auda_trim` | DPF | Equivalent | audacity_edit trim removes every exterior audio segment on selected tracks while preserving the retained timeline, followed by explicit export. |
| `auda_trim_silence` | DPF | Equivalent | audacity_silence finds leading/trailing quiet regions; audacity_edit trim keeps the intervening extent and retains internal pacing. |
| `audacity_health` | FF | Equivalent | audacity_status/recover and MCP server identity provide pipe/process/catalogue diagnostics; no installation/configuration daemon. |
| `audacity_health_check` | MAX | Equivalent | audacity_status/recover and MCP server identity provide pipe/process/catalogue diagnostics; no installation/configuration daemon. |
| `audacity_server_info` | FF | Equivalent | audacity_status/recover and MCP server identity provide pipe/process/catalogue diagnostics; no installation/configuration daemon. |
| `auto_analyze_audio` | X3, X4, MAX, FF | Partial | audacity_measure/file reports peak/RMS/DC/crest/defects/silence and optional LUFS/LRA/true peak. BPM/spectral centroid/flatness and automatic subjective preset recommendations are skipped. |
| `auto_audiobook_mastering` | X3, X4, MAX, FF | Covered | audacity_pipeline supplies reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi presets, explicit parameters and dryRun; no compliance promises. |
| `auto_cleanup_audio` | X3, X4, MAX, FF | Covered | audacity_pipeline supplies reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi presets, explicit parameters and dryRun; no compliance promises. |
| `auto_cleanup_interview` | X3, X4, MAX, FF | Covered | audacity_pipeline supplies reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi presets, explicit parameters and dryRun; no compliance promises. |
| `auto_cleanup_live` | X3, X4, MAX, FF | Covered | audacity_pipeline supplies reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi presets, explicit parameters and dryRun; no compliance promises. |
| `auto_cleanup_podcast` | X3, X4, MAX, FF | Covered | audacity_pipeline supplies reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi presets, explicit parameters and dryRun; no compliance promises. |
| `auto_cleanup_vocal` | X3, X4, MAX, FF | Covered | audacity_pipeline supplies reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi presets, explicit parameters and dryRun; no compliance promises. |
| `auto_lofi_effect` | X3, X4, MAX, FF | Covered | audacity_pipeline supplies reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi presets, explicit parameters and dryRun; no compliance promises. |
| `auto_loudness_target` | MAX | Covered | audacity_loudness_target measures LUFS/true peak, caps sample gain to headroom, supports dryRun and reports before/after; requires ffmpeg. |
| `auto_master_music` | X3, X4, MAX, FF | Covered | audacity_pipeline supplies reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi presets, explicit parameters and dryRun; no compliance promises. |
| `auto_noise_reduction_tuned` | MAX | Partial | Explicit room-tone measurement and start/end-only noiseProfile in audacity_pipeline, using saved Audacity settings. Native 3.7.8 ignores tuning wire keys; autonomous tuning from quiet-block estimates is also skipped because speech is not noise floor. |
| `bass_and_treble` | X4 | Covered | audacity_effect native Amplify/FadeIn/FadeOut/BassAndTreble; audacity_fade adds explicit track/time scope. |
| `check_pipeline_status` | X3, X4, MAX, FF | Equivalent | audacity_pipeline completes synchronously and reports applied steps; stops on the first failure. No popup or separate background polling. |
| `check_transcription_status` | X3, X4, MAX, FF | Skipped | Optional Whisper/Python/model-download stack not taken. Export audio and import externally produced TSV/JSON markers; SRT/VTT export is supported. |
| `checkpoint` | BUCK | Equivalent | Use audacity_project save to a new backup and audacity_fresh/project open. Approximate counted-Undo checkpoints are deliberately not offered. |
| `click_removal` | X3, X4, MAX, FF | Skipped | ClickRemoval opens a blocking error dialog when valid audio contains no removable clicks (live 3.7.8, 2026-10-02; confirmed in official ClickRemovalBase::Process). Generic tools, macros and pipeline removeClicks=true refuse it before editing. |
| `clip_render_pitch_speed` | X4 | Partial | The upstream non-destructive fork API is unavailable. ChangePitch/ChangeTempo/ChangeSpeedAndPitch process samples; hidden-source reveal/reset semantics are not reproduced. |
| `clip_reset_pitch` | X4 | Partial | The upstream non-destructive fork API is unavailable. ChangePitch/ChangeTempo/ChangeSpeedAndPitch process samples; hidden-source reveal/reset semantics are not reproduced. |
| `clip_reset_pitch_speed` | X4 | Partial | The upstream non-destructive fork API is unavailable. ChangePitch/ChangeTempo/ChangeSpeedAndPitch process samples; hidden-source reveal/reset semantics are not reproduced. |
| `clip_reset_speed` | X4 | Partial | The upstream non-destructive fork API is unavailable. ChangePitch/ChangeTempo/ChangeSpeedAndPitch process samples; hidden-source reveal/reset semantics are not reproduced. |
| `clip_set_color` | X4 | Covered | audacity_clip_set Color0..Color3 plus name/destructive gainDb; metadata requires a time strictly inside one clip to avoid changing neighboring boundary clips. |
| `clip_set_pitch` | X4 | Partial | The upstream non-destructive fork API is unavailable. ChangePitch/ChangeTempo/ChangeSpeedAndPitch process samples; hidden-source reveal/reset semantics are not reproduced. |
| `clip_set_speed` | X4 | Partial | The upstream non-destructive fork API is unavailable. ChangePitch/ChangeTempo/ChangeSpeedAndPitch process samples; hidden-source reveal/reset semantics are not reproduced. |
| `clip_split_at_silences` | X4 | Equivalent | audacity_silence finds quiet regions; audacity_edit split uses explicit boundaries. Native Disjoin also splits exact digital silence. |
| `clip_stretch` | X4 | Partial | The upstream non-destructive fork API is unavailable. ChangePitch/ChangeTempo/ChangeSpeedAndPitch process samples; hidden-source reveal/reset semantics are not reproduced. |
| `clip_trim` | X4 | Equivalent | audacity_edit trim/duplicate on explicit clip/track extent. Trim processes the selected audio task rather than preserving hidden-source fork semantics. |
| `command_status` | X4 | Skipped | Audacity 4 bridge background command IDs are not part of 3.7.8. Calls finish synchronously with checked replies; no duplicate job ledger. |
| `compressor` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `Compressor`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `cursor_set` | X4 | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `cursor_set_position` | X3, MAX, FF | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `cursor_to_project_end` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `cursor_to_project_start` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `cursor_to_track_end` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `cursor_to_track_start` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `edit_copy` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_cut` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_delete` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_disjoin` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_duplicate` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_join` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_paste` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_redo` | X4 | Covered | audacity_history redo operates native menu/import history states; individual script-pipe effects do not add a per-call undo state. |
| `edit_silence` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_split` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_split_cut` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_split_delete` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_split_new` | X3, X4, MAX, FF | Covered | audacity_edit for scoped sample/clip operations; audacity_history for undo/redo. |
| `edit_trim` | X3, X4, MAX, FF | Covered | audacity_edit trim removes all audio outside the retained range on selected tracks, including separate exterior clips, without shifting time. audacity_history supports undo/redo. |
| `edit_undo` | X4 | Covered | audacity_history undo operates native menu/import history states; individual script-pipe effects do not add a per-call undo state. |
| `effect_adjustable_fade` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `AdjustableFade`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_amplify` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `Amplify`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_auto_duck` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `AutoDuck`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_bass_and_treble` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `BassAndTreble`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_change_pitch` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `ChangePitch`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_change_speed` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `ChangeSpeedAndPitch`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_change_tempo` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `ChangeTempo`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_clip_fix` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `ClipFix`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_crossfade_clips` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `CrossfadeClips`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_crossfade_tracks` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `CrossfadeTracks`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_distortion` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `Distortion`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_echo` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `Echo`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_equalization` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `FilterCurve`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_fade_in` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `FadeIn`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_fade_out` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `FadeOut`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_high_pass_filter` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `High-passFilter`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_invert` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `Invert`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_low_pass_filter` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `Low-passFilter`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_notch_filter` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `NotchFilter`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_paulstretch` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `Paulstretch`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_phaser` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `Phaser`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_remove_dc_offset` | X4 | Covered | audacity_effect Normalize with RemoveDcOffset=true and ApplyVolume=false removes DC without peak normalization. |
| `effect_repair` | X3, X4, MAX, FF | Skipped | Native Repair opens modal errors for length, context and pitch/speed clip state. GetInfo omits the latter, preventing reliable dialog-free preflight; advisory discontinuity measurement does not repair samples. |
| `effect_repeat` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `Repeat`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_reverb` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `Reverb`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_reverse` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `Reverse`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_sliding_stretch` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `SlidingStretch`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_studio_fade_out` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `StudioFadeOut`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_tremolo` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `Tremolo`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `effect_vocal_reduction` | X3, MAX, FF | Skipped | VocalReductionAndIsolation is absent from this installed 3.7.8 catalogue. Neural stem isolation is also optional and excluded. |
| `effect_wahwah` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `Wahwah`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `export_audio` | TACH | Covered | audacity_export explicit mix/time range, or Export2 after audacity_select for selected tracks. |
| `export_labels` | TACH | Covered | audacity_labels_file: TSV/JSON import; TSV/JSON/SRT/VTT/chapters/CUE/Podlove/ffmetadata export. |
| `export_selection` | TACH | Covered | audacity_export explicit mix/time range, or Export2 after audacity_select for selected tracks. |
| `fade_in` | TACH | Covered | audacity_effect native Amplify/FadeIn/FadeOut/BassAndTreble; audacity_fade adds explicit track/time scope. |
| `fade_out` | TACH | Covered | audacity_effect native Amplify/FadeIn/FadeOut/BassAndTreble; audacity_fade adds explicit track/time scope. |
| `generate_chirp` | X3, X4, MAX, FF | Covered | audacity_generate tone/noise/silence/chirp/DTMF/rhythm; duration is an explicit time selection. |
| `generate_dtmf` | X3, X4, MAX, FF | Covered | audacity_generate tone/noise/silence/chirp/DTMF/rhythm; duration is an explicit time selection. |
| `generate_noise` | X3, X4, MAX, FF | Covered | audacity_generate tone/noise/silence/chirp/DTMF/rhythm; duration is an explicit time selection. |
| `generate_rhythm_track` | X3, X4, MAX, FF | Covered | audacity_generate tone/noise/silence/chirp/DTMF/rhythm; duration is an explicit time selection. |
| `generate_silence` | X4 | Covered | audacity_generate tone/noise/silence/chirp/DTMF/rhythm; duration is an explicit time selection. |
| `generate_tone` | X3, X4, MAX, FF | Covered | audacity_generate tone/noise/silence/chirp/DTMF/rhythm; duration is an explicit time selection. |
| `get_default_export_folder` | X3, X4, MAX, FF | Equivalent | Read the configured path through audacity_preferences; exports always require explicit destinations. |
| `get_default_transcription_folder` | X3, X4, MAX, FF | Skipped | Optional Whisper/Python/model-download stack not taken. Export audio and import externally produced TSV/JSON markers; SRT/VTT export is supported. |
| `get_labels` | TACH | Covered | audacity_labels list/find/edit/delete/regular; delete reconstructs only the affected label track and returns updated indices. |
| `get_noise_profile` | X3, X4, MAX, FF | Covered | audacity_noise_profile captures explicit room tone in a known fresh process. An identical track/interval reuses the known profile; a different one requires audacity_fresh because 3.7.8 has no scripted profile reset. |
| `get_project_state` | BUCK | Covered | audacity_project_info tracks/clips/selection/length/rate/active files; audacity_info for catalogue detail. |
| `get_selection` | TACH | Covered | audacity_info Selection or audacity_command GetInfo Type=Selection. |
| `get_tracks` | TACH | Covered | audacity_status / audacity_info Tracks. |
| `import_audio` | TACH | Covered | audacity_import with path, name and start position. |
| `label_add` | X3, X4, MAX, FF | Covered | audacity_labels_set writes point/region markers into a named track with correct flat-index bookkeeping. |
| `label_add_at` | X3, X4, MAX, FF | Covered | audacity_labels_set writes point/region markers into a named track with correct flat-index bookkeeping. |
| `label_add_batch` | X3, X4, FF | Covered | audacity_labels_set writes point/region markers into a named track with correct flat-index bookkeeping. |
| `label_add_track` | X4 | Covered | audacity_track_edit adds/removes/mixes/aligns explicit tracks; validates audio topology. |
| `label_cut_regions` | X3, X4, FF | Covered | audacity_menu `CutLabels` for selected label regions; select time/tracks explicitly. |
| `label_delete` | X3, FF | Covered | audacity_labels list/find/edit/delete/regular; delete reconstructs only the affected label track and returns updated indices. |
| `label_delete_audio_at` | X3, X4, FF | Equivalent | List label timings, then audacity_edit delete on explicit audio tracks/time. Marker and audio deletion remain distinct. |
| `label_delete_regions` | X3, X4, FF | Covered | audacity_menu `DeleteLabels` for selected label regions; select time/tracks explicitly. |
| `label_edit` | X3, X4, FF | Covered | audacity_labels list/find/edit/delete/regular; delete reconstructs only the affected label track and returns updated indices. |
| `label_export` | X3, X4, MAX, FF | Covered | audacity_labels_file: TSV/JSON import; TSV/JSON/SRT/VTT/chapters/CUE/Podlove/ffmetadata export. |
| `label_export_audio_segments` | X3, X4, FF | Covered | audacity_label_regions_export writes each positive-duration label region from the current mix, refusing existing outputs. |
| `label_export_chapters` | X3, X4, FF | Covered | audacity_labels_file: TSV/JSON import; TSV/JSON/SRT/VTT/chapters/CUE/Podlove/ffmetadata export. |
| `label_find` | X3, X4, FF | Covered | audacity_labels list/find/edit/delete/regular; delete reconstructs only the affected label track and returns updated indices. |
| `label_get_all` | X3, X4, MAX, FF | Covered | audacity_labels list/find/edit/delete/regular; delete reconstructs only the affected label track and returns updated indices. |
| `label_import` | X3, X4, MAX, FF | Covered | audacity_labels_file: TSV/JSON import; TSV/JSON/SRT/VTT/chapters/CUE/Podlove/ffmetadata export. |
| `label_join_regions` | X3, X4, FF | Covered | audacity_menu `JoinLabels` for selected label regions; select time/tracks explicitly. |
| `label_list` | X3, X4, FF | Covered | audacity_labels list/find/edit/delete/regular; delete reconstructs only the affected label track and returns updated indices. |
| `label_regular_intervals` | X3, X4, MAX, FF | Equivalent | audacity_labels action=regular writes explicit interval markers. Native RegularIntervalLabels is reserved because traced debug state can open persistent modals; native count/region/adjust modes are not claimed. |
| `label_remove` | X4 | Covered | audacity_labels list/find/edit/delete/regular; delete reconstructs only the affected label track and returns updated indices. |
| `label_silence_regions` | X3, X4, FF | Covered | audacity_menu `SilenceLabels` for selected label regions; select time/tracks explicitly. |
| `label_split_regions` | X3, X4, FF | Covered | audacity_menu `SplitLabels` for selected label regions; select time/tracks explicitly. |
| `label_update_text` | X4 | Covered | audacity_labels list/find/edit/delete/regular; delete reconstructs only the affected label track and returns updated indices. |
| `limiter` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `Limiter`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `list_effect_parameters` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `list_effect_presets` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `list_effects` | X4, BUCK | Covered | audacity_info/describe discovers installed typed effects; audacity_effect or ordered audited macro/pipeline steps applies them. |
| `list_realtime_effects` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `loudness_normalize` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `LoudnessNormalization`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `nearest_zero_crossing` | X4 | Partial | ZeroCross adjusts a selection boundary; the 3.7.8 pipe has no verified numeric nearest-crossing query. |
| `noise_reduction` | X3, X4, MAX, FF | Partial | audacity_effect / audacity_command NoiseReduction accepts params={} after server-tracked profiling in a fresh process. Native 3.7.8 uses saved UI settings and ignores reduction/sensitivity/smoothing wire keys, so programmable tuning is not covered. |
| `noise_reduction_apply` | TACH | Partial | audacity_effect NoiseReduction with params={} after explicit server-tracked profile; saved UI settings determine processing. Reduction/Sensitivity/Smoothing are refused because native 3.7.8 ignores them. |
| `noise_reduction_profile` | TACH | Covered | audacity_noise_profile captures one explicit room-tone interval per known fresh process. Identical track/interval requests reuse it; different profiles require audacity_fresh. |
| `normalize` | X3, X4, MAX, FF, TACH | Covered | audacity_effect / audacity_command: `Normalize`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `play` | BUCK, TACH | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `project_close` | X3, X4, MAX, FF | Equivalent | audacity_fresh/project/quit uses one window, backup-before-fresh and new-path saves; dangerous modal lifecycle menus are reserved. |
| `project_edit_metadata` | X3, MAX, FF | Skipped | EditMetaData is modal. File metadata inspection is available through optional audacity_probe_file. |
| `project_export_audio` | X3, X4, MAX, FF | Covered | audacity_export explicit mix/time range, or Export2 after audacity_select for selected tracks. |
| `project_export_labels` | X3, MAX, FF | Covered | audacity_labels_file: TSV/JSON import; TSV/JSON/SRT/VTT/chapters/CUE/Podlove/ffmetadata export. |
| `project_export_selection` | X4 | Covered | audacity_export explicit mix/time range, or Export2 after audacity_select for selected tracks. |
| `project_get_info` | X3, X4, MAX, FF | Covered | audacity_project_info tracks/clips/selection/length/rate/active files; audacity_info for catalogue detail. |
| `project_get_metadata` | X4 | Partial | Optional audacity_probe_file reads file tags. Editing project metadata needs absent fork APIs or a modal editor and is skipped. |
| `project_import_audio` | X3, X4, MAX, FF | Covered | audacity_import with path, name and start position. |
| `project_import_midi` | X3, MAX, FF | Skipped | Pinned pipe exposes no verified dialog-free parameterized importer for MIDI/raw headers; Import2 covers supported audio/video sound. |
| `project_new` | X3, X4, MAX, FF | Equivalent | audacity_fresh/project/quit uses one window, backup-before-fresh and new-path saves; dangerous modal lifecycle menus are reserved. |
| `project_open` | X3, X4, MAX, FF | Equivalent | audacity_fresh/project/quit uses one window, backup-before-fresh and new-path saves; dangerous modal lifecycle menus are reserved. |
| `project_save` | X3, X4, MAX, FF | Equivalent | audacity_fresh/project/quit uses one window, backup-before-fresh and new-path saves; dangerous modal lifecycle menus are reserved. |
| `project_save_as` | X3, X4, MAX, FF | Equivalent | audacity_fresh/project/quit uses one window, backup-before-fresh and new-path saves; dangerous modal lifecycle menus are reserved. |
| `project_set_metadata` | X4 | Partial | Optional audacity_probe_file reads file tags. Editing project metadata needs absent fork APIs or a modal editor and is skipped. |
| `recent_commands` | X4 | Skipped | Audacity 4 bridge background command IDs are not part of 3.7.8. Calls finish synchronously with checked replies; no duplicate job ledger. |
| `record` | BUCK | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `remove_realtime_effect` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `revert` | BUCK | Equivalent | Use audacity_project save to a new backup and audacity_fresh/project open. Approximate counted-Undo checkpoints are deliberately not offered. |
| `rewind` | TACH | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `select_all` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `select_clip` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `select_cursor_to_track_end` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `select_none` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `select_region` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `select_time` | TACH | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `select_tracks` | X3, X4, MAX, FF, TACH | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `select_zero_crossing` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `set_effect_parameter` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `set_effect_parameters` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `set_realtime_effect_active` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `split_range_at_silences` | X4 | Equivalent | audacity_silence finds quiet regions; audacity_edit split uses explicit boundaries. Native Disjoin also splits exact digital silence. |
| `stop` | BUCK, TACH | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `suggest_and_add_effect` | X4 | Skipped | Audacity 4 custom-fork realtime/plugin bridge API; unavailable in pinned 3.7.8. Destructive catalogue effects remain available. |
| `track_add_label` | X3, MAX, FF | Covered | audacity_track_edit adds/removes/mixes/aligns explicit tracks; validates audio topology. |
| `track_add_mono` | X3, X4, MAX, FF | Covered | audacity_track_edit adds/removes/mixes/aligns explicit tracks; validates audio topology. |
| `track_add_stereo` | X3, X4, MAX, FF | Covered | audacity_track_edit adds/removes/mixes/aligns explicit tracks; validates audio topology. |
| `track_align_end_to_end` | X3, MAX, FF | Covered | audacity_track_edit adds/removes/mixes/aligns explicit tracks; validates audio topology. |
| `track_duplicate` | X4 | Equivalent | audacity_edit trim/duplicate on explicit clip/track extent. Trim processes the selected audio task rather than preserving hidden-source fork semantics. |
| `track_get_info` | X3, X4, MAX, FF | Covered | audacity_status / audacity_info Tracks. |
| `track_mix_and_render` | X3, MAX, FF | Covered | audacity_track_edit adds/removes/mixes/aligns explicit tracks; validates audio topology. |
| `track_mix_and_render_to_new` | X3, MAX, FF | Covered | audacity_track_edit adds/removes/mixes/aligns explicit tracks; validates audio topology. |
| `track_mute` | X3, X4, MAX, FF | Covered | audacity_track_set gainDb/name/pan/mute/solo; status volume is a linear factor. |
| `track_mute_all` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `track_remove` | X3, X4, MAX, FF | Covered | audacity_track_edit adds/removes/mixes/aligns explicit tracks; validates audio topology. |
| `track_resample` | X3, X4, MAX, FF | Skipped | Native Resample is modal on 3.7.8. Project render rate can be set via SetProject; this does not claim to rewrite a source track rate. |
| `track_select` | X3, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `track_set_color` | X4 | Covered | audacity_command SetTrackVisuals Color on an explicit selection. |
| `track_set_properties` | X3, X4, MAX, FF | Covered | audacity_track_set gainDb/name/pan/mute/solo; status volume is a linear factor. |
| `track_stereo_to_mono` | X3, MAX, FF | Covered | audacity_effect / audacity_command: `StereoToMono`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `track_unmute_all` | X3, X4, MAX, FF | Covered | audacity_select plus catalogue SelectTime/SelectTracks and safe selection/cursor/mute menus. |
| `transcribe_audio` | X3, X4, MAX, FF | Skipped | Optional Whisper/Python/model-download stack not taken. Export audio and import externally produced TSV/JSON markers; SRT/VTT export is supported. |
| `transcribe_selection` | X3, X4, MAX, FF, BUCK | Skipped | Optional Whisper/Python/model-download stack not taken. Export audio and import externally produced TSV/JSON markers; SRT/VTT export is supported. |
| `transcribe_to_file` | X3, X4, MAX, FF | Skipped | Optional Whisper/Python/model-download stack not taken. Export audio and import externally produced TSV/JSON markers; SRT/VTT export is supported. |
| `transcribe_to_labels` | X3, X4, MAX, FF | Skipped | Optional Whisper/Python/model-download stack not taken. Export audio and import externally produced TSV/JSON markers; SRT/VTT export is supported. |
| `transcription_set_model` | X3, X4, MAX, FF | Skipped | Optional Whisper/Python/model-download stack not taken. Models remain the responsibility of an external transcription stage. |
| `transport_get_play_position` | X3, X4, MAX, FF | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `transport_pause` | X3, X4, MAX, FF | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `transport_play` | X3, X4, MAX, FF | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `transport_play_region` | X3, X4, MAX, FF | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `transport_play_stop` | X4 | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `transport_record` | X3, X4, MAX, FF | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `transport_rewind_start` | X4 | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `transport_set_cursor` | X3, MAX, FF | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `transport_stop` | X3, X4, MAX, FF | Covered | audacity_transport and explicit SelectTime/cursor safe menus. Position is an honest server clock estimate, not a queried Audacity audio clock; manual changes are unknown. |
| `truncate_silence` | X3, X4, MAX, FF | Covered | audacity_effect / audacity_command: `TruncateSilence`. Parameters come from the installed catalogue, not historical upstream aliases. |
| `undo` | TACH | Covered | audacity_history undo operates existing native history; it cannot undo each individual scripted effect call. |

## Complete generated/parameterized wrapper inventory

AN3/PIMP `cmd_*` IDs and FF `raw_*` IDs are grouped by their underlying action.
Parenthesized source keys apply to each individual ID. Old spelling/casing is
mapped to the actual installed catalogue where there is a verified equivalent.
The server never executes an upstream identifier merely because it appears here.

| Upstream wrapper IDs and sources | Underlying action | Status | Coverage or reason |
| --- | --- | --- | --- |
| `cmd_About` (AN3, PIMP); `raw_about` (FF) | `About` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_AddLabel` (AN3, PIMP) | `AddLabel` | Covered | `audacity_menu`: `AddLabel`; no-argument safe menu. |
| `cmd_AdjustableFade` (PIMP) | `AdjustableFade` | Covered | `audacity_command` / `audacity_effect`: `AdjustableFade`; strict live catalogue parameters. |
| `cmd_Amplify` (AN3, PIMP) | `Amplify` | Covered | `audacity_command` / `audacity_effect`: `Amplify`; strict live catalogue parameters. |
| `cmd_ApplyMacro` (AN3, PIMP); `raw_apply_macro` (FF) | `ApplyMacro` | Equivalent | `audacity_macros` parses and preflights saved macro steps; no palette dialog. |
| `cmd_AutoDuck` (AN3, PIMP) | `AutoDuck` | Covered | `audacity_command` / `audacity_effect`: `AutoDuck`; strict live catalogue parameters. |
| `cmd_BassAndTreble` (AN3, PIMP) | `BassAndTreble` | Covered | `audacity_command` / `audacity_effect`: `BassAndTreble`; strict live catalogue parameters. |
| `cmd_BeatFinder` (PIMP) | `BeatFinder` | Covered | `audacity_command` / `audacity_effect`: `BeatFinder`; strict live catalogue parameters. |
| `cmd_BeatsandMeasures` (AN3, PIMP); `raw_beatsand_measures` (FF) | `BeatsandMeasures` | Covered | `audacity_menu`: `BeatsAndMeasures`; no-argument safe menu. |
| `cmd_ChangeAudio` (AN3, PIMP); `raw_change_audio` (FF) | `ChangeAudio` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_ChangePitch` (AN3, PIMP) | `ChangePitch` | Covered | `audacity_command` / `audacity_effect`: `ChangePitch`; strict live catalogue parameters. |
| `cmd_ChangeSpeed` (AN3, PIMP) | `ChangeSpeed` | Covered | `audacity_command` / `audacity_effect`: `ChangeSpeedAndPitch`; strict live catalogue parameters. |
| `cmd_ChangeTempo` (AN3, PIMP) | `ChangeTempo` | Covered | `audacity_command` / `audacity_effect`: `ChangeTempo`; strict live catalogue parameters. |
| `cmd_CheckDeps` (AN3, PIMP); `raw_check_deps` (FF) | `CheckDeps` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Chirp` (AN3, PIMP) | `Chirp` | Covered | `audacity_command` / `audacity_effect`: `Chirp`; strict live catalogue parameters. |
| `cmd_ClickRemoval` (AN3, PIMP) | `ClickRemoval` | Skipped | Native ClickRemoval can open a blocking no-change error even with valid parameters and audio; refused after live 3.7.8 verification and official source inspection. |
| `cmd_Close` (AN3, PIMP) | `Close` | Equivalent | `audacity_quit` closes the single process after saving; fresh can restart. |
| `cmd_CompareAudio` (AN3, PIMP); `raw_compare_audio` (FF) | `CompareAudio` | Covered | `audacity_command`: `CompareAudio`; strict live catalogue parameters. |
| `cmd_Compressor` (AN3, PIMP) | `Compressor` | Covered | `audacity_command` / `audacity_effect`: `Compressor`; strict live catalogue parameters. |
| `cmd_ContrastAnalyser` (AN3, PIMP) | `ContrastAnalyser` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Copy` (AN3, PIMP) | `Copy` | Covered | `audacity_menu`: `Copy`; no-argument safe menu. |
| `cmd_CrashReport` (AN3, PIMP); `raw_crash_report` (FF) | `CrashReport` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_CursorLeft` (AN3, PIMP); `raw_cursor_left` (FF) | `CursorLeft` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_CursorLongJumpLeft` (AN3, PIMP); `raw_cursor_long_jump_left` (FF) | `CursorLongJumpLeft` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_CursorLongJumpRight` (AN3, PIMP); `raw_cursor_long_jump_right` (FF) | `CursorLongJumpRight` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_CursorRight` (AN3, PIMP); `raw_cursor_right` (FF) | `CursorRight` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_CursorShortJumpLeft` (AN3, PIMP); `raw_cursor_short_jump_left` (FF) | `CursorShortJumpLeft` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_CursorShortJumpRight` (AN3, PIMP); `raw_cursor_short_jump_right` (FF) | `CursorShortJumpRight` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_Cut` (AN3, PIMP) | `Cut` | Covered | `audacity_menu`: `Cut`; no-argument safe menu. |
| `cmd_Delay` (AN3, PIMP); `raw_delay` (FF) | `Delay` | Covered | `audacity_command` / `audacity_effect`: `Delay`; strict live catalogue parameters. |
| `cmd_Delete` (AN3, PIMP) | `Delete` | Covered | `audacity_menu`: `Delete`; no-argument safe menu. |
| `cmd_DeviceInfo` (AN3, PIMP); `raw_device_info` (FF) | `DeviceInfo` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Distortion` (AN3, PIMP) | `Distortion` | Covered | `audacity_command` / `audacity_effect`: `Distortion`; strict live catalogue parameters. |
| `cmd_Drag` (AN3, PIMP); `raw_drag` (FF) | `Drag` | Skipped | Mouse/keyboard simulation is prohibited; use typed track/clip/envelope operations. |
| `cmd_DtmfTones` (AN3, PIMP) | `DtmfTones` | Covered | `audacity_command` / `audacity_effect`: `DtmfTones`; strict live catalogue parameters. |
| `cmd_Duplicate` (AN3, PIMP) | `Duplicate` | Covered | `audacity_menu`: `Duplicate`; no-argument safe menu. |
| `cmd_Echo` (AN3, PIMP) | `Echo` | Covered | `audacity_command` / `audacity_effect`: `Echo`; strict live catalogue parameters. |
| `cmd_EditLabels` (AN3, PIMP); `raw_edit_labels` (FF) | `EditLabels` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_EditMetaData` (AN3, PIMP) | `EditMetaData` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Exit` (AN3, PIMP); `raw_exit` (FF) | `Exit` | Equivalent | `audacity_quit` avoids prompts and stale recovery entries. |
| `cmd_Export2` (AN3, PIMP) | `Export2` | Covered | `audacity_command`: `Export2`; strict live catalogue parameters. |
| `cmd_ExportAudio` (AN3, PIMP); `raw_export_audio` (FF) | `ExportAudio` | Equivalent | `audacity_export` with an explicit destination. |
| `cmd_FadeIn` (AN3, PIMP) | `FadeIn` | Covered | `audacity_command` / `audacity_effect`: `FadeIn`; strict live catalogue parameters. |
| `cmd_FadeOut` (AN3, PIMP) | `FadeOut` | Covered | `audacity_command` / `audacity_effect`: `FadeOut`; strict live catalogue parameters. |
| `cmd_FilterCurve` (AN3, PIMP) | `FilterCurve` | Covered | `audacity_command` / `audacity_effect`: `FilterCurve`; strict live catalogue parameters. |
| `cmd_FirstTrack` (AN3, PIMP); `raw_first_track` (FF) | `FirstTrack` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_GetInfo` (AN3, PIMP) | `GetInfo` | Covered | `audacity_command`: `GetInfo`; strict live catalogue parameters. |
| `cmd_GetPreference` (AN3, PIMP); `raw_get_preference` (FF) | `GetPreference` | Covered | `audacity_command`: `GetPreference`; strict live catalogue parameters. |
| `cmd_GraphicEq` (AN3, PIMP); `raw_graphic_eq` (FF) | `GraphicEq` | Covered | `audacity_command` / `audacity_effect`: `GraphicEq`; strict live catalogue parameters. |
| `cmd_Help` (AN3, PIMP); `raw_help` (FF) | `Help` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_HighPassFilter` (PIMP) | `HighPassFilter` | Covered | `audacity_command` / `audacity_effect`: `High-passFilter`; strict live catalogue parameters. |
| `cmd_Import2` (AN3, PIMP) | `Import2` | Covered | `audacity_command` / `audacity_import`: Import2 with strict catalogue parameters and temporary music-import guards prevents asynchronous prompts and automatic tempo/timing changes; prior preferences are restored. |
| `cmd_ImportAudio` (AN3, PIMP); `raw_import_audio` (FF) | `ImportAudio` | Equivalent | `audacity_import` / `Import2` with an explicit path. |
| `cmd_ImportLabels` (AN3, PIMP) | `ImportLabels` | Equivalent | `audacity_labels_file` imports TSV/JSON without a file dialog. |
| `cmd_ImportMIDI` (AN3, PIMP) | `ImportMIDI` | Skipped | Pinned pipe exposes no verified dialog-free parameterized importer for MIDI/raw headers; Import2 covers supported audio/video sound. |
| `cmd_ImportRaw` (AN3, PIMP); `raw_import_raw` (FF) | `ImportRaw` | Skipped | Pinned pipe exposes no verified dialog-free parameterized importer for MIDI/raw headers; Import2 covers supported audio/video sound. |
| `cmd_InputDevice` (AN3, PIMP); `raw_input_device` (FF) | `InputDevice` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Invert` (AN3, PIMP) | `Invert` | Covered | `audacity_command` / `audacity_effect`: `Invert`; strict live catalogue parameters. |
| `cmd_Karaoke` (AN3, PIMP); `raw_karaoke` (FF) | `Karaoke` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_LabelSounds` (PIMP) | `LabelSounds` | Skipped | LabelSounds has blocking result dialogs and no silent mode. audacity_silence plus explicit audacity_labels_set markers uses different detection semantics. |
| `cmd_LastTrack` (AN3, PIMP); `raw_last_track` (FF) | `LastTrack` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_Limiter` (PIMP) | `Limiter` | Covered | `audacity_command` / `audacity_effect`: `Limiter`; strict live catalogue parameters. |
| `cmd_Log` (AN3, PIMP); `raw_log` (FF) | `Log` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_LoudnessNormalization` (AN3, PIMP) | `LoudnessNormalization` | Covered | `audacity_command` / `audacity_effect`: `LoudnessNormalization`; strict live catalogue parameters. |
| `cmd_LowPassFilter` (PIMP) | `LowPassFilter` | Covered | `audacity_command` / `audacity_effect`: `Low-passFilter`; strict live catalogue parameters. |
| `cmd_ManageAnalyzers` (AN3, PIMP); `raw_manage_analyzers` (FF) | `ManageAnalyzers` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_ManageMacros` (AN3, PIMP); `raw_manage_macros` (FF) | `ManageMacros` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_ManageTools` (AN3, PIMP); `raw_manage_tools` (FF) | `ManageTools` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Manual` (AN3, PIMP); `raw_manual` (FF) | `Manual` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Message` (AN3, PIMP); `raw_message` (FF) | `Message` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_MidiDeviceInfo` (AN3, PIMP); `raw_midi_device_info` (FF) | `MidiDeviceInfo` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_MinutesandSeconds` (AN3, PIMP); `raw_minutesand_seconds` (FF) | `MinutesandSeconds` | Covered | `audacity_menu`: `MinutesAndSeconds`; no-argument safe menu. |
| `cmd_MixerBoard` (AN3, PIMP); `raw_mixer_board` (FF) | `MixerBoard` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_New` (AN3, PIMP) | `New` | Equivalent | `audacity_fresh` saves a backup and restarts one window; New itself is denied after live crashes. |
| `cmd_NextFrame` (AN3, PIMP); `raw_next_frame` (FF) | `NextFrame` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_NextTrack` (AN3, PIMP); `raw_next_track` (FF) | `NextTrack` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_NextWindow` (AN3, PIMP); `raw_next_window` (FF) | `NextWindow` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_Noise` (AN3, PIMP) | `Noise` | Covered | `audacity_command` / `audacity_effect`: `Noise`; strict live catalogue parameters. |
| `cmd_NoiseGate` (PIMP) | `NoiseGate` | Covered | `audacity_command` / `audacity_effect`: `NoiseGate`; MODE=Analyze is refused to avoid a result dialog. |
| `cmd_NoiseReduction` (AN3, PIMP) | `NoiseReduction` | Partial | `audacity_command` / `audacity_effect`: `NoiseReduction` with params={} after known server profiling. Native processing uses saved UI settings; historical tuning parameters are not supported. |
| `cmd_Normalize` (AN3, PIMP) | `Normalize` | Covered | `audacity_command` / `audacity_effect`: `Normalize`; strict live catalogue parameters. |
| `cmd_NotchFilter` (PIMP) | `NotchFilter` | Covered | `audacity_command` / `audacity_effect`: `NotchFilter`; strict live catalogue parameters. |
| `cmd_Nyquist` (AN3, PIMP); `raw_nyquist` (FF) | `Nyquist` | Skipped | Arbitrary programs/plugin installation and their blocking prompt are outside the catalogue-bound server. |
| `cmd_Open` (AN3, PIMP); `raw_open` (FF) | `Open` | Equivalent | `audacity_project` open or `audacity_import` with explicit paths avoids file dialogs. |
| `cmd_OpenProject2` (AN3, PIMP) | `OpenProject2` | Equivalent | `audacity_project` open prevents unsafe multi-window project opening. |
| `cmd_OutputDevice` (AN3, PIMP); `raw_output_device` (FF) | `OutputDevice` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Paste` (AN3, PIMP) | `Paste` | Covered | `audacity_menu`: `Paste`; no-argument safe menu. |
| `cmd_PasteNewLabel` (AN3, PIMP); `raw_paste_new_label` (FF) | `PasteNewLabel` | Covered | `audacity_menu`: `PasteNewLabel`; no-argument safe menu. |
| `cmd_Paulstretch` (AN3, PIMP); `raw_paulstretch` (FF) | `Paulstretch` | Covered | `audacity_command` / `audacity_effect`: `Paulstretch`; strict live catalogue parameters. |
| `cmd_Pause` (AN3, PIMP) | `Pause` | Covered | `audacity_menu`: `Pause`; no-argument safe menu. |
| `cmd_Phaser` (AN3, PIMP) | `Phaser` | Covered | `audacity_command` / `audacity_effect`: `Phaser`; strict live catalogue parameters. |
| `cmd_PlayStop` (AN3, PIMP); `raw_play_stop` (FF) | `PlayStop` | Covered | `audacity_menu`: `DefaultPlayStop`; no-argument safe menu. |
| `cmd_PlayStopSelect` (AN3, PIMP); `raw_play_stop_select` (FF) | `PlayStopSelect` | Covered | `audacity_menu`: `PlayStopSelect`; no-argument safe menu. |
| `cmd_PlotSpectrum` (AN3, PIMP) | `PlotSpectrum` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Pluck` (AN3, PIMP); `raw_pluck` (FF) | `Pluck` | Covered | `audacity_command` / `audacity_effect`: `Pluck`; strict live catalogue parameters. |
| `cmd_PrevFrame` (AN3, PIMP); `raw_prev_frame` (FF) | `PrevFrame` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_PrevTrack` (AN3, PIMP); `raw_prev_track` (FF) | `PrevTrack` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_PrevWindow` (AN3, PIMP); `raw_prev_window` (FF) | `PrevWindow` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_Print` (AN3, PIMP); `raw_print` (FF) | `Print` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_PunchAndRoll` (AN3, PIMP); `raw_punch_and_roll` (FF) | `PunchAndRoll` | Skipped | Interactive transport mode excluded; use explicit time selection and play/record/stop. |
| `cmd_QuickHelp` (AN3, PIMP); `raw_quick_help` (FF) | `QuickHelp` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Record1stChoice` (AN3, PIMP) | `Record1stChoice` | Covered | `audacity_transport` record: guarded new/append mode, explicit channel-matched append target and cursor selection. Native choice follows the recording preference; raw menu calls are reserved to prevent mismatch dialogs. |
| `cmd_Record2ndChoice` (AN3, PIMP); `raw_record2nd_choice` (FF) | `Record2ndChoice` | Covered | `audacity_transport` record: guarded new/append mode, explicit channel-matched append target and cursor selection. Native choice follows the recording preference; raw menu calls are reserved to prevent mismatch dialogs. |
| `cmd_Redo` (AN3, PIMP); `raw_redo` (FF) | `Redo` | Covered | `audacity_menu`: `Redo`; no-argument safe menu. |
| `cmd_Repair` (AN3, PIMP) | `Repair` | Skipped | Native Repair opens modal errors for length, context and pitch/speed clip state; GetInfo omits the latter, preventing reliable dialog-free preflight. |
| `cmd_Repeat` (AN3, PIMP) | `Repeat` | Covered | `audacity_command` / `audacity_effect`: `Repeat`; strict live catalogue parameters. |
| `cmd_Reverb` (AN3, PIMP) | `Reverb` | Covered | `audacity_command` / `audacity_effect`: `Reverb`; strict live catalogue parameters. |
| `cmd_Reverse` (AN3, PIMP) | `Reverse` | Covered | `audacity_command` / `audacity_effect`: `Reverse`; strict live catalogue parameters. |
| `cmd_RhythmTrack` (AN3, PIMP) | `RhythmTrack` | Covered | `audacity_command` / `audacity_effect`: `RhythmTrack`; strict live catalogue parameters. |
| `cmd_RissetDrum` (AN3, PIMP); `raw_risset_drum` (FF) | `RissetDrum` | Covered | `audacity_command` / `audacity_effect`: `RissetDrum`; strict live catalogue parameters. |
| `cmd_Save` (AN3, PIMP); `raw_save` (FF) | `Save` | Equivalent | `audacity_project` save under a new path; overwriting `.aup3` is refused. |
| `cmd_SaveAs` (AN3, PIMP); `raw_save_as` (FF) | `SaveAs` | Equivalent | `audacity_project` save under a new path. |
| `cmd_SaveCompressed` (AN3, PIMP); `raw_save_compressed` (FF) | `SaveCompressed` | Skipped | Modal compressed-project save is not a live/headless audio need; use regular `.aup3` save plus audio export. |
| `cmd_SaveCopy` (AN3, PIMP); `raw_save_copy` (FF) | `SaveCopy` | Equivalent | `audacity_project` save under a new path, or fresh backup; no modal SaveCopy menu. |
| `cmd_SaveProject2` (AN3, PIMP) | `SaveProject2` | Equivalent | `audacity_project` save refuses existing destinations before any pipe call. |
| `cmd_Screenshot` (AN3, PIMP); `raw_screenshot` (FF) | `Screenshot` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Scrub` (AN3, PIMP); `raw_scrub` (FF) | `Scrub` | Skipped | Interactive transport mode excluded; use explicit time selection and play/record/stop. |
| `cmd_Seek` (AN3, PIMP); `raw_seek` (FF) | `Seek` | Skipped | Interactive transport mode excluded; use explicit time selection and play/record/stop. |
| `cmd_SelCursorStoredCursor` (AN3, PIMP); `raw_sel_cursor_stored_cursor` (FF) | `SelCursorStoredCursor` | Covered | `audacity_menu`: `SelCursorStoredCursor`; no-argument safe menu. |
| `cmd_SelEnd` (AN3, PIMP); `raw_sel_end` (FF) | `SelEnd` | Covered | `audacity_menu`: `SelCursorToTrackEnd`; no-argument safe menu. |
| `cmd_SelStart` (AN3, PIMP); `raw_sel_start` (FF) | `SelStart` | Covered | `audacity_menu`: `SelTrackStartToCursor`; no-argument safe menu. |
| `cmd_Select` (AN3, PIMP); `raw_select` (FF) | `Select` | Covered | `audacity_command`: `Select`; strict live catalogue parameters. |
| `cmd_SelectAll` (AN3, PIMP) | `SelectAll` | Covered | `audacity_menu`: `SelectAll`; no-argument safe menu. |
| `cmd_SelectNone` (AN3, PIMP) | `SelectNone` | Covered | `audacity_menu`: `SelectNone`; no-argument safe menu. |
| `cmd_SelectTime` (PIMP) | `SelectTime` | Covered | `audacity_command`: `SelectTime`; strict live catalogue parameters. |
| `cmd_SelectTracks` (PIMP) | `SelectTracks` | Covered | `audacity_command`: `SelectTracks`; strict live catalogue parameters. |
| `cmd_SetClip` (AN3, PIMP); `raw_set_clip` (FF) | `SetClip` | Covered | `audacity_command`: `SetClip`; strict live catalogue parameters. |
| `cmd_SetEnvelope` (AN3, PIMP); `raw_set_envelope` (FF) | `SetEnvelope` | Covered | `audacity_command`: `SetEnvelope`; strict live catalogue parameters. |
| `cmd_SetLabel` (AN3, PIMP) | `SetLabel` | Covered | `audacity_command`: `SetLabel`; strict live catalogue parameters. |
| `cmd_SetPreference` (AN3, PIMP); `raw_set_preference` (FF) | `SetPreference` | Equivalent | `audacity_preferences` set: default sample rate or recording channels only. |
| `cmd_SetProject` (AN3, PIMP); `raw_set_project` (FF) | `SetProject` | Covered | `audacity_command`: `SetProject`; strict live catalogue parameters. |
| `cmd_SetTrackAudio` (AN3, PIMP); `raw_set_track_audio` (FF) | `SetTrackAudio` | Covered | `audacity_command`: `SetTrackAudio`; strict live catalogue parameters. |
| `cmd_SetTrackStatus` (AN3, PIMP) | `SetTrackStatus` | Covered | `audacity_command`: `SetTrackStatus`; strict live catalogue parameters. |
| `cmd_ShiftDown` (AN3, PIMP); `raw_shift_down` (FF) | `ShiftDown` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_ShiftUp` (AN3, PIMP); `raw_shift_up` (FF) | `ShiftUp` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_ShowClipping` (AN3, PIMP); `raw_show_clipping` (FF) | `ShowClipping` | Covered | `audacity_menu`: `ShowClipping`; no-argument safe menu. |
| `cmd_ShowExtraMenus` (AN3, PIMP); `raw_show_extra_menus` (FF) | `ShowExtraMenus` | Covered | `audacity_menu`: `ShowExtraMenus`; no-argument safe menu. |
| `cmd_Silence` (AN3, PIMP) | `Silence` | Covered | `audacity_command` / `audacity_effect`: `Silence`; strict live catalogue parameters. |
| `cmd_SlidingStretch` (AN3, PIMP) | `SlidingStretch` | Covered | `audacity_command` / `audacity_effect`: `SlidingStretch`; strict live catalogue parameters. |
| `cmd_SnapToNearest` (AN3, PIMP); `raw_snap_to_nearest` (FF) | `SnapToNearest` | Skipped | Identifier is absent from the pinned safe catalogue; not offered until a dialog-free live 3.7.8 implementation is verified. |
| `cmd_SnapToOff` (AN3, PIMP); `raw_snap_to_off` (FF) | `SnapToOff` | Skipped | Identifier is absent from the pinned safe catalogue; not offered until a dialog-free live 3.7.8 implementation is verified. |
| `cmd_SnapToPrior` (AN3, PIMP); `raw_snap_to_prior` (FF) | `SnapToPrior` | Skipped | Identifier is absent from the pinned safe catalogue; not offered until a dialog-free live 3.7.8 implementation is verified. |
| `cmd_SoundActivation` (AN3, PIMP); `raw_sound_activation` (FF) | `SoundActivation` | Covered | `audacity_menu`: `SoundActivation`; no-argument safe menu. |
| `cmd_SoundActivationLevel` (AN3, PIMP); `raw_sound_activation_level` (FF) | `SoundActivationLevel` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_SplitCut` (AN3, PIMP) | `SplitCut` | Covered | `audacity_menu`: `SplitCut`; no-argument safe menu. |
| `cmd_SplitDelete` (AN3, PIMP) | `SplitDelete` | Covered | `audacity_menu`: `SplitDelete`; no-argument safe menu. |
| `cmd_StereoToMono` (PIMP) | `StereoToMono` | Covered | `audacity_command` / `audacity_effect`: `StereoToMono`; strict live catalogue parameters. |
| `cmd_StoreCursorPosition` (AN3, PIMP); `raw_store_cursor_position` (FF) | `StoreCursorPosition` | Covered | `audacity_menu`: `StoreCursorPosition`; no-argument safe menu. |
| `cmd_TimerRecord` (AN3, PIMP); `raw_timer_record` (FF) | `TimerRecord` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Toggle` (AN3, PIMP); `raw_toggle` (FF) | `Toggle` | Equivalent | Use explicit track/time selection through audacity_select and SelectTime/SelectTracks; focus/window navigation has no headless audio benefit. |
| `cmd_Tone` (AN3, PIMP) | `Tone` | Covered | `audacity_command` / `audacity_effect`: `Tone`; strict live catalogue parameters. |
| `cmd_TrackClose` (AN3, PIMP); `raw_track_close` (FF) | `TrackClose` | Equivalent | `audacity_track_edit` remove with an explicit track. |
| `cmd_TrackGain` (AN3, PIMP); `raw_track_gain` (FF) | `TrackGain` | Equivalent | `audacity_track_set` gainDb; the TrackGain menu is modal. |
| `cmd_TrackGainDec` (AN3, PIMP); `raw_track_gain_dec` (FF) | `TrackGainDec` | Equivalent | Read current volume with audacity_status, convert the linear factor to dB, then write an explicit increment/decrement through audacity_track_set. |
| `cmd_TrackGainInc` (AN3, PIMP); `raw_track_gain_inc` (FF) | `TrackGainInc` | Equivalent | Read current volume with audacity_status, convert the linear factor to dB, then write an explicit increment/decrement through audacity_track_set. |
| `cmd_TrackMoveBottom` (AN3, PIMP); `raw_track_move_bottom` (FF) | `TrackMoveBottom` | Skipped | Historical focus-based reordering ID is absent from the pinned catalogue; no guessed command or UI simulation. |
| `cmd_TrackMoveDown` (AN3, PIMP); `raw_track_move_down` (FF) | `TrackMoveDown` | Skipped | Historical focus-based reordering ID is absent from the pinned catalogue; no guessed command or UI simulation. |
| `cmd_TrackMoveTop` (AN3, PIMP); `raw_track_move_top` (FF) | `TrackMoveTop` | Skipped | Historical focus-based reordering ID is absent from the pinned catalogue; no guessed command or UI simulation. |
| `cmd_TrackMoveUp` (AN3, PIMP); `raw_track_move_up` (FF) | `TrackMoveUp` | Skipped | Historical focus-based reordering ID is absent from the pinned catalogue; no guessed command or UI simulation. |
| `cmd_TrackMute` (AN3, PIMP); `raw_track_mute` (FF) | `TrackMute` | Equivalent | `audacity_track_set` mute. |
| `cmd_TrackPan` (AN3, PIMP); `raw_track_pan` (FF) | `TrackPan` | Equivalent | `audacity_track_set` pan; the TrackPan menu is modal. |
| `cmd_TrackPanLeft` (AN3, PIMP); `raw_track_pan_left` (FF) | `TrackPanLeft` | Equivalent | `audacity_track_set` pan=-1. |
| `cmd_TrackPanRight` (AN3, PIMP); `raw_track_pan_right` (FF) | `TrackPanRight` | Equivalent | `audacity_track_set` pan=1. |
| `cmd_TrackSolo` (AN3, PIMP); `raw_track_solo` (FF) | `TrackSolo` | Equivalent | `audacity_track_set` solo. |
| `cmd_Tremolo` (PIMP) | `Tremolo` | Covered | `audacity_command` / `audacity_effect`: `Tremolo`; strict live catalogue parameters. |
| `cmd_Trim` (AN3, PIMP) | `Trim` | Covered | Raw `audacity_menu` Trim retains native behavior. Prefer `audacity_edit` trim to also remove separate exterior clips on selected tracks without shifting time. |
| `cmd_TruncateSilence` (AN3, PIMP) | `TruncateSilence` | Covered | `audacity_command` / `audacity_effect`: `TruncateSilence`; strict live catalogue parameters. |
| `cmd_TypeToCreateLabel` (AN3, PIMP); `raw_type_to_create_label` (FF) | `TypeToCreateLabel` | Covered | `audacity_menu`: `TypeToCreateLabel`; no-argument safe menu. |
| `cmd_Undo` (AN3, PIMP); `raw_undo` (FF) | `Undo` | Covered | `audacity_menu`: `Undo`; no-argument safe menu. |
| `cmd_UndoHistory` (AN3, PIMP); `raw_undo_history` (FF) | `UndoHistory` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Updates` (AN3, PIMP); `raw_updates` (FF) | `Updates` | Skipped | Opens UI/dialogs, external help, or administrative views; not offered through the pipe. Typed alternatives are listed in the decisions table where applicable. |
| `cmd_Wahwah` (AN3, PIMP) | `Wahwah` | Covered | `audacity_command` / `audacity_effect`: `Wahwah`; strict live catalogue parameters. |
| `cmd_ZeroCross` (AN3, PIMP) | `ZeroCross` | Covered | `audacity_menu`: `ZeroCross`; no-argument safe menu. |
| `cmd_ZoomIn` (AN3, PIMP); `raw_zoom_in` (FF) | `ZoomIn` | Covered | `audacity_menu`: `ZoomIn`; no-argument safe menu. |
| `cmd_ZoomNormal` (AN3, PIMP); `raw_zoom_normal` (FF) | `ZoomNormal` | Covered | `audacity_menu`: `ZoomNormal`; no-argument safe menu. |
| `cmd_ZoomOut` (AN3, PIMP); `raw_zoom_out` (FF) | `ZoomOut` | Covered | `audacity_menu`: `ZoomOut`; no-argument safe menu. |
| `cmd_ZoomSel` (AN3, PIMP); `raw_zoom_sel` (FF) | `ZoomSel` | Covered | `audacity_menu`: `ZoomSel`; no-argument safe menu. |
| `cmd_ZoomToggle` (AN3, PIMP); `raw_zoom_toggle` (FF) | `ZoomToggle` | Covered | `audacity_menu`: `ZoomToggle`; no-argument safe menu. |
| `cmd_generate_and_export` (PIMP) | `generate_and_export` | Equivalent | `audacity_generate` + explicit `audacity_export` + track removal; no SelectAll label-focus bug. |

## Capabilities outside registered tool IDs

| Capability | Source | Status | Coverage or reason |
| --- | --- | --- | --- |
| `audacity://project/current` snapshot resource | BUCK | Equivalent | `audacity_project_info` / `audacity_info` returns the same project snapshot through tools; no second resource cache or subscription claim. |
| `clean_podcast_interview`, `clean_voiceover`, `restore_archival_recording`, `master_for_streaming`, `match_loudness_target` prompts | BUCK | Equivalent | Parameterized pipeline presets, explicit noise-profile scope, measurements/targets and guarded loudness adjustment perform the work. Upstream prompts contain older parameter aliases and unverifiable compliance/rollback assumptions; they are not copied. |
| Genre/intensity variants of music and lo-fi chains | X3, X4, MAX, FF | Equivalent | Explicit threshold/ratio/attack/release/filter/bass/treble parameters customize audited music/lofi presets. No extra tool alias is needed for every genre. |
| Measurement reader/report/target modules | MAX | Covered | Original streaming Node WAV measurement, optional ffmpeg EBU R128, per-channel levels, advisory defects, percentile estimates, deltas and unknown-aware numeric target checking. |
| Background pipeline completion popups | X3, X4, MAX, FF | Skipped | Modal notifications block hidden work. The MCP call returns its verified step report directly. |
| ML/client/plugin bootstrap and automatic runtime downloads | DPF, MAX, X3, X4 | Skipped | Audacity-only runtime stays Node + official MCP SDK + zod; optional ffmpeg/ffprobe are discovered, never installed or downloaded by a tool. |
| Audacity 4 fork bridge/profiles | X4 | Skipped | Ideas inform task selection; fork build/custom C++ bridge and 4.x realtime APIs are outside the pinned 3.7.8 pipe architecture. |
| Platform-specific FIFO discovery/snap namespace scanning | MAX, AN3, PIMP | Partial | Standard user-ID FIFOs and programmatically supplied pipe paths are supported; snap/private process namespace discovery is not verified. Windows hidden-window/dialog lifecycle is the tested first-class host. |
| General file-only DSP CLI and batch JSON stdout | DPF | Equivalent | MCP `audacity_batch` and project-backed processing cover supported audio tasks. A separate CLI/DSP runtime is not included. |

The source counts were obtained from tool decorators and literal generated
action lists, excluding tests and deduplicating overridden names. The inventory
was checked against all nine checkout snapshots, their README files and helper
modules; advertised counts were not assumed to be accurate. Every omitted row
has an explicit host/API, modal-safety, dependency, or scope rationale above.
