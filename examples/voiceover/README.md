# Synthetic voice-over with a music bed

Build a 12-second example through an agent or run the same workflow over the real
built MCP server. The original deterministic synthesis in `generate.mjs` creates
mono voice-like harmonic pulses and a quiet stereo tonal bed at 48 kHz. The voice
has deliberate DC offset and rumble so cleanup has measurable work to do. These
are sounds, not spoken words; subtitle text is an authored demonstration, not a
transcript. No recordings, models or audio binaries are bundled.

From the repository root:

```sh
npm ci
npm run build
node examples/voiceover/generate.mjs .work/voiceover-source
```

The generator refuses existing audio files. Use a new directory for another run.
Give the agent absolute paths to the generated `bed.wav` and `voice.wav`, and a
new output directory. Below, `OUT` means that directory; replace placeholder paths
with real absolute paths. The server sends Windows paths with forward slashes.

## Prompts and resulting calls

> Check Audacity. Start it hidden if stopped, confirm the supported version and
> an empty project, and set its render rate to 48 kHz. Import Bed first and Voice
> immediately below it. Measure Voice and show a voice cleanup dry run without
> normalization, noise reduction or timing changes. Ask before applying it.

| Tool | Arguments / expected result |
| --- | --- |
| `audacity_status` | `{}`; if stopped, call `audacity_launch {"visible":false}` |
| `audacity_launch` | Confirm actual executable/version in `processes`; example runner requires exact 3.7.8 |
| `audacity_command` | `{"command":"SetProject","params":{"Rate":48000,"Name":"Synthetic voice-over"}}` |
| `audacity_import` | `{"file":"…/bed.wav","name":"Bed"}`, then `{"file":"…/voice.wav","name":"Voice"}` |
| `audacity_measure` | `{"track":"Voice","backend":"ffmpeg"}`; 12 seconds, nonzero RMS and deliberate DC offset |
| `audacity_pipeline` | Cleanup arguments below plus `"dryRun":true`; exact ordered plan, selection unchanged |

```json
{
  "track": "Voice", "preset": "voice", "removeDc": true,
  "highPassHz": 80, "compress": true, "thresholdDb": -18,
  "ratio": 3, "attackMs": 10, "releaseMs": 150, "loudness": "none"
}
```

The plan removes DC without level normalization, filters rumble and compresses
without makeup gain. It skips noise reduction because no real room-tone capture
was supplied. Source rate and project render rate are separate; setting Rate
makes the exported fixture 48 kHz rather than relying on a saved preference.

> Apply that reviewed plan after saving `OUT/before-cleanup.aup3`. Measure again.
> Add chapters at 0, 4 and 7 seconds, and Script regions at 1–3, 4–6 and 7–10.
> Preview a 12 dB bed duck, then save a backup and apply it.

Call `audacity_project {"action":"save","file":"OUT/before-cleanup.aup3"}`,
then the same pipeline arguments with `dryRun:false`. Measure Voice again: DC
should fall close to zero while duration remains 12 seconds. Scripted effects
have no individual undo entry; keep each saved backup.

Use `audacity_labels_set` with `trackName:"Chapters"` and point labels
`[{"start":0,"text":"Opening bed"},{"start":4,"text":"Demonstration"},
{"start":7,"text":"Closing cue"}]`. Add Script regions with explicit `end`
and text such as `[Synthetic cue 1; example text]`. Calls append labels, so
repeating them adds duplicates. Disable Audacity's label naming dialog first
(Preferences → Tracks → Track Behaviors); the server refuses that modal path.

```json
{
  "bed": "Bed", "voice": "Voice", "duckDb": -12, "thresholdDb": -30,
  "fadeDown": 0.15, "fadeUp": 0.25, "innerFadeDown": 0,
  "innerFadeUp": 0, "maximumPause": 0.2, "dryRun": true
}
```

Call `audacity_auto_duck` with this preview, save `OUT/before-duck.aup3`, then
apply with `dryRun:false`. Measure Bed before/after; its RMS should decrease.
Auto Duck changes bed samples and requires the unselected Voice immediately
below Bed. For an existing project with another order, editable
`audacity_envelope_set` automation avoids rebuilding the track order.

> Keep the sources and render a new Delivery mix. Target −16 LUFS with true peak
> at or below −1 dBTP: show the gain plan, save a backup, then apply. Export a
> stereo WAV, chapters, labels and subtitles, and check the actual WAV.

Call `audacity_track_edit {"action":"mix_new","track":"Bed","trackCount":2,
"start":0,"end":12}`. Find the new wave track in returned `tracks` and rename
it Delivery with `audacity_track_set`; it can appear before label tracks. Mute
Bed and Voice explicitly. Originals plus their rendered mix otherwise double
the audio (about +6 dB). The sources remain available for later revisions.

Call `audacity_loudness_target` with `track:"Delivery"`, `targetLufs:-16`,
`truePeakCeilingDbtp:-1`, `maxBoostDb:24`, `toleranceLu:0.5`, `dryRun:true`.
Review `before` and `plan.achievable`; if false, stop and review dynamics.
Save `OUT/before-loudness.aup3`, then apply the same call with `dryRun:false`.
This applies static gain; it does not add a limiter or certify delivery.

| Tool | Arguments |
| --- | --- |
| `audacity_export` | `{"file":"OUT/delivery.wav","channels":2,"start":0,"end":12}` |
| `audacity_labels_file` | `action:"export"`, `trackName:"Chapters"`, `format:"chapters"`, file `OUT/chapters.txt` |
| `audacity_labels_file` | `action:"export"`, `trackName:"Script"`, format `tsv`/`srt`, files `OUT/labels.tsv`/`OUT/subtitles.srt` |
| `audacity_measure_file` | `file:"OUT/delivery.wav"`, `backend:"ffmpeg"`, targets below |
| `audacity_quit` | `{"saveTo":"OUT/result.aup3"}`; then inspect `audacity_recover {"reconnect":false}` |

```json
{"integratedLufs":{"min":-16.5,"max":-15.5},"truePeakDbtp":{"max":-1}}
```

With targets supplied, measurement tools return `{measurement,targetCheck}`;
read metrics from `measurement`. Expect `targetCheck.status:"met"`, zero clipped
samples, 12 seconds, 48 kHz and two channels. Exact DSP numbers can vary slightly.
Peak, RMS, true peak and LUFS are distinct. For a video house target, use
`audacity_targets` and review a −14 LUFS plan on Delivery separately.

## Automated live run

Quit Audacity and close other MCP controllers first; one session owns the pipe.
Enable its English scripting pipe. Install ffmpeg and
ffprobe yourself; the runner never installs anything. Then opt in explicitly:

```sh
npm run example:voiceover -- --live
# Optional new destination:
npm run example:voiceover -- --live .work/my-voiceover-run
```

The Windows runner verifies exact Audacity 3.7.8, refuses a running app/recovery
entries, and starts a fresh SDK stdio client at `dist/main.js`. It performs the
reviewed applies authorized by `--live`, retains backups, sources, project,
sidecars and `workflow.json` with call results/timings in a new ignored directory,
and verifies no process, dialogs or ActiveProjects remain. It is never hosted CI.

On failure, inspect `workflow.json` and retained files. The runner attempts saved
orderly closure of only its own process. If synchronization or closure fails,
Audacity remains inspectable; use dialogs/recover/status before choosing the next
action. Never replay an uncertain effect. See [testing](../../docs/testing.md)
and [safety](../../docs/safety.md).
