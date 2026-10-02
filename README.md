# Gizmos Audacity MCP

An MCP server that drives a running **Audacity 3.x** through `mod-script-pipe`,
live: every call shows up in the open Audacity window. With a hidden window
it also does work nobody needs to watch.

## Why Audacity 3.7

Audacity 4.0 removed `mod-script-pipe` and has no scripting surface; driving
it needs a self-built fork. 3.7.8 is the last release with the pipe, so the
host pins it (`winget pin add --id Audacity.Audacity --version 3.7.*`).

## Tools

| Tool | What it does |
| --- | --- |
| `audacity_launch` | Start Audacity visible (live) or hidden (headless-style); waits for the pipe. |
| `audacity_window` | Show or hide the window of a running Audacity. |
| `audacity_quit` | Quit without a save prompt; discards the project unless `saveTo` is given. |
| `audacity_status` | Running or not, and the tracks with name, kind, start/end, volume, pan, mute, solo. |
| `audacity_info` | Tracks, Clips, Envelopes, Labels, Boxes, Commands, Menus as JSON. |
| `audacity_describe` | Parameters of one command or effect. |
| `audacity_command` | Any of the 86 scripting commands and effects, validated against Audacity's own parameter list. |
| `audacity_menu` | Menu commands that open no dialog (transport, selection, tracks, labels, zoom, edit). |
| `audacity_select` | Time range on one or more tracks. |
| `audacity_import` | Import a file as a named track at a position. |
| `audacity_track_set` | Name, volume, pan, mute, solo. |
| `audacity_clip_move` | Move a clip to a start time. |
| `audacity_envelope_set` | Volume envelope points (linear gain), visible as the curve. |
| `audacity_labels_set` | Point or region labels in a named label track. |
| `audacity_effect` | Select a range and apply an effect in one step. |
| `audacity_noise_profile` | Capture the Noise Reduction profile from room tone. |
| `audacity_export` | Export the mix (or a range) to WAV/FLAC/MP3. |
| `audacity_project` | New, open, save `.aup3`. |

The command catalogue (`catalogue/`) is read from Audacity itself
(`GetInfo: Type=Commands` and `Type=Menus`, English UI) and refreshed with
`npm run catalogue`. Parameters Audacity accepts but does not list (track
scope of the `Set*` commands, Noise Reduction settings) are added in
`src/catalogue.ts`, each verified against a live 3.7.8.

## Setup (Windows)

1. `winget install --id Audacity.Audacity -e --version 3.7.8` and pin it.
2. Enable the module: Preferences > Modules > `mod-script-pipe` = Enabled,
   restart. (Equivalent in `%APPDATA%\audacity\audacity.cfg`: `[Module]
   mod-script-pipe=1` and the DLL's timestamp under `[ModuleDateTime]`.)
3. Set the UI language to English (Preferences > Interface) and let the
   plugin registry rebuild once, so effect ids are stable.
4. `npm install && npm run build`, then register the server:

```json
{ "mcpServers": { "audacity": { "command": "node", "args": ["<repo>/dist/main.js"] } } }
```

## Behaviour worth knowing

- Booleans go to Audacity as `1`/`0`; it reads `True` as false.
- Values cannot contain double quotes or line breaks; the pipe has no escape.
- One command at a time: the server queues calls. Effects get ten minutes.
- Menu items whose label ends in `...` open a modal dialog and are not
  offered, because a dialog blocks the pipe until a person closes it.
- `audacity_quit` saves to a temporary file before quitting, so the next
  start shows no recovery dialog.

## Verification

```text
npm run typecheck
npm test                      # unit tests
npm run build
AUDACITY_LIVE=1 npx vitest run test/live.test.ts   # against a running Audacity
```

The live test works in a new project; run it against a hidden instance
(`audacity_launch {visible:false}`), not over an open project.
