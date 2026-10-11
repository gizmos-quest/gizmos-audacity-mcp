# Gizmos Audacity MCP

Local MCP tools for editing, processing and measuring audio in Audacity.

[![Node 24.21+](https://img.shields.io/badge/Node-24.21%2B-339933)](https://nodejs.org/)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/LICENSE)

**45 typed tools · Audacity 3.7.x · Node 24.21+ · stdio**

Import audio, edit tracks and clips, apply effects, write labels, export mixes,
and measure peak/RMS or optional LUFS/true peak. Audacity does the processing.
Windows supports hidden windows and native dialog recovery. macOS/Linux support
the scripting FIFOs; their native window lifecycle is not qualified.

## Requirements

- English **Audacity 3.7.x** with `mod-script-pipe` enabled: **3.7.8** is the
  reference build (bundled catalogue, parameter limits, source audit) and
  **3.7.9** is verified; other patch levels are refused until verified. On
  Windows, install and pin it:
  `winget install --id Audacity.Audacity -e --version 3.7.8`, then
  `winget pin add --id Audacity.Audacity -e --version 3.7.8`.
- **Audacity 4 is not supported**: 4.0 removed the scripting interface
  (`mod-script-pipe`). Support would be reconsidered only if Audacity ships a
  scripting host with full control.
- **Node.js 24.21 or newer**, running as the same user as Audacity.
- Optional **ffmpeg/ffprobe** for LUFS, LRA, true peak, other file formats and
  metadata. Native PCM/float WAV measurement needs neither.

## Quick start

The npm package is **`@gizmos-quest/audacity-mcp`**. For a source checkout,
run `npm ci`, then `npm run build`; use `node dist/main.js` as the server command.

1. Install Audacity 3.7.8. Enable `mod-script-pipe` in **Preferences →
   Modules**, choose English in **Preferences → Interface**, and turn off
   **Preferences → Application → Check for updates** (update notices are modal
   and block scripting until closed). Restart Audacity.
2. Check setup:

   ```sh
   npx -y @gizmos-quest/audacity-mcp doctor
   ```

   With Audacity stopped, `doctor --fix` can enable the scripting module. It
   saves a config backup first. [Setup and configuration](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/docs/configuration.md).
3. Add the local server to your client using a snippet below, then restart the
   client if it requires that. Keep one server in control of the shared pipe.

## Clients

**Claude Code**

```sh
claude mcp add --scope user --transport stdio audacity -- npx -y @gizmos-quest/audacity-mcp
```

**Claude Desktop / Cursor** — add this to the client's MCP configuration:

```json
{
  "mcpServers": {
    "audacity": {
      "command": "npx",
      "args": ["-y", "@gizmos-quest/audacity-mcp"]
    }
  }
}
```

**VS Code** — `.vscode/mcp.json`:

```json
{
  "servers": {
    "audacity": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@gizmos-quest/audacity-mcp"]
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.audacity]
command = "npx"
args = ["-y", "@gizmos-quest/audacity-mcp"]
startup_timeout_sec = 90
tool_timeout_sec = 900
```

Effects can take ten minutes; allow a longer client tool timeout. See
[client setup](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/docs/clients.md) for official references and Windows command
resolution. [Troubleshooting](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/docs/troubleshooting.md) covers missing pipes and
localized plugin IDs.

## First prompt

> Check Audacity's status and launch it if stopped. Import my voice recording as Voice. Measure it,
> then show a dry-run voice cleanup plan without normalization or noise
> reduction. Ask before applying it and save a project backup first.

A pipeline preview takes a named or zero-based track reference:

```json
{"track":"Voice","preset":"voice","dryRun":true,"loudness":"none"}
```

Try the [reproducible voice-over example](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/examples/voiceover/README.md): generated
audio, reviewed cleanup, a ducked bed, chapters/subtitles and measured delivery.
Its opt-in runner drives the built server over stdio against live Audacity.

## Tools

| Group | Tools |
| --- | --- |
| Session and discovery | launch, fresh, quit, window, dialogs, recover, status, project_info, info, describe |
| Edit and mix | select, import, export, project, track_set, track_edit, clip_move, clip_set, edit, fade, envelope_set |
| Process | generate, effect, noise_profile, pipeline, auto_duck, command, menu, macros, batch |
| Labels | labels_set, labels, labels_file, label_regions_export |
| Measure and control | measure, measure_file, compare_files, loudness_target, silence, contrast, probe_file, targets, transport, history, preferences |

Every name starts with `audacity_`. [Tool reference](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/docs/tools.md) includes
arguments and units; the [capability matrix](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/docs/feature-matrix.md) lists limits.

## Safety

- Save a new `.aup3` backup before destructive processing. Scripted effects
  do not create individual undo entries. Existing project save paths are refused.
- Strict inputs and a reviewed catalogue block known modal commands. Hidden
  Audacity still runs its UI and audio engine; it has no native headless mode.
- A timeout can leave an edit completed or still running. Inspect dialogs,
  use explicit recovery, then inspect the project before deciding what to do.
- Noise reduction requires fresh process state and an explicit room-tone
  capture; normalization, limiting and timing changes stay explicit.
- `mod-script-pipe` trusts local processes running as your user. Use one
  controller. The server never downloads runtimes/models or kills Audacity.

[Native safety limits](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/docs/safety.md) · [Effect requirements](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/docs/effects.md)
· [Testing](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/docs/testing.md) · [Architecture](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/docs/architecture.md)
· [Contributing](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/CONTRIBUTING.md) · [Security](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/SECURITY.md)

MIT licensed. Research and source attribution are in [NOTICE.md](https://github.com/gizmos-quest/gizmos-audacity-mcp/blob/main/NOTICE.md).
Audacity is a trademark of Muse Group; this project is unaffiliated.
