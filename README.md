# Gizmos Audacity MCP

A typed MCP server for live editing and hidden-window audio production in
**Audacity 3.7.8** through `mod-script-pipe`. It uses Node 24+, TypeScript,
the official MCP SDK v2 (`@modelcontextprotocol/server`) and zod. Audacity
performs the editing and processing; no Python or ML runtime is required.

The [feature matrix](docs/feature-matrix.md) inventories all **541 unique tool
IDs** in nine researched servers, with source commits, coverage and reasons
for exclusions. [NOTICE.md](NOTICE.md) records research provenance.

## Setup

Windows is the verified host for hidden-window operation and dialog recovery.
The pipe client also supports standard macOS/Linux user-ID FIFOs; their native
window lifecycle is not part of the Windows live verification.

1. Install and pin the exact verification target, Audacity 3.7.8:

   ```powershell
   winget install --id Audacity.Audacity -e --version 3.7.8
   winget pin add --id Audacity.Audacity --version 3.7.8
   ```

2. In Audacity Preferences > Modules, enable `mod-script-pipe`, then restart.
   Use the English UI so catalogue IDs/menu labels match this checkout.
   Audacity 4.x removed this pipe; the researched custom 4.x fork is unsupported.
3. Install Node 24 or newer, then run `npm ci` and `npm run build`.
4. Register the stdio server with your MCP client:

   ```json
   {
     "mcpServers": {
       "audacity": {
         "command": "node",
         "args": ["EXAMPLE_WORKSPACE/gizmos-audacity-mcp/dist/main.js"]
       }
     }
   }
   ```

Audacity and the server must run as the same Windows user. `AUDACITY_EXE`
overrides executable discovery; `AUDACITY_CONFIG` selects the config the server
inspects. Audacity must itself use that file, for example through Portable
Settings beside its executable; this variable does not redirect Audacity's settings.
Check the executable's actual version before testing: a `3.7.*` gating pin
permits newer patch versions. This host was found running 3.7.9; exact 3.7.8
verification uses the official portable archive with isolated Portable Settings,
without replacing the user's installed application. The live client forwards
explicit `AUDACITY_*` executable/config/ffmpeg overrides to its stdio server.
Launch reports each Windows process's actual executable and file/product
version. Invalid explicit executable overrides fail instead of falling back
to the installed application. The live suite checks the executable and exact
3.7.8 file version before changing any project, and refuses an already-running
application from a different installation.
Keep `mod-cloud-audiocom` and `mod-musehub-ui` disabled on the pinned host:
they appeared in a crash stack and are unrelated to the scripting module.

For optional LUFS/LRA/true-peak measurement and non-WAV decoding, install
ffmpeg and ffprobe and put their executable directory on `PATH`. Alternatively
set `AUDACITY_FFMPEG` and `AUDACITY_FFPROBE` to their full executable paths.
Native PCM/float WAV peak/RMS analysis needs no external executable. The
server never installs packages or downloads audio models itself.

## Tools

The 45 tools group related operations into typed task interfaces. Track
references are zero-based indices or unique names; time values are seconds.
Unknown fields and non-finite numbers are rejected before pipe commands.

