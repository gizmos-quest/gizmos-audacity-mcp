# Setup and configuration

Use English Audacity **3.7.8** with its shipped `mod-script-pipe` module.
Check the executable's actual file version: a `3.7.*` installer pin can admit
a later patch. Audacity 4 and custom fork APIs are unsupported.

1. Enable `mod-script-pipe` in **Preferences → Modules** and restart.
2. Run `gizmos-audacity-mcp doctor` (or the package's `npx` command).
3. Configure a [client](clients.md), then inspect `audacity_status`.

Doctor returns JSON checks for version, process ownership/executable, module
configuration, pipe presence, essential English IDs and optional ffmpeg.
Checks requiring a running reachable Audacity remain unknown when it is stopped.
With Audacity stopped, `doctor --fix` enables the module and retains a unique
config backup. It does not install Audacity or rewrite plugin/language settings.

| Variable | Purpose |
| --- | --- |
| `AUDACITY_EXE` | Explicit installed/portable executable. Invalid overrides fail; lifecycle actions refuse a different running installation. |
| `AUDACITY_CONFIG` | Config file to inspect. **Does not redirect Audacity's settings.** Use the application's real config or Portable Settings. |
| `AUDACITY_FFMPEG` | Optional ffmpeg executable; otherwise discovered on PATH. |
| `AUDACITY_FFPROBE` | Optional ffprobe executable; otherwise discovered on PATH. |
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
