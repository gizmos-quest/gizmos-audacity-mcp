# Capabilities and limits

The bundled catalogue and safeguards target **English Audacity 3.7.8**, the
reference build; 3.7.9 is verified.
Tool count is not a claim that every native menu or plugin is safe to automate.
See [tools](tools.md), [native safety](safety.md) and [testing](testing.md).

| Domain | Available | Limits |
| --- | --- | --- |
| Session | Start/attach, backup-before-fresh, save/quit, inspect/recover | One shared pipe; hidden app still has UI/audio engine. Native window/dialog/quit handling is Windows-only |
| Discovery | Status, project/clip/label/envelope/selection info; exact bundled command descriptions | GetInfo omits source rates and some clip state; arbitrary plugin catalogs are not auto-enabled |
| Editing | Track/clip properties, split/trim/cut/copy, alignment, sample fades, editable envelopes | Explicit targets; timing edits affect sync; individual scripted effects add no undo state |
| Processing | Reviewed native effects, generation, pipeline dry-run, ducking, saved macro preflight | Modal commands reserved; AutoDuck changes bed samples and needs physically adjacent audio control; envelopes provide editable automation; no unconstrained Nyquist |
| Noise reduction | Explicit same-track room-tone capture/reduction | One interval per fresh process; saved UI settings; ≥4096 source and rendered frames; manual replacement cannot be fully detected |
| Import/export | Guarded audio/video sound import; WAV/FLAC/MP3/OGG mix/range export | Music Import prompts/tempo alignment suppressed; multi-track import remains inspectable; Opus/AIFF unsupported |
| Labels | Safe point/region/regular markers, search/edit/delete, eight sidecar formats, region audio export | Naming dialogs must be disabled; delete rebuilds its label track at bottom; point subtitle ends inferred; new file destinations |
| Measurement | Native WAV peak/RMS/DC/crest/clipping/silence; rendered/source comparison | Estimates advisory; 24 h duration cap and timeout budget; decoded WAV up to 4 GiB |
| Loudness/metadata | Optional ffmpeg LUFS/LRA/true peak/decode, ffprobe metadata, headroom-capped gain | External executables installed by user; missing metrics unknown; no delivery certification |
| Batch | Preflighted temporary-track pipelines, reports, retained completed outputs | No noiseProfile; pause shortening requires empty project; existing solo refused; uncertain state retained |
| Transport/history/preferences | Guarded record/play/stop, native history, two writable preferences | Input device needed; position estimate; append one channel-matched track; no per-effect rollback |
| External stages | Export/import audio and TSV/JSON labels | No bundled transcription, neural denoise, dereverb, separation or ML runtime; Audacity 4 unsupported (no scripting interface) |

Known modal exclusions include MeasureRms, Contrast, PlotSpectrum, ClickRemoval,
Repair, spectral Nyquist tools, LabelSounds, native RegularIntervalLabels,
DtmfTones, Paste, ZeroCross and RescanDevices.
Their specific evidence and safe alternatives remain in [safety](safety.md).
Research provenance, source commits and retained notices are in
[NOTICE](../NOTICE.md), separately from current capability claims.