| Tool | Purpose and important arguments |
| --- | --- |
| `audacity_launch` | Start or attach; `visible:false` hides the Windows application and waits for a real pipe response. |
| `audacity_fresh` | Obtain one empty project window by orderly restart, even if already empty, resetting process-wide effect state. Projects with tracks require a new `backupTo` path. |
| `audacity_quit` | Save then quit cleanly; optional `saveTo` retains the project. Without it, the disposable saved project is removed after exit. |
| `audacity_window` | `show:true/false` changes window visibility without stopping processing. |
| `audacity_dialogs` | Inspect windows; `close:true` sends WM_CLOSE to blocking dialogs and remains available while a pipe call waits. |
| `audacity_recover` | Inspect process/pipe/config state, optionally `closeDialogs` and reconnect; restores import preferences deferred after uncertain pipe outcomes. Explicit `discardRecovery` backs up stopped-app config before clearing stale entries. |
| `audacity_status` | Check reachability and inspect tracks, extents, volume, pan, mute and solo. |
| `audacity_project_info` | Tracks, clips, selection, length, active project paths and actual rendered sample rate; empty-project rate is null. |
| `audacity_info` | Read Tracks, Clips, Envelopes, Labels, Boxes, Selection, Preferences, Commands or Menus. |
| `audacity_describe` | Discover exact installed command/effect parameter names and enums. |
| `audacity_command` | Run a catalogue command with validated `params`; lifecycle and dangerous commands are reserved. |
| `audacity_menu` | Reviewed no-dialog selection, cursor, zoom, editing, track and label operations. |
| `audacity_select` | Explicit time/track selection; omitted times use the selected track extent. |
| `audacity_import` | Import audio or video sound as one named audio track at `start`, suppressing automatic music-loop prompts and tempo changes. Multi-track imports are reported for inspection before naming or moving. |
| `audacity_export` | Export the rendered mix or time range to WAV/FLAC/MP3/OGG, with explicit selection and mono/stereo `channels`. |
| `audacity_project` | `open` an existing `.aup3` into an empty project, or `save` to a new path; existing save destinations are refused. |
| `audacity_track_set` | Name, `gainDb`, normalized `pan` (-1 left, 0 center, 1 right), mute or solo; track gain is the editable slider. |
| `audacity_track_edit` | Add mono/stereo/label tracks, remove, mix/render, or align explicit tracks/extents. |
| `audacity_clip_move` | Move the clip covering `at` to a new `start`; a shared boundary identifies the clip starting there and leaves its neighbor unchanged. |
| `audacity_clip_set` | Rename/color at a time strictly inside one clip, or apply relative `gainDb` (-50..36 dB) destructively to that clip's samples. |
| `audacity_edit` | Split, split-new, trim, duplicate, delete, cut/copy/paste, silence, join/disjoin. Trim removes all exterior audio on selected tracks without shifting time; `split_delete` retains timing. |
| `audacity_fade` | Sample fade in/out over an explicit track/range. |
| `audacity_envelope_set` | Editable linear gain points from 0 (silence) to 2, with 1 unchanged; `replace:true` clears previous points. |
| `audacity_generate` | Tone, noise, silence, chirp, DTMF or rhythm; create a mono/stereo track or replace a range. |
| `audacity_effect` | Select a track/range and apply one installed effect with exact catalogue parameters and native source-rate/context preflight. |
| `audacity_noise_profile` | Capture pure room tone wholly inside one clip, with at least 4096 rendered and source frames, in a known fresh process; reuse an identical interval. NoiseReduction takes `params:{}` and saved UI settings, on that same audio track alone. |
| `audacity_pipeline` | Reviewed cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi chains; `dryRun:true` lists steps. |
| `audacity_auto_duck` | Duck a bed under the next audio track below it, used as unselected voice control; topology-checked with dry-run. |
| `audacity_transport` | Play a region, pause/resume, stop, record or status. Position is a server clock estimate. Recording needs a configured input; `newTrack:false` requires one explicit audio track matching its recording channels. |
| `audacity_history` | Undo/redo existing native menu/import history states for explicit `steps`. Individual scripted effects do not create their own undo entries. |
| `audacity_preferences` | List/read preferences; set only default project sample rate or recording channels, returning original value/readback. |
| `audacity_macros` | List/replay saved local macros; list/dry-run checks syntax/parameters, apply also checks current effect context. Explicit export paths, no Macro Manager dialog. |
| `audacity_labels_set` | Add point/region markers to a named label track, including out-of-order insertion/multiple tracks. |
| `audacity_labels` | List/find/edit/delete or create regular markers. Delete preserves overlaps by reconstructing the affected track at the bottom. |
| `audacity_labels_file` | TSV/JSON import; TSV/JSON/SRT/VTT/chapters/CUE/Podlove/ffmetadata export, refusing existing outputs. |
| `audacity_label_regions_export` | Export every positive-duration label region from the current mix to numbered WAV/FLAC/MP3 files. |
| `audacity_measure` | Rendered track/range/current-selection measurement via temporary export; restores selection and retains track controls. |
| `audacity_measure_file` | Source/exported file measurement: native WAV plus optional ffmpeg loudness. |
| `audacity_compare_files` | Before/after reports and numeric deltas with the same backend. |
| `audacity_loudness_target` | Measure LUFS/true peak, cap static gain to headroom/`maxBoostDb`, then verify; requires ffmpeg, with dry-run. |
| `audacity_silence` | Find quiet intervals in a file or rendered track/range; thresholds, total/capped results, no audio deletion. |
| `audacity_contrast` | Foreground/background RMS difference without the modal Contrast window. |
| `audacity_probe_file` | Optional ffprobe: container, streams, rate, channels, duration and tags. |
| `audacity_targets` | Numeric house references for video, podcast, broadcast, audiobook and premaster; absent metrics remain unknown. |
| `audacity_batch` | Preflight/process files on temporary Audacity tracks; dry-run, new output paths and optional before/after reports. Batch options exclude `noiseProfile`; pause shortening requires an empty project to protect existing sync-locked tracks. |

