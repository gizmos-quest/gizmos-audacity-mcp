# Notice

The TypeScript implementation in this repository is original. No Python/C++/Nyquist
source code or upstream tool descriptions were copied or translated into the
runtime. Pinned research source commits are retained below.
The researched behaviour and workflows were independently implemented with
this host's live Audacity 3.7.x catalogue and independently verified Audacity
3.7.8 behaviour and tests.

## Research provenance

The pinned source snapshots below record the exact inspected commits.
Licence links below apply to those upstream projects; this
server remains MIT licensed. No additional upstream runtime is bundled.

| Source | Upstream licence | Research used here |
| --- | --- | --- |
| [xDarkzx/Audacity-MCP](https://github.com/xDarkzx/Audacity-MCP) | [Apache-2.0](https://github.com/xDarkzx/Audacity-MCP/blob/ef7612eb6766ee96d630783d64c1ce94d602dc9e/LICENSE), Copyright 2026 Daniel Hodgetts | Catalogue/task coverage, two-stage noise reduction, cleanup/mastering/label workflow ideas. |
| [xDarkzx/Audacity4-MCP](https://github.com/xDarkzx/Audacity4-MCP) | [Apache-2.0](https://github.com/xDarkzx/Audacity4-MCP/blob/280c7a3f46c19c8686c53a37f788264630aa4b8c/LICENSE), Copyright 2026 Daniel Hodgetts | Editing and realtime-effect feature ideas; none of its code or API is used. |
| [robworks-code/audacity-mcp-max](https://github.com/robworks-code/audacity-mcp-max) | [Apache-2.0](https://github.com/robworks-code/audacity-mcp-max/blob/a1fd6af1d068f7f81f976265e452722742304d50/LICENSE), Copyright 2026 Daniel Hodgetts | Measurement/report/target semantics: unavailable metrics remain unknown, sample peak differs from true peak, quiet-block estimates are not room tone; guarded loudness targeting. |
| [FFriends/MCP-Audacity](https://github.com/FFriends/MCP-Audacity) | [Apache-2.0](https://github.com/FFriends/MCP-Audacity/blob/3f53cdaa37a2339d4c5af6311f7e9f9311a486a8/LICENSE), Copyright 2026 Daniel Hodgetts | Pipe response/error/timeout notes, label-index hazards, modal action exclusions and interview/label workflow ideas. Its third-party notice is preserved below. |
| [Dream-Pixels-Forge/audacity-mcp](https://github.com/Dream-Pixels-Forge/audacity-mcp) | [MIT](https://github.com/Dream-Pixels-Forge/audacity-mcp/blob/9d812922e46f504f91cca48338ed68511f8d4243/LICENSE), Copyright 2026 DREAM-PIXELS-FORGE | Analysis/probe/compare/batch/silence and project-backed workflow ideas; its Python DSP/ML runtime is excluded. |
| [An-3/an3-audacity-mcp](https://github.com/An-3/an3-audacity-mcp) | [MIT](https://github.com/An-3/an3-audacity-mcp/blob/5f9705936cb07551214c8cd9aa07f5cb1f7d9531/LICENSE), Copyright 2026 Andrii Boboshko | Historical command coverage audit; our runtime catalogue comes from Audacity, not its static command descriptions. |
| [PiMPStudios/mcp-audacity](https://github.com/PiMPStudios/mcp-audacity) | [MIT](https://github.com/PiMPStudios/mcp-audacity/blob/64a4de11274c594235170abd6f6e47960895a59d/LICENSE), Copyright 2026 Andrii Boboshko | Parameterized generator, macro, preference and command coverage ideas. |
| [buckydurddle/audacity-mcp](https://github.com/buckydurddle/audacity-mcp) | [MIT](https://github.com/buckydurddle/audacity-mcp/blob/bf2b08196406629cddae0c9c5799a4e9f396442e/LICENSE), Copyright 2026 Andrew Mercer | Compact discovery/dispatch, selection analysis and backup-first workflow ideas; approximate Undo-count checkpoints are not taken. |
| [tachyonshuggy/audacity-mcp](https://github.com/tachyonshuggy/audacity-mcp) | [MIT](https://github.com/tachyonshuggy/audacity-mcp/blob/cd2f38783a76a9ef10aa0be2bf3518d3c04e0888/LICENSE), Copyright 2026 Jeff Shoemaker | Selection/export/label/transport and saved-macro coverage. |

Research is reflected in original `src/tasks/` (plans/editing/generation),
`src/analysis/` (measurement/silence/loudness), `src/labels.ts` and
`src/audacity/labels.ts` (label workflows), `src/controls/` (macros/preferences/transport),
`src/batch.ts`, `src/source-rate.ts` (native sample-rate header queries),
`src/effects/` (Nyquist parameter/source-rate/context preflight), and
pipe/catalogue recovery safeguards. Actual wire parameter
names are the local catalogue's, with comments for independently live-verified
safeguards. Any future copied or adapted source code must identify its exact
source file/commit and licence here, retain applicable copyright/licence text,
and preserve all applicable Apache NOTICE attribution.

### Inspected source snapshots

| Project | Commit |
| --- | --- |
| xDarkzx/Audacity-MCP | `ef7612eb6766ee96d630783d64c1ce94d602dc9e` |
| xDarkzx/Audacity4-MCP | `280c7a3f46c19c8686c53a37f788264630aa4b8c` |
| robworks-code/audacity-mcp-max | `a1fd6af1d068f7f81f976265e452722742304d50` |
| FFriends/MCP-Audacity | `3f53cdaa37a2339d4c5af6311f7e9f9311a486a8` |
| Dream-Pixels-Forge/audacity-mcp | `9d812922e46f504f91cca48338ed68511f8d4243` |
| An-3/an3-audacity-mcp | `5f9705936cb07551214c8cd9aa07f5cb1f7d9531` |
| PiMPStudios/mcp-audacity | `64a4de11274c594235170abd6f6e47960895a59d` |
| buckydurddle/audacity-mcp | `bf2b08196406629cddae0c9c5799a4e9f396442e` |
| tachyonshuggy/audacity-mcp | `cd2f38783a76a9ef10aa0be2bf3518d3c04e0888` |

## Community document attribution

`CODE_OF_CONDUCT.md` adapts the English Contributor Covenant 3.0 from
[`content/version/3/0/code_of_conduct.md`](https://github.com/ContributorCovenant/contributor_covenant/blob/7255a28d23d5bc296de2e4e4e9bb5ee1126f1345/content/version/3/0/code_of_conduct.md),
commit `7255a28d23d5bc296de2e4e4e9bb5ee1126f1345`, licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The reporting
placeholder is replaced with the organization's enforcement contact and the
template editing note is removed. That document retains its upstream attribution
and license; the server implementation remains MIT licensed.

## Audacity implementation references

Official Audacity 3.7.8 source was inspected alongside live testing to verify
effect state, undo behavior, modal failures and asynchronous music imports:

- [NoiseReductionBase.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-builtin-effects/NoiseReductionBase.cpp): process-wide profiling, saved settings and native modal paths.
- [sample-data-export.ny](https://github.com/audacity/audacity/blob/Audacity-3.7.8/plug-ins/sample-data-export.ny) and [NyquistBase.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-nyquist-effects/NyquistBase.cpp): silent explicit-file sample export and its header's source-track sample rate, distinct from project-rate rendering. The one-sample query was independently verified with 8 kHz and 48 kHz tracks.
- [ClickRemovalBase.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-builtin-effects/ClickRemovalBase.cpp): the no-change modal error.
- [Repair.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-builtin-effects/Repair.cpp) and [GetInfoCommand.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/commands/GetInfoCommand.cpp): modal selection/context/pitch-speed failures and the missing clip state that prevents reliable dialog-free repair preflight.
- [BatchCommands.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/BatchCommands.cpp): individual scripted effect/command calls skip adding their own undo state.
- [AmplifyBase.h](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-builtin-effects/AmplifyBase.h) and [AmplifyBase.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-builtin-effects/AmplifyBase.cpp): declared ratio bounds and batch processing that forces clipping permission. Ignored AllowClipping=false behavior was independently verified live.
- [SetTrackInfoCommand.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/commands/SetTrackInfoCommand.cpp), [SetClipCommand.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/commands/SetClipCommand.cpp) and [SetEnvelopeCommand.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/commands/SetEnvelopeCommand.cpp): setters visit selected tracks, define native numeric bounds including linear envelope gain 0..2, and do not define the silently ignored track/channel scope keys.
- [ProjectAudioManager.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/ProjectAudioManager.cpp) and [TransportUtilities.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/TransportUtilities.cpp): channel/rate mismatch dialogs, preference-dependent recording mode and cursor selection for asynchronous recording.
- [ImportExportPrefs.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/prefs/ImportExportPrefs.cpp): music-import preference names, choices and defaults.
- [NyquistBase.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-nyquist-effects/NyquistBase.cpp) and the pinned release's [plug-ins](https://github.com/audacity/audacity/tree/Audacity-3.7.8/plug-ins): spectral initialization, nonempty result-string dialogs and persistent traced debug state. Original guards check source-rate/frame limits, audio clip intersections, crossfade portions, carrier levels, rhythm duration and fade gain units. Spectral editing, LabelSounds and RegularIntervalLabels are reserved; typed regular markers provide the latter's safe alternative. These are behavioral research references; no Lisp/C++ implementation is copied or adapted.
- [legacy-limiter.ny](https://github.com/audacity/audacity/blob/Audacity-3.7.8/plug-ins/legacy-limiter.ny) and [avg.c](https://github.com/audacity/audacity/blob/Audacity-3.7.8/lib-src/libnyquist/nyquist/nyqsrc/avg.c): low source rates can produce a zero averaging step. The server rejects that window from source evidence without provoking the native division-by-zero path.
- [ProjectFileManager.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/ProjectFileManager.cpp) and [MusicInformationRetrieval.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-music-information-retrieval/MusicInformationRetrieval.cpp): tempo-detection routing, deferred analysis and synchronization behavior.
- The [modal-path classification](docs/safety.md#modal-path-classification) cites file and line at tag `Audacity-3.7.8` for each guard and reservation from the source audit of batch dispatch, menu handlers and built-in effect checks; the guards are original code.
- `catalogue/parameters.json` records parameter facts (keys, types, defaults, limits, choices and source file paths) read by the original `scripts/source-*.ts` from the effect, command and plug-in declarations of tag `Audacity-3.7.8`, commit `6120ce413cf8abd4cca7f9470915f0ff0a0d2ded`. It contains no Audacity code.

Audacity's source is GPL licensed. It was used for behavioral research only;
no C++ or Nyquist implementation was copied, translated, adapted or bundled in this MIT
server. The TypeScript safeguards compose public catalogue commands and
independently verified preference values.

Audacity is a trademark of Muse Group; this project is not affiliated with it.

## Preserved notice from FFriends/MCP-Audacity

The following is the complete upstream `THIRD_PARTY_NOTICES.md` at the recorded
commit, retained as research-source attribution. It describes that upstream
project's derivation, not copied runtime code in this server.

# Third-party notices

## xDarkzx/Audacity-MCP

Source: https://github.com/xDarkzx/Audacity-MCP

Core implementation and test suite derived from this Apache-2.0 project.
Original author: Daniel Hodgetts.

## An-3/an3-audacity-mcp

Source: https://github.com/An-3/an3-audacity-mcp

Static Audacity command inventory and related descriptions derived from this
MIT-licensed project.

```text
MIT License

Copyright (c) 2026 Andrii Boboshko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
