# Notice

The TypeScript implementation in this repository is original. No Python/C++
source code or upstream tool descriptions were copied or translated into the
runtime. Source tool identifiers in the feature matrix are retained for audit.
The researched behaviour and workflows were independently implemented with
this host's live Audacity 3.7.8 catalogue and tests.

## Research provenance

The [feature matrix](docs/feature-matrix.md) records the exact inspected commit
for each source. Licence links below apply to those upstream projects; this
server remains MIT licensed. No additional upstream runtime is bundled.

| Source | Upstream licence | Research used here |
| --- | --- | --- |
| [xDarkzx/Audacity-MCP](https://github.com/xDarkzx/Audacity-MCP) | [Apache-2.0](https://github.com/xDarkzx/Audacity-MCP/blob/ef7612eb6766ee96d630783d64c1ce94d602dc9e/LICENSE), Copyright 2026 Daniel Hodgetts | Catalogue/task coverage, two-stage noise reduction, cleanup/mastering/label workflow ideas. |
| [xDarkzx/Audacity4-MCP](https://github.com/xDarkzx/Audacity4-MCP) | [Apache-2.0](https://github.com/xDarkzx/Audacity4-MCP/blob/280c7a3f46c19c8686c53a37f788264630aa4b8c/LICENSE), Copyright 2026 Daniel Hodgetts | Editing and realtime/fork feature ideas; its bridge/API/code is not bundled. |
| [robworks-code/audacity-mcp-max](https://github.com/robworks-code/audacity-mcp-max) | [Apache-2.0](https://github.com/robworks-code/audacity-mcp-max/blob/a1fd6af1d068f7f81f976265e452722742304d50/LICENSE), Copyright 2026 Daniel Hodgetts | Measurement/report/target semantics: unavailable metrics remain unknown, sample peak differs from true peak, quiet-block estimates are not room tone; guarded loudness targeting. |
| [FFriends/MCP-Audacity](https://github.com/FFriends/MCP-Audacity) | [Apache-2.0](https://github.com/FFriends/MCP-Audacity/blob/3f53cdaa37a2339d4c5af6311f7e9f9311a486a8/LICENSE), Copyright 2026 Daniel Hodgetts | Pipe response/error/timeout notes, label-index hazards, modal action exclusions and interview/label workflow ideas. Its third-party notice is preserved below. |
| [Dream-Pixels-Forge/audacity-mcp](https://github.com/Dream-Pixels-Forge/audacity-mcp) | [MIT](https://github.com/Dream-Pixels-Forge/audacity-mcp/blob/9d812922e46f504f91cca48338ed68511f8d4243/LICENSE), Copyright 2026 DREAM-PIXELS-FORGE | Analysis/probe/compare/batch/silence and project-backed workflow ideas; its Python DSP/ML runtime is excluded. |
| [An-3/an3-audacity-mcp](https://github.com/An-3/an3-audacity-mcp) | [MIT](https://github.com/An-3/an3-audacity-mcp/blob/5f9705936cb07551214c8cd9aa07f5cb1f7d9531/LICENSE), Copyright 2026 Andrii Boboshko | Historical command coverage audit; our runtime catalogue comes from Audacity, not its static command descriptions. |
| [PiMPStudios/mcp-audacity](https://github.com/PiMPStudios/mcp-audacity) | [MIT](https://github.com/PiMPStudios/mcp-audacity/blob/64a4de11274c594235170abd6f6e47960895a59d/LICENSE), Copyright 2026 Andrii Boboshko | Parameterized generator, macro, preference and command coverage ideas. |
| [buckydurddle/audacity-mcp](https://github.com/buckydurddle/audacity-mcp) | [MIT](https://github.com/buckydurddle/audacity-mcp/blob/bf2b08196406629cddae0c9c5799a4e9f396442e/LICENSE), Copyright 2026 Andrew Mercer | Compact discovery/dispatch, selection analysis and backup-first workflow ideas; approximate Undo-count checkpoints are not taken. |
| [tachyonshuggy/audacity-mcp](https://github.com/tachyonshuggy/audacity-mcp) | [MIT](https://github.com/tachyonshuggy/audacity-mcp/blob/cd2f38783a76a9ef10aa0be2bf3518d3c04e0888/LICENSE), Copyright 2026 Jeff Shoemaker | Selection/export/label/transport and saved-macro coverage. |

Research is reflected in original `src/tasks.ts` (plans/editing/generation),
`src/analysis.ts` (measurement/silence/loudness), `src/labels.ts` and
`src/ops.ts` (label workflows), `src/controls.ts` (macros/preferences/transport),
`src/batch.ts`, and pipe/catalogue recovery safeguards. Actual wire parameter
names are the local catalogue's, with comments for independently live-verified
extensions. Any future copied or adapted source code must identify its exact
source file/commit and licence here, retain applicable copyright/licence text,
and preserve all applicable Apache NOTICE attribution.

## Audacity implementation references

Official Audacity 3.7.8 source was inspected alongside live testing to verify
effect state, undo behavior, modal failures and asynchronous music imports:

- [NoiseReductionBase.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-builtin-effects/NoiseReductionBase.cpp): process-wide profiling, saved settings and native modal paths.
- [ClickRemovalBase.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-builtin-effects/ClickRemovalBase.cpp): the no-change modal error.
- [BatchCommands.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/BatchCommands.cpp): individual scripted effect/command calls skip adding their own undo state.
- [ImportExportPrefs.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/prefs/ImportExportPrefs.cpp): music-import preference names, choices and defaults.
- [ProjectFileManager.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/src/ProjectFileManager.cpp) and [MusicInformationRetrieval.cpp](https://github.com/audacity/audacity/blob/Audacity-3.7.8/libraries/lib-music-information-retrieval/MusicInformationRetrieval.cpp): tempo-detection routing, deferred analysis and synchronization behavior.

Audacity's source is GPL licensed. It was used for behavioral research only;
no C++ implementation was copied, translated, adapted or bundled in this MIT
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