The catalogue in `catalogue/` comes from installed English Audacity (`GetInfo`
Commands/Menus); refresh with `npm run catalogue` after preserving the active
project. Historical upstream names and unsupported parameters are rejected.
Use `audacity_describe` before calling an unfamiliar effect.

Native `SetTrack`, `SetTrackStatus`, `SetTrackAudio`, `SetTrackVisuals`, `SetClip`
and `SetEnvelope` act on the current track selection. Audacity accepts but
ignores unlisted `Track`, `TrackCount`, `Channel` and `ChannelCount` keys on
these setters; this server rejects them. Use `audacity_select` before a generic
setter. The task tools select their requested target explicitly.

`audacity_track_set` accepts normalized pan from -1 to 1 and converts it to
Audacity's percentage. Generic native `SetTrack`/`SetTrackAudio` calls use
`Pan` from -100 to 100; reported track pan is normalized.

Audacity 3.7.8 can schedule a Music Import dialog or adjust loop timing after
`Import2` has already returned OK. Every import path temporarily sets
`/FileFormats/MusicFileImportSettingChoice=No` and
`/FileFormats/MusicFileImportOnExistingProjectSettingChoice=DoNothing` to
disable that behavior. The server restores the prior supported choices after
the exchange; missing keys are restored to native defaults `Ask` and
`MatchIfBeatsAndMeasures`. This internal guard also covers generic commands,
macros and batch imports. Public preference writes retain their two-key allowlist.

## Headless production and processing

Hidden Audacity still runs its application, audio engine and scripting module.
Start with `audacity_launch {"visible":false}`; inspect the same session with
`audacity_window {"show":true}`. Use `audacity_fresh` with a unique `backupTo`
if the current session has tracks. Never create a second project with New.

Measure source audio first, then preview `audacity_pipeline`:

```json
{
  "track": "Voice",
  "preset": "voice",
  "dryRun": true,
  "noiseProfile": {"start": 0, "end": 0.4},
  "loudness": "none"
}
```

Inspect the plan, then change `dryRun` to false. Supply `noiseProfile` only
for pure room tone; omission skips noise reduction. The default track extent
is recalculated before each step. Normalization and limiting are explicit
because they can raise quiet material. `shortenPauses` changes timing and video
sync. Pipeline dry-run validates static command parameters without changing
audio/selection; execution also checks the current source rates and context
before processing. Failures include Audacity's error text and the completed-step count.

