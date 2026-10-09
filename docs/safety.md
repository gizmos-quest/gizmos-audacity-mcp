# Safety and native limits

The public surface uses the bundled English Audacity 3.7.8 catalogue. Unknown
commands, nested fields, ignored native parameters and non-finite numbers fail
before mutation. Native error text is retained. New parameters require pinned
live evidence; historical aliases are not assumed.

## Projects and timing

- Save a **new `.aup3` backup** before destructive processing. Existing save
  destinations are refused before pipe I/O; project open requires an empty project.
- `audacity_fresh` preserves tracks at a supplied new `backupTo`, then restarts,
  including empty projects. It resets process-wide effect state. Never use New.
- Quit saves first, requests orderly native closure and waits for actual exit.
  Disposable saves are deleted only after proven exit; failed/uncertain saves
  remain inspectable. Windows uses native messages, never input simulation or
  process termination. Native quit/window/dialog controls are Windows-only.
- Native scripted commands/effects use `kSkipState`: each effect has **no
  individual undo entry**. History tools traverse existing menu/import states.
- Delete/cut/pause shortening can alter sync with video and other tracks.
  Trim removes all exterior audio without shifting retained timeline; SplitDelete
  retains timing. Clip metadata requires a point strictly inside one clip.

## Selection and units

Track references are zero-based indices or unique names. SetTrack,
SetTrackStatus, SetTrackAudio, SetTrackVisuals, SetClip and SetEnvelope act on
selected tracks. Audacity silently ignores their unlisted Track/TrackCount/
Channel/ChannelCount keys; the server rejects them and typed tools select first.

| Control | Input / readback |
| --- | --- |
| Track gain | dB input, linear volume readback; slider range -36..36 dB |
| Public `pan` | -1..1, converted once to native Pan percentage -100..100 |
| Envelope | Linear gain 0..2; 0 silences, 1 unchanged, 2 about +6 dB |
| Clip sample gain | Relative -50..36 dB; changes samples |
| Amplify Ratio | 0.003162..316.227766; `AllowClipping:false` is refused because native batch ignores it |

Effects default to the track extent; selecting silent timeline beyond clips
can create silent clips. Pipeline extents recalculate after timing edits.
Exports select tracks/time explicitly: AddLabel can leave text focus, where
SelectAll selects label text instead of audio. Empty project-info rate is null;
the default-rate preference is not evidence of the current rendered rate.

## Imports, recording and macros

Every Import2 route temporarily sets
`/FileFormats/MusicFileImportSettingChoice=No` and
`/FileFormats/MusicFileImportOnExistingProjectSettingChoice=DoNothing`.
Audacity otherwise can open Music Import prompts or align tempo **after OK**.
Prior supported values are restored; missing values use native defaults Ask and
MatchIfBeatsAndMeasures. Unknown outcomes defer restoration until recovery.
These internal guards do not expand public preference writes.

Recording uses a cursor selection and maps new/append through
`/GUI/PreferNewTrackRecord` (absent default false). Append requires one explicit
audio track matching `/AudioIO/RecordChannels`; untargeted new recording clears
unrelated selection. Mixed source rates/channels can open dialogs. Recording
invalidates known noise state before sending, including uncertain replies.
Transport position is an estimate; manual changes are unknown.

Public preferences write only supported numeric default project rates and
record channels 1/2, with Reload=false and original/readback values. Macros live
beside the config in Macros/. All steps validate before replay; implicit UI
presets, unsafe commands and automatic export destinations are refused. Dry-run
does not prove native context. Source-rate/context preflight conservatively
refuses unprovable effects after selection/topology/generation/timing changes.

AutoDuck's unselected voice control must be the **immediately following audio
track in the complete track list**. An intervening label track is refused.
Use envelope points for editable timing control.

## Noise reduction

Audacity 3.7.8 NoiseReduction has **no automation parameters**. Reduction,
Sensitivity and Smoothing are ignored natively and rejected here. Saved UI
settings govern reduction. The first call captures process-wide profile state;
later calls reduce. A new server attaching to an existing process knows no profile.

Capture one explicit pure room-tone interval per fresh process, wholly within
one clip, with at least **4096 rendered frames and 4096 source frames**.
An identical track/interval reuses the profile; another requires `audacity_fresh`.
Reduction selects only that track with unchanged index/name and source rate.
Process changes, history, topology, imports, recording and recovery invalidate
known state. Manual/out-of-band replacement cannot be fully detected by GetInfo;
use a fresh session after external edits. Cross-track reduction is refused.

