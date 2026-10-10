# Effect requirements

Use `audacity_describe` for bundled exact parameter names, enums and limits.
Limits come from the pinned Audacity source (`catalogue/parameters.json`): outside
them a built-in effect or command opens a blocking "Could not load settings"
message and a Nyquist plug-in silently keeps its saved control. Nyquist defaults
shown by Audacity are placeholders (0, empty or the first choice); an omitted
Nyquist control keeps its saved value, so pass every control you rely on.
Use `audacity_effect` to select an explicit track/range; omit times to use its
extent. Save a project backup before applying sample processing.

All retained Nyquist audio effects/analyzers need a positive selection
intersecting audio on every selected audio track. Processing and public
BeatFinder/SampleDataExport require at least one **source** frame; gaps do not
count. Project render rate cannot establish source frames or source Nyquist.

| Effect | Required parameters / context |
| --- | --- |
| High-passFilter / Low-passFilter / NotchFilter | Explicit FREQUENCY ≥0.1 Hz and strictly below each source Nyquist |
| ShelfFilter | Explicit HZ ≥10 Hz and ≤source Nyquist, including GAIN=0 |
| NoiseGate | Explicit MODE=Gate; nonnegative GATE-FREQ in kHz <0.00045×source Hz; ≥100 source frames within track extent |
| StudioFadeOut | ≥3 source frames wholly within track extent |
| CrossfadeClips | Exactly one audio track, one/two nonoverlapping clips, endpoints in audio; ≥2 source frames per participating portion, excluding gaps |
| CrossfadeTracks | At least two selected audio tracks |
| LegacyLimiter | Explicit TYPE; limiting modes need HOLD 1..50 ms and floor(HOLD×sourceHz/3000)≥1; clipping modes skip this averaging window |
| Vocoder | Explicit TRACK-VL, NOISE-VL, RADAR-VL, each 0..100 with one positive; mono supported |
| RhythmTrack | Explicit nonnegative integer BARS; zero requires positive CLICK-TRACK-DUR |
| AdjustableFade | Explicit PRESET; None also needs UNITS/GAIN0/GAIN1. Percent gains 0..1000; dB gain ≤+100 |
| AutoDuck | Selected audio bed only; immediately following track must be unselected audio control. Intervening labels are refused |
| NoiseReduction | `params:{}` and known same-track captured room tone in a fresh process; saved UI settings, no scriptable reduction parameters |
| SampleDataExport | Explicit FILENAME and MESSAGES=None; public source-frame preflight |

NoiseGate Analyze, ClickRemoval, Repair, spectral Nyquist tools, LabelSounds,
MeasureRms, DtmfTones and native RegularIntervalLabels are reserved due to modal
or broken scripted paths. Paulstretch, Echo, equalization, Classic Filters,
TruncateSilence and FindClipping have source-derived guards listed in the
[modal-path classification](safety.md#modal-path-classification).
Amplify rejects `AllowClipping:false`, which native batch processing ignores.

The [safety reference](safety.md) explains noise state, source-rate querying,
saved macros and uncertain outcomes. Exact behavioral source references and
attribution remain in [NOTICE](../NOTICE.md). New controls require live pinned
3.7.8 evidence; saved UI defaults are not a safe substitute for required values.