Audacity 3.7.8 exposes no Noise Reduction effect parameters: accepted wire
keys such as `Reduction`, `Sensitivity` and `Smoothing` are ignored by native
processing. This server rejects them. Noise reduction uses the settings last
saved in Audacity's UI; pipeline `noiseProfile` accepts only `start` and `end`.
The first native call captures a profile and later calls reduce audio. The
effect's process-wide state and preference loading are visible in the official
[3.7.8 implementation](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-builtin-effects/NoiseReductionBase.cpp).

Start a fresh process through `audacity_fresh` before capturing room tone with
`audacity_noise_profile` or a pipeline. Then apply `NoiseReduction` with
`params:{}`. Repeating the same track and interval reuses the known profile;
choosing another requires `audacity_fresh` and a new production backup path.
Attaching a new server to an existing Audacity leaves profile state unknown
until that restart. The capture interval must lie wholly inside one audio clip
and contain at least 4096 rendered frames and 4096 source frames; select a
longer interval of pure room tone if it is refused. An 8 kHz source rendered
at 48 kHz can meet the rendered minimum while containing too few source frames.
`GetInfo` does not report source-track rates, so capture checks the native rate
through a silent one-sample `SampleDataExport` header in a temporary text file.
The same query checks source-rate-dependent effect limits. It restores selection
and track focus and removes scratch after confirmed replies; an uncertain pipe
outcome retains scratch and reports incomplete selection restoration for recovery.
Reduction selects only the captured audio track, with its original index/name.
Track-structure/history changes invalidate known profile state. Cross-track
reduction remains conservatively refused: processing is limited to that same
track with unchanged identity, since native rate mismatches open modal errors.

Batch pipelines exclude `noiseProfile`: consecutive temporary tracks cannot
share a verified source-track profile or capture a new one in the same process.
Use a separate fresh, backed-up session for each track needing native noise reduction.
Batch pause shortening likewise requires an empty project: native sync-lock
can shift unselected tracks during timing changes. Dry-run reports this
requirement. After a confirmed multi-track import or processing failure, batch
removes all appended temporary tracks and restores the original selection/focus.
If an import adds several tracks, the single-track import tool reports their
presence and leaves them available for inspection.

Save a project backup before destructive processing. Individual scripted
effect/command calls follow Audacity's `kSkipState` path and do not create an
undo entry per call; `audacity_history` operates native history entries from
menu edits/imports. The official
[3.7.8 batch command implementation](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/BatchCommands.cpp)
shows this flag. History therefore cannot promise rollback of individual
pipeline, macro or generic effect steps.

Native Click Removal is unavailable because Audacity 3.7.8 opens a blocking
error dialog when it finds no removable clicks. Generic effect calls and macros
refuse `ClickRemoval`; pipeline `removeClicks:true` is rejected during preflight.
Measurement discontinuity counts are advisory and do not replace a de-clicking
processor.
Native Repair is also unavailable: it opens modal errors for selections above
128 samples, missing surrounding context, or clips with pitch/speed changes.
`GetInfo` omits that clip state, so bounding selection length cannot guarantee
dialog-free repair. See the official
[Repair implementation](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-builtin-effects/Repair.cpp).

The four spectral Nyquist effects are unavailable because their required
spectrogram/selection state is absent from `GetInfo`; native initialization can
open a modal before processing. Label Sounds is also unavailable: silent or
below-threshold audio produces a blocking result dialog with no silent mode.
Use numeric silence analysis and explicit labels instead.
Native RegularIntervalLabels is also reserved: trace errors leave debug state
that can open another modal even on a valid `VERBOSE=None` call after recovery.
Use `audacity_labels` with `action:"regular"` for explicit interval markers.

Generic setter validation supplements the catalogue's types with reviewed
native numeric bounds. Envelope gain is linear from 0 to 2: 0 silences, 1 leaves
gain unchanged and 2 adds about 6 dB. Other effect controls use their declared
catalogue types/enums and effect-specific safety checks; `GetInfo` itself omits
numeric bounds.
Native Amplify declares `Ratio` from 0.003162 to 316.227766. Its batch path
ignores `AllowClipping=false`, so the server rejects that value; measure
headroom before choosing gain. Clip sample gain accepts -50..36 dB.