GetInfo omits source rates. A controlled, silent SampleDataExport of NUMBER=1,
HEADER=Standard, MESSAGES=None to an explicit scratch file establishes the native
source rate, separately from project render rate. The query restores time,
sparse selection and focus, then removes scratch after confirmed replies.
Uncertain export/restoration retains scratch and stops further restoration.

## Pipelines and batches

Dry-run lists validated static steps before audio/selection changes. Execution
checks source context before earlier edits. Room-tone capture, normalization,
limiting and pause shortening require explicit choices. Failures report the
completed-step count and native text; no automatic replay or rollback is promised.

Batch excludes noiseProfile because temporary tracks cannot safely reuse a
process-wide profile. Pause shortening needs an empty project to avoid sync-lock
moving unrelated tracks; existing solo tracks are refused. All destinations
preflight, completed outputs remain, and confirmed failures clean every appended
temporary track and restore selection/focus. Unknown outcomes preserve temporary
state. A multi-track import remains inspectable before naming/moving is attempted.

## Pipe and dialogs

Whole operations and exchanges serialize. Use **one controlling server**:
independent readers can steal replies from the shared uncorrelated pipe.
Each exchange recreates handles and briefly retries transient opening failures.
A disposable Node helper bounds blocked I/O; its termination completes before
another reader starts. Audacity is never terminated by the server.
Paired endpoint overrides accept only named pipes/absolute FIFOs and reject
ordinary files or POSIX symlinks. Native opens do not create/truncate files.
An ownership lock coordinates this server's entry points; it cannot coordinate
unrelated clients or manual UI edits.

Wire booleans are 1/0; True is read as false. Quotes, newlines and NUL cannot
be safely escaped. Audacity's parameter parser turns `\n` into a newline and
`\\` into one backslash, so text containing those sequences or ending in a
backslash is refused; Windows file paths are sent with forward slashes, keeping
a folder such as `C:\new` intact. GetInfo JSON escapes only quotes; its other
backslashes are literal. Spaced keys are quoted and Nyquist hyphens retained. The
encoded whole-command byte budget protects the native fixed request buffer;
commands are never split/truncated automatically.

A partial write, timeout or lost post-send response leaves the outcome unknown.
Recovery must obtain synchronized readable native state before allowing edits;
it never resends the edit. Dialog/window tools remain available during blocked
pipe work. Recovery clearing requires stopped Audacity, a config backup and
retained project files. Live ActiveProjects entries are legitimate.

| Reserved native behavior | Safe alternative / reason |
| --- | --- |
| Ellipsis menus, lifecycle, unrestricted prefs/programs | Typed tools; prevent dialogs, project/process/config surprises |
| MeasureRms, Contrast, PlotSpectrum | Numeric export-based measurement; native result windows are modal |
| ClickRemoval | Refused: valid no-click audio still opens an error dialog |
| Repair | Hidden pitch/speed/context constraints cannot be established by GetInfo; length alone is insufficient |
| Spectral Nyquist editors | Required spectral UI state is unobservable; initialization can be modal |
| LabelSounds | Silent/no-result cases show a blocking dialog; use silence analysis plus explicit labels |
| RegularIntervalLabels | Trace errors persist debug state; even later valid calls can be modal. Use typed regular labels |
| Opus / AIFF export | Opus opened dialogs; AIFF failed on the pinned host. WAV/FLAC/MP3/OGG are exposed |

Retained analyzers need explicit silent file options and source frames.
[Effect-specific guards](effects.md) and adjacent code comments preserve native
evidence; [NOTICE](../NOTICE.md) links exact source files.

## Measurement

Sample peak, RMS, true peak, LUFS and LRA are distinct. Missing/short/silent
metrics remain unknown; target checks never substitute zero. Quiet-block RMS,
dynamic-range percentiles, clipping counts and discontinuities are advisory,
not noise-floor proof, click diagnosis or restoration of clipped information.

Rendered measurements include gain/pan/mute/solo/envelopes and restore selection;
file measurements read the source. Silence requires every channel below the
threshold, returns capped regions plus the total count, and uses absolute project
times for rendered ranges. Contrast is numeric RMS difference. Mono loudness
defaults to dual-mono compensation.

Analysis streams audio in constant memory under a total timeout budget and a
24-hour duration cap; an ffmpeg-decoded temporary WAV stops at the 4 GiB WAV
limit. LUFS targeting requires established LUFS/true peak, caps gain by
headroom/maxBoost, then measures again; an unreachable target is reported.
Native limiting and house references do not certify delivery peaks.
No neural denoise/transcription/stem runtime is bundled.
