# AGENTS.md

- Keep this server Audacity-only: TypeScript, Node 24+, official MCP SDK v2
  (`@modelcontextprotocol/server`) and zod. No additional runtime dependency
  without a measured need. ffmpeg/ffprobe are optional external executables;
  never install/download runtimes or models from a tool.
- Read README.md, NOTICE.md, src/ and test/ before changes. Keep the tool table
  and docs/feature-matrix.md consistent with the registered tools and honest
  capability limits. Attribute any copied/adapted source with file/commit and
  licence in NOTICE.md, retaining applicable Apache notices and licence text.
- Validate all root and nested input strictly before mutation, including
  finite numbers, ranges and operation-specific fields. Preserve Audacity's
  own error text. Generic calls stay bound to the safe catalogue; task tools
  compose existing commands. Keep argument compatibility with
  ../example-consumer/tools/short.py, or update and verify that chain.
- Before trusting a parameter/command absent from the catalogue, test it
  against live pinned English Audacity 3.7.8 and record the evidence in a code
  comment. Do not guess older upstream aliases or Audacity 4 fork APIs.
- Never offer modal commands. Deny ellipsis menus and known exceptions;
  MeasureRms/Contrast/PlotSpectrum, ClickRemoval and unbounded Repair are unsafe;
  ClickRemoval opens a modal error even on valid audio without removable clicks.
  Keep raw lifecycle commands and
  unrestricted preferences/macros/Nyquist programs reserved. Require silent
  explicit-file options for result-producing sample/label commands.
- Serialize complete operations as well as pipe exchanges. Recreate pipe
  handles after commands and retry opening briefly. Bound blocked I/O with a
  disposable client helper; never terminate Audacity. A timeout or lost post-send reply leaves outcome
  unknown: require recovery and never replay an edit automatically.
- Encode booleans as 1/0. Track Volume input is dB, reported volume is linear.
  Select explicit tracks/time before exports; AddLabel can leave text focus.
  Default effects to the track extent to avoid creating silent gap clips.
  Refuse existing .aup3 save destinations before the pipe. Never use New;
  audacity_fresh preserves the current project before orderly restart, including
  restarting empty projects to reset process-wide effect state. Trim all audio
  outside the retained range on selected tracks without shifting the timeline;
  clip metadata changes require a time strictly inside one clip.
- Every Import2 path must temporarily disable asynchronous Music Import prompts
  and automatic tempo alignment using the live-verified 3.7.8 choices
  /FileFormats/MusicFileImportSettingChoice=No and
  /FileFormats/MusicFileImportOnExistingProjectSettingChoice=DoNothing.
  Restore prior supported choices afterward, or native defaults Ask and
  MatchIfBeatsAndMeasures if absent. On an uncertain pipe outcome, retain saved
  values for audacity_recover to restore after a real reconnection response.
  These internal import guards do not expand the public preference allowlist.
- NoiseReduction in 3.7.8 has no effect automation parameters. Do not expose
  Reduction/Sensitivity/Smoothing: native processing ignores them and uses saved
  UI settings. Require a known fresh process and audacity_noise_profile before
  reduction; capture only one room-tone interval per process, reuse an identical
  interval, and require audacity_fresh for a different profile. Reduction must
  select only the same captured audio track, with its original index/name;
  track-structure/history changes invalidate known profile state. Enforce the
  conservative minimum of 4096 rendered samples for profile capture. The pipe
  does not expose source-track sample rates, so cross-track reduction is refused.
  A new MCP server attaching to an existing Audacity must treat profile state as unknown.
- Audacity's individual scripting effect/command path uses kSkipState and does
  not add an undo entry per call. History tools operate existing native undo
  states from menu edits/imports; do not promise per-effect pipeline rollback.
  Preserve a project backup before destructive processing. Batch processing
  excludes noiseProfile because one process cannot profile successive temporary tracks.
- Hidden Windows operation is first-class. Never simulate mouse/keyboard
  input; WM_CLOSE through audacity_dialogs is allowed. Keep
  mod-cloud-audiocom and mod-musehub-ui disabled in the pinned host config.
- Before live tests, preserve an existing project with audacity_fresh to a
  unique backup path; retain that backup and all user files. At the end, quit
  test sessions cleanly, verify no stale ActiveProjects entries/open dialogs,
  then reopen the original visible project:
  EXAMPLE_WORKSPACE/example-consumer/productions/example-project/media/example-project.aup3.
  Distinguish legitimate entries for that running project from stale recovery
  entries. Recovery clearing is allowed only while stopped, with config backup
  and all project files retained.
- Peak/RMS/true peak/LUFS are distinct metrics. Unavailable metrics/targets
  remain unknown; quiet-block RMS and discontinuities are advisory estimates.
  Never claim certification or restore information lost to clipping. Pipeline
  normalization/limiting and room-tone capture must remain explicit, with
  dry-run plans; timing edits must identify video-sync consequences.
- Verify with npm run typecheck, npm test, npm run build, npm run test:live
  (AUDACITY_LIVE=1, real stdio server and hidden Audacity), and
  npm audit --audit-level=high. Live coverage must include every tool plus
  blocking-dialog closure, save-over refusal, pipe restart and recovery.
  GitHub Actions runs only typecheck/unit tests on Ubuntu/Node 24.
- Check dependency freshness with npm view <package> version. Verify the integration from ../example-consumer with:
  python tools/short.py audacity example-project --hidden.
  Confirm its mix-audacity.wav contains sound and restore the visible project.
- Public code, comments, docs and commit messages are English. Use Conventional
  Commits in sensible verified slices; push directly to main, no pull requests
  or branches left behind. End every commit message with:
  Co-Authored-By: Codex (GPT-6.1-Sol) <noreply@openai.com>
