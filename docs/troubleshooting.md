# Troubleshooting

Start with `gizmos-audacity-mcp doctor`. Include its checks, OS/architecture,
Node version, actual Audacity version and MCP client when reporting a problem.
Redact personal paths, audio names and private configuration from logs.

| Symptom | Check / next action |
| --- | --- |
| No scripting pipe | Use Audacity 3.7.8, enable `mod-script-pipe`, restart. Run `doctor --fix` only while stopped. Audacity 4 removed the scripting interface: install 3.7.x and pin it (see [setup](configuration.md)). |
| Wrong installation | Verify `AUDACITY_EXE` and actual executable version. Preserve and quit the other running installation first. |
| Startup never answers | Inspect dialogs with `audacity_dialogs`, show the window, check module/config and recovery entries. Do not start a second project. |
| "Empty reply … no active project" | Audacity is still starting or its project window is gone; its script relay runs nothing then. Wait for the project window, then `audacity_recover`. |
| Quit reports a windowless process | The project was saved and closed but Audacity's main loop kept running. With no `ActiveProjects` entry it holds no project: end it in Task Manager. The server never terminates Audacity. |
| Command/effect missing | English UI plus an English plugin registry are required. Inspect `audacity_info` Commands and `audacity_describe`. |
| Client cannot find Node/npx | Restart the client after installing Node 24+; use the Windows wrapper in [clients](clients.md). |
| Access denied | Run client and Audacity under the same user/privilege level; inspect endpoint/config ownership. |
| Endpoint already owned | Close the other MCP session before attaching. The local ownership lock coordinates this server's entry points; unrelated readers remain unsupported. |
| Effect request times out | Give the client at least ten minutes. A server timeout leaves the edit outcome unknown; follow recovery below. |
| LUFS/true peak unknown | Install optional ffmpeg yourself; use longer non-silent audio. Sample peak/RMS cannot stand in for those metrics. |

## An uncertain pipe outcome

1. Inspect `audacity_dialogs`; `{"close":true}` sends native WM_CLOSE to
   blocking dialogs, including while another operation is waiting.
2. Call `audacity_recover`. A successful synchronization response is required
   before the pipe resumes edits; recovery never replays the interrupted edit.
3. Inspect tracks, clips and any retained scratch files. Determine what
   completed before choosing another operation.

After an uncertain import, safe Music Import settings remain active. Recovery
restores their saved values after trustworthy reconnection. A measurement,
source-rate query or quit save can retain scratch for the same reason.

`ActiveProjects` entries are normal while a project is open. If Audacity is
stopped and stale entries remain, inspect recovery before using
`discardRecovery:true`. It backs up the config and retains every project file.

## Cached localized plugins

Stop Audacity and back up both `audacity.cfg` and its plugin registry before
regenerating a registry under English settings. Do not delete user files or
silently reset preferences. Reopen, rerun doctor and compare the essential
command IDs. A new plugin ID needs catalogue review and pinned native testing
before it can become callable.
