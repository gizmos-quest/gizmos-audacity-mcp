# Changelog

Changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/). The public API includes tool names,
input/result shapes and environment variables.

## [Unreleased]

### Added

- Initial public-release preparation for `@gizmos-quest/audacity-mcp` 0.1.0.
- Setup doctor, strict native safeguards and compatible MCP data reports.
- Recorded-byte stdio E2E, enforced coverage, hosted-only CI and manual release.
- Public setup, safety and contributor documentation.
- Support policy: Audacity 3.7.x with 3.7.8 as reference build and 3.7.9
  verified; Audacity 4 has no scripting interface. Doctor and launch name it, and
  doctor advises turning off update checks, whose notices are modal.
- Parameter limits for every built-in effect, scripting command and bundled
  Nyquist plug-in, generated from the Audacity 3.7.8 source (`npm run parameters`).

### Fixed

- Native request byte bounds, AutoDuck adjacency and process-sensitive profiling.
- Startup/shutdown and uncertain reply recovery safeguards.
- Bounded measurement work and protocol-version compatibility.
- Windows paths such as `C:\new\` no longer turn into line breaks inside Audacity;
  relative paths are sent absolute and text Audacity would alter is refused.
- A projectless or still-starting Audacity is reported within seconds, and
  launch waits until the project exists (for example after plugin scans).
- `doctor --fix` also records the module timestamp Audacity needs after updates.
- Hour-long recordings are measurable; Linux/macOS process checks name real binaries.
- Audacity 4 is refused with its reason and the 3.7.x install remedy.
- Edits no longer reach an unqualified Audacity: before each tool call's first
  edit, including fresh and quit saves, the running process must be the configured
  executable at a supported version (cached per process).
- Out-of-range parameters (for example Compressor `attackMs` above 200 or Amplify
  `Ratio` 0.003162) are refused before Audacity shows a blocking settings message;
  pipeline, batch and auto-duck ranges now match the native limits.
- Modal paths found in the Audacity 3.7.8 source are refused before dispatch:
  effects without a selected track or time range, Undo/Redo without native
  history, project imports, and selection- or rate-dependent dialogs in
  Paulstretch, Echo, equalization, Classic Filters, TruncateSilence and
  FindClipping. Paste, ZeroCross, RescanDevices and DTMF generation are reserved.
- Typed and batch imports refuse project and list files before any pipe I/O; Echo
  needs 1 to 16777216 history samples at each source rate; the Silence menu item
  gets the generator selection guard and a second time track is refused.
