# Setup and configuration

Use English Audacity **3.7.x** with its shipped `mod-script-pipe` module.

| Version | Status |
| --- | --- |
| 3.7.8 | Reference build: bundled catalogue, source-derived parameter limits and modal-path audit |
| 3.7.9 | Verified: its source changes no scripting surface and the live suite passes |
| Other 3.7 patches | Refused until their source diff and a live run are checked |
| 4.x | Not supported: Audacity 4 has no scripting interface (4.0 removed `mod-script-pipe`) |

Check the executable's actual file version: a `3.7.*` installer pin can admit
a later patch. `doctor`, `audacity_launch` and the first edit of every tool call
(also before fresh or quit saves) refuse another version or a different running
installation; reads, dialogs and recovery stay available. They name the remedy:
install 3.7.x and pin it, for example
`winget install --id Audacity.Audacity -e --version 3.7.8` then
`winget pin add --id Audacity.Audacity -e --version 3.7.8`.

1. Enable `mod-script-pipe` in **Preferences → Modules** and restart.
2. Run `gizmos-audacity-mcp doctor` (or the package's `npx` command).
3. Configure a [client](clients.md), then inspect `audacity_status`.

Doctor returns JSON checks for version, process ownership/executable, module
configuration, pipe presence, essential English IDs, update checks and
optional ffmpeg. Audacity checks for updates while running and shows update
or Audacity 4 notices modally; doctor advises turning off **Preferences →
Application → Check for updates**, without changing it.
The pipe and English-ID checks need a running Audacity and fail while it is
stopped. Audacity loads an enabled module only if the config also records that
module file's timestamp; after an update it treats the file as new and skips it.
With Audacity stopped, `doctor --fix` writes both values, as **Preferences →
Modules** does, and retains a unique config backup; an already correct config is
left untouched. It finds the module beside the executable, in a macOS bundle, in
Linux library directories such as `/usr/lib/audacity/modules`, or at the path
Audacity recorded; without the module file doctor reports a failure and `--fix`
changes nothing. It does not install Audacity or rewrite plugin/language settings.
Doctor exits with status 1 when a required check fails; the update-notice and
ffmpeg checks are advisory.

| Variable | Purpose |
| --- | --- |
| `AUDACITY_EXE` | Explicit installed/portable executable. Invalid overrides fail; lifecycle actions refuse a different running installation. Default: `C:\Program Files\Audacity\Audacity.exe`, `/usr/bin/audacity` or `/Applications/Audacity.app/Contents/MacOS/Wrapper`. |
| `AUDACITY_CONFIG` | The `audacity.cfg` that doctor checks and fixes and that recovery entries and saved macros (`Macros/` beside it) are read from. **Does not redirect Audacity's settings.** Default: `Portable Settings` beside `AUDACITY_EXE`, else the user's Audacity config folder (`%APPDATA%\audacity`, `~/Library/Application Support/audacity`, `$XDG_CONFIG_HOME/audacity` or `~/.config/audacity`). |
| `AUDACITY_FFMPEG` | Optional ffmpeg executable; otherwise discovered on PATH. |
| `AUDACITY_FFPROBE` | Optional ffprobe executable; otherwise the `ffprobe` beside a path-valued `AUDACITY_FFMPEG`, else PATH. |
| `AUDACITY_PIPE_TO` / `AUDACITY_PIPE_FROM` | Advanced paired endpoints for isolated relay tests; both must be supplied. Windows named pipes or absolute POSIX FIFOs only; ordinary use needs neither. |

Windows uses one fixed named-pipe pair. macOS/Linux use the current user's
standard `/tmp/audacity_script_pipe.*.<uid>` FIFOs. A file entry alone does not
establish a live connection. Keep one controller and run it as Audacity's user.
Native hide/show/dialog/quit handling is Windows-only; stop/quit manually on
other platforms.

Endpoint overrides reject newlines/NUL, regular files and POSIX symlinks.
Windows endpoints use `\\.\pipe\name`; POSIX endpoints must be absolute FIFO
paths. Missing test FIFOs may be created by a relay before the bounded open retry;
native opens never create or truncate ordinary files. Overrides never fall back
to the user's normal pipe.

English UI alone may leave cached localized Nyquist command IDs. Doctor checks
essential IDs, including `High-passFilter` and `SampleDataExport`. If they differ,
stop Audacity, back up its config and plugin registry, then follow
[troubleshooting](troubleshooting.md). The checked-in catalogue does not
automatically change for arbitrary installed plugins.

Pinned test setups disable `mod-cloud-audiocom` and `mod-musehub-ui`; those
modules appeared in a historical crash stack. This is test configuration,
not proof that either caused the crash.