Retained Nyquist processing/analyzers require a positive-duration selection
intersecting an audio clip on every selected audio track; gaps alone are
refused. Processing effects require at least one source frame. Additional
requirements prevent known native failures; explicit controls avoid unknown
saved UI settings:

| Effect | Required parameters and context |
| --- | --- |
| High-passFilter / Low-passFilter / NotchFilter | Explicit `FREQUENCY`, at least 0.1 Hz and strictly below each selected track's source Nyquist frequency. |
| ShelfFilter | Explicit `HZ`, at least 10 Hz and at most the source Nyquist frequency, including when `GAIN=0`. |
| NoiseGate | Explicit `MODE=Gate` and nonnegative `GATE-FREQ` in kHz, strictly below 0.00045 times the source rate in Hz; at least 100 source frames wholly within each selected track's extent. |
| StudioFadeOut | At least 3 source frames wholly within each selected track's extent. |
| CrossfadeClips / CrossfadeTracks | Clips: exactly one selected audio track and one or two non-overlapping clips, with endpoints in audio and at least 2 source frames in each participating portion; gaps do not count. Tracks: at least two selected audio tracks. |
| LegacyLimiter | Explicit `TYPE`; limiting modes also require explicit `HOLD` (1..50 ms) with `floor(HOLD * sourceRate / 3000) >= 1`. This prevents a zero averaging window; clipping modes skip that window. |
| Vocoder | Explicit `TRACK-VL`, `NOISE-VL` and `RADAR-VL`, each 0..100 and at least one positive. Mono input is supported. |
| RhythmTrack | Explicit nonnegative integer `BARS`; zero also requires positive explicit `CLICK-TRACK-DUR`. |
| AdjustableFade | Explicit `PRESET`; `None` also requires `UNITS`, `GAIN0` and `GAIN1`. Percent gains are 0..1000; dB gains must not exceed +100. |

For a video bed, place Music above Voice, then preview
`audacity_auto_duck {"bed":"Music","voice":"Voice","dryRun":true}`.
Voice must be the next audio track below the selected bed. For picture-timed
editable duck points, use `audacity_envelope_set`.

Measurement reports sample peak, RMS, DC, crest, per-channel levels, clipping
sample counts, advisory discontinuities and silence. Quiet-block RMS and
dynamic-range percentiles are estimates; they cannot certify recording noise
floor or definitive click detection. Optional ffmpeg adds integrated EBU R128
LUFS, LRA and true peak. Short/silent audio can lack finite loudness; unavailable
metrics never silently pass a target. Mono defaults to dual-mono compensation
to match Audacity. Rendered measurement includes current gain/pan/mute/solo/
envelopes; file measurement reads the unprocessed source.

For final static gain, preview `audacity_loudness_target` with `targetLufs`,
`truePeakCeilingDbtp` and `maxBoostDb`, then measure the exported mix. It reports
achievable loudness when headroom prevents the requested target. Native
limiting/normalization and numeric house targets do not promise certification.

Saved macros live beside `audacity.cfg` in `Macros/`. List and dry-run check
syntax/parameters, with rejection reasons; they do not prove current audio
context. Apply preflights filters against every existing audio track's source
rate, even when the macro selects fewer tracks. Context-dependent Nyquist steps
after topology/generation/timing changes, and selection-dependent steps after
selection changes, are conservatively refused; use separate typed operations.
Implicit effect presets, modal/lifecycle actions and automatic export
destinations are refused; explicit parameters and `outputTo` make replay
reviewable. Preference writes allow only
`/SamplingRate/DefaultProjectSampleRate` (supported numeric rates) and
`/AudioIO/RecordChannels` (1 or 2), with `Reload=false`.

## Pipe safety and recovery

