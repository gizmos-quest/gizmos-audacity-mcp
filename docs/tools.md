# Tool reference

All 45 names start with `audacity_`. Times are seconds; tracks are zero-based
indices or unique names. Root/nested unknown fields and non-finite numbers are
rejected. Optional arguments retain their documented defaults. MCP `tools/list`
is the authoritative machine-readable input/output schema.

## Session and discovery

| Tool | Arguments / behavior |
| --- | --- |
| `audacity_launch` | `visible` defaults true; start or attach after a real pipe response |
| `audacity_fresh` | `visible`, optional `backupTo`; unique backup required for tracks; restart even empty projects |
| `audacity_quit` | Optional `saveTo`; save before orderly quit; no save path means disposable project |
| `audacity_window` | `show:true/false`; native Windows visibility |
| `audacity_dialogs` | `close` defaults false; inspect windows or WM_CLOSE blocking dialogs |
| `audacity_recover` | `closeDialogs`, `reconnect` (true), `discardRecovery`, `visible`; explicit recovery, no edit replay |
| `audacity_status` | No arguments; reachability and track properties |
| `audacity_project_info` | No arguments; tracks/clips/selection/length/active files and measured render rate |
| `audacity_info` | `type`: Tracks, Clips, Envelopes, Labels, Boxes, Selection, Preferences, Commands, Menus |
| `audacity_describe` | `command`; bundled exact parameter names/enums and reviewed numeric bounds |

## Editing and mixing

| Tool | Arguments / behavior |
| --- | --- |
| `audacity_select` | Optional `track`, `trackCount`, `start`, `end`; explicit selection, default target extent |
| `audacity_import` | `file`, optional `name`, `start` (0); guarded audio/video sound import |
| `audacity_export` | `file`, `channels` (2), optional start/end; whole rendered mix to WAV/FLAC/MP3/OGG |
| `audacity_project` | `action:open/save`, `file`; empty-project open, new `.aup3` save only |
| `audacity_track_set` | `track`; name/gainDb/pan/mute/solo. Gain dB, pan -1..1 |
| `audacity_track_edit` | `action`: add/remove/mix/alignment; explicit track/count/time, optional new name |
| `audacity_clip_move` | `track`, `at`, new `start`; shared boundary picks the clip starting there |
| `audacity_clip_set` | `track`, interior `at`, name/color/gainDb; relative sample gain -50..36 dB |
| `audacity_edit` | `action`: split/split_new/trim/duplicate/delete/split_delete/cut/split_cut/copy/paste/silence/join/disjoin; scope |
| `audacity_fade` | `track`, `direction:in/out`, optional start/end; sample fade |
| `audacity_envelope_set` | `track`, `points:[{time,value}]`, `replace` (true); editable linear gain 0..2 |

Native Set* setters require prior explicit selection and reject ignored track/
channel scope keys. Trim removes all exterior audio without timeline shift;
delete can close gaps. Export explicitly clears label-edit focus through selection.

## Processing

| Tool | Arguments / behavior |
| --- | --- |
| `audacity_generate` | `kind:tone/noise/silence/chirp/dtmf/rhythm`; duration/start, optional existing track or new mono/stereo track |
| `audacity_effect` | `effect`, `params:{}`, optional track/count/time; exact bundled catalogue and native context preflight |
| `audacity_noise_profile` | `track`, start/end; one pure room-tone interval in a known fresh process |
| `audacity_pipeline` | `track`, preset/options, `dryRun`; cleanup/voice/podcast/interview/audiobook/vocal/live/music/lofi |
| `audacity_auto_duck` | `bed`, `voice`, fade/threshold/duck controls and dryRun; voice immediately follows bed |
| `audacity_command` | `command`, `params:{}`; safe catalogue command on current selection |
| `audacity_menu` | `command`; reviewed no-dialog native menu command |
| `audacity_macros` | `action:list/apply`, name, dryRun/outputTo; saved local macros, fully preflighted |
| `audacity_batch` | `jobs:[{file,output,options}]`, dryRun/measure/channels; temporary-track pipelines, stops at first failure |

Pipeline normalization/limiting and room-tone capture are explicit. NoiseReduction
uses `params:{}` and saved UI settings. A fresh process and same captured track
are required; batch excludes profiling. See [effect requirements](effects.md).

```json
{"track":"Voice","preset":"voice","dryRun":true,"loudness":"none"}
```

## Labels

| Tool | Arguments / behavior |
| --- | --- |
| `audacity_labels_set` | labels start/end/text, `trackName` (Labels); safe insertion across label tracks |
| `audacity_labels` | `action:list/find/edit/delete/regular`; flat index/text/time/interval fields as appropriate |
| `audacity_labels_file` | `action:import/export`, file/format/trackName; TSV/JSON import; eight output formats |
| `audacity_label_regions_export` | directory/trackName/format/channels; numbered audio files for positive-duration mix regions |

Formats: TSV, JSON, SRT, VTT, timestamp chapters, CUE, Podlove and ffmetadata.
Point subtitle ends use the next marker or project end. Label deletion rebuilds
only its track at the bottom, preserving overlaps; indices then reflect new order.
File/region outputs refuse existing destinations.

## Measurement and controls

| Tool | Arguments / behavior |
| --- | --- |
| `audacity_measure` | Track/range or currentSelection, backend/dualMono/timeoutMs/targets; rendered measurement, restores selection |
| `audacity_measure_file` | file, backend/dualMono/timeoutMs/targets; source/exported file |
| `audacity_compare_files` | before/after, same backend/options; established numeric deltas |
| `audacity_loudness_target` | track/time, targetLufs/truePeakCeilingDbtp/maxBoostDb/toleranceLu/dryRun; capped static gain and verification |
| `audacity_silence` | File or rendered scope, thresholdDb/minimumSeconds/maxRegions; advisory quiet intervals |
| `audacity_contrast` | Foreground/background track/start/end, minimumDb; numeric RMS difference |
| `audacity_probe_file` | file/timeoutMs; optional ffprobe container/stream metadata |
| `audacity_targets` | No arguments; house references, unknown-aware checks, no certification |
| `audacity_transport` | action play/pause/resume/stop/record/status, appropriate scope/duration/newTrack; estimated position |
| `audacity_history` | action undo/redo, steps (1); existing native history only |
| `audacity_preferences` | action list/get/set, name/value; writes only default sample rate or recording channels |

Measurement reports distinguish sample peak/RMS from optional LUFS/LRA/true peak.
Unavailable metrics are null with reasons. Object reports expose the same object
as JSON text and structured content; legacy arrays and strings remain text-only.
Pipelines and batches report completed-stage progress when the client supplies
a progress token. Tools' annotations conservatively describe mixed-action tools.
