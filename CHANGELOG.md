# Changelog

All notable changes are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/). The public API covers tool names,
input and result shapes, and environment variables.

## [Unreleased]

### Added

- A manual Registry workflow publishes a release's `server.json` to the MCP
  Registry through GitHub Actions OIDC, without a personal login.

### Fixed

- The release workflow waits up to ten minutes for npm to serve a new version
  before verifying it, instead of failing right after `npm publish`.

## [0.1.0] - 2026-10-11

First public release of `@gizmos-quest/audacity-mcp`.

### Added

- Reproducible synthetic voice-over example with reviewed cleanup, ducking,
  chapters/subtitles, measured delivery and an opt-in live stdio runner.
- Stronger coverage floors: statements/functions 96%, branches 92%, lines 97%.
- Property-based tests (fast-check) for command formatting and GetInfo parsing,
  checked against a model of Audacity 3.7.8's parameter parser and JSON output.

- 45 MCP tools over stdio for Audacity 3.7.x through `mod-script-pipe`: session
  and window control, discovery, editing and mixing, effects and reviewed
  pipelines, auto-duck, batch processing, labels and label files, measurement,
  transport, history, saved macros and two writable preferences.
- Strict inputs checked against the bundled English Audacity 3.7.8 catalogue and
  against parameter limits generated from the 3.7.8 source
  (`npm run parameters`), so out-of-range values (for example Compressor
  `attackMs` above 200) are refused before Audacity shows a blocking message.
- Support policy: 3.7.8 is the reference build and 3.7.9 is verified. `doctor`,
  `audacity_launch` and the first edit of every tool call, including fresh and
  quit saves, refuse other patch levels, Audacity 4 (it has no scripting
  interface) and a running Audacity other than the configured executable.
- `doctor` checks version, process owner, module enablement and the module
  timestamp Audacity needs after updates, pipe, English command IDs, update
  checks and ffmpeg. `doctor --fix` enables the module while Audacity is
  stopped, after a config backup, and finds it in Windows, macOS and Linux
  layouts.
- Modal paths found in the Audacity 3.7.8 source are refused before dispatch:
  effects and generators (including the Silence menu item) without a selected
  track and time range, Undo/Redo without native history, a second time track,
  project and list imports on every route, and selection- or rate-dependent
  dialogs in Echo, Paulstretch, equalization, Classic Filters, TruncateSilence
  and FindClipping. Paste, ZeroCross, RescanDevices and DTMF generation are
  reserved.
- Text reaches Audacity unchanged: Windows paths are sent absolute with forward
  slashes (a folder such as `C:\new` stays intact), and text Audacity's parser
  would alter is refused.
- Explicit uncertain outcomes: a timeout or lost reply locks edits until
  `audacity_recover` synchronizes through a nonce barrier, and edits are never
  replayed. A projectless or still-starting Audacity is reported within
  seconds. One per-user lock, independent of TEMP/TMPDIR, keeps a single
  controller per pipe.
- Structured content with output schemas for data reports, alongside unchanged
  JSON text; strictly increasing progress for pipelines and batches; a call
  cancelled while it waits for another operation never starts.
- Measurement streams audio in constant memory, so hour-long recordings are
  measurable, under a 24-hour duration cap and a time budget; optional ffmpeg
  adds LUFS, LRA and true peak.
- Recorded-byte stdio end-to-end tests; a live suite that preserves and then
  reopens the open project and accounts for every tool; enforced coverage; CI on
  GitHub-hosted runners only; CodeQL and OpenSSF Scorecard; and a manual release
  workflow with npm trusted publishing and provenance.

### Fixed

- Auto Duck errors give supported import-order/envelope alternatives; tool and
  argument descriptions explain destructive ducking, retained `mix_new` sources,
  additive labels, measurement result envelopes and measured loudness previews
  without changing contracts.
- Launch checks the endpoint's existing controller lock before starting Audacity,
  so a competing MCP session cannot start an app it cannot subsequently control.

- Recovery keeps edits locked when the synchronized Tracks reply has invalid
  audio extents or field types, using the same state validation as normal reads.
- Label insertion targets the named track even when another track has focus,
  and refuses preference-controlled naming dialogs before creating labels.
- Generation, named track creation/import and label reconstruction validate
  required later track selections and label indices before mutation, preserving
  the original project when the result would exceed a native index limit.
- SRT, VTT and ffmetadata exports refuse regions that collapse to zero duration
  after millisecond rounding; TSV and JSON retain their original precision.
- `audacity_effect` advertises its filesystem interaction in MCP annotations,
  and native lifecycle descriptions state their Windows limits.