- Booleans are `1`/`0`; Audacity reads `True` as false. Strings cannot contain
  double quotes, line breaks or NUL: there is no usable pipe escape. Spaced
  parameter keys are quoted and Nyquist parameter hyphens retained.
- Whole operations and pipe exchanges are serialized. Keep one server/client
  in control; two readers can steal replies. Each exchange recreates handles
  and retries opening briefly.
- Effects can wait ten minutes. A disposable Node pipe helper makes timeout
  cancellation bounded; the Audacity application is never killed.
- A timeout or lost post-send reply leaves the edit outcome unknown. Later pipe calls are refused
  until explicit recovery; possible edits are never blindly replayed.
- Recovery keeps the uncertainty flag until a successful, readable Tracks JSON
  response arrives. Failed/partial writes are treated as uncertain; the previous
  disposable helper must exit before the next exchange starts.
- If a temporary measurement or source-rate export has an uncertain outcome,
  its scratch directory is retained and reported. Selection restoration is
  deferred because the native command may still be running; inspect the state
  and retained files after recovery.
- New, raw lifecycle commands, ellipsis menus and known modal actions are
  denied. MeasureRms opens result dialogs here; use export measurement.
  SampleDataExport requires explicit output and `MESSAGES=None`;
  RegularIntervalLabels is reserved, and NoiseGate analysis mode is refused.
  Opus export opens blocking dialogs here and is refused; native
  AIFF export fails on the pinned installation.
- SetTrack volume input is dB; Tracks reports a linear factor. Public track pan
  is [-1,1]; native SetTrack/SetTrackAudio Pan is a percentage. Effects default
  to track extent because selection beyond a clip can create silence clips.
  Export explicitly selects time/tracks: AddLabel leaves text-edit focus, so
  SelectAll could select label text and produce an empty export.
- Saves to an existing `.aup3` are refused before the pipe to prevent modal
  errors. Fresh backs up tracks; quit saves before exit and clears recovery
  entries normally.

After a timeout, inspect `audacity_dialogs`, close the blocking dialog with
`{"close":true}`, then call `audacity_recover`. Inspect the resulting project
before deciding whether the edit completed. If stopped Audacity has stale
`[ActiveProjects]` entries, inspect recovery first. Explicit
`discardRecovery:true` retains a dated config backup and every project file
before clearing entries. Legitimate entries for an open project are distinct
from stale crash-recovery entries.

If an import times out or loses its reply, the server retains the original
import preference values while leaving the safe choices active. Calling
`audacity_recover` with its default `reconnect:true` verifies a real pipe
response, then restores those deferred values. Import edits are never replayed
automatically; inspect tracks to determine what completed.

Whisper transcription, neural denoise/dereverb and stem separation remain
external optional stages. Export audio and import externally produced TSV/JSON
markers; subtitle/chapter export is built in. Modal spectrum/device/metadata
editors and Audacity 4 fork-only APIs have individual exclusions in the matrix.

## Verification and integration

See the [dated verification report](docs/verification.md) for exact test
counts, the real hidden-Audacity run and the integration measurement.

```text
npm run typecheck
npm test
npm run build
npm run test:live
npm audit --audit-level=high
```

`test:live` sets `AUDACITY_LIVE=1` portably and drives the real stdio MCP
server against hidden Audacity. It exercises every registered tool and
recovery paths with temporary projects/audio, then quits cleanly. Preserve an
existing production project first using `audacity_fresh` and a unique backup;
retain that backup until the original is restored and checked. GitHub Actions
runs typecheck/unit tests on Ubuntu/Node 24; Audacity is not installed there.

The existing tool names/argument shapes used by
`../example-consumer/tools/short.py` remain compatible. From that repo:

```text
python tools/short.py audacity example-project --hidden
```

It must produce audible `productions/example-project/media/mix-audacity.wav`.
After verification, quit test sessions orderly and check no stale recovery
entries or open dialogs. Reopen
`productions/example-project/media/example-project.aup3` in a visible Audacity;
leave the user's original files and preservation backups intact.
