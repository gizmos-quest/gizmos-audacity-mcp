# AGENTS.md

Local stdio MCP server (`@gizmos-quest/audacity-mcp`) that edits, processes and
measures audio through Audacity 3.7.x `mod-script-pipe`. This repository is
**public**. The product contract is the registered tool surface: README (users),
[docs/tools.md](docs/tools.md) and [docs/feature-matrix.md](docs/feature-matrix.md)
must match `tools/list`, and the native limits in [docs/safety.md](docs/safety.md)
and [docs/effects.md](docs/effects.md) must match the code.

## Start

Run `git pull --ff-only`, then read only what the task needs:

- Code layout and module ownership: [docs/architecture.md](docs/architecture.md)
- Test tiers, fixtures, catalogue/parameter regeneration: [docs/testing.md](docs/testing.md)
- Tool arguments and units: [docs/tools.md](docs/tools.md); `tools/list` snapshot `test/fixtures/tools.json`
- Doctor/config, clients: [docs/configuration.md](docs/configuration.md), [docs/clients.md](docs/clients.md)
- Release and registry (owner only): [docs/publishing.md](docs/publishing.md)
- Contributor flow: [CONTRIBUTING.md](CONTRIBUTING.md)

## Verify fast

Organization sessions run checks on Linux through `remote-run` (host per the
organization's remote-build topic), never as Windows test jobs or on the remote
Windows guest; others run the same `npm` lines locally.

```sh
# Focused: one mirrored test file (seconds)
remote-run --sh 'npm ci && npx vitest run test/<path>/<module>.test.ts'
# Full gate, CI order (10-40 s wall with a warm npm cache, ~1 min on a loaded host)
remote-run --sh 'npm ci && npm run check:workflows && npm run lint && npm run typecheck && npm test && npm run build && npm run test:e2e && npm run check:package && npm audit --audit-level=high && npm audit signatures'
```

After adding or changing a tool, refresh and review the `tools/list` snapshot:
`npx vitest run test/server.contract.test.ts -u`. Lint fails on Biome warnings;
coverage floors live in `vitest.config.ts`; never exclude untested logic to
reach them. No known flakes.

The gate exercises Windows framing with portable handle doubles, drive paths
with `node:path.win32`, and dialog refusal with native fakes. Never run Windows
or desktop test suites. Replay proves protocol and control logic; actual native
I/O, GUI, hardware and DSP qualification remain separate evidence. Never claim
that replay or a fake qualifies the native operating system.

## Rules

Code:

- TypeScript, Node 24.21+, official MCP SDK v2 (`@modelcontextprotocol/server`)
  and zod. No extra runtime dependency without a measured need; check freshness
  with `npm view <package> version`.
- Source/test modules about 300 lines or less (generated catalogue JSON and the
  lockfile excepted); smallest domain change, no speculative abstractions.
  Tests mirror `src/` as `test/<path>/<module>.test.ts`; fakes in `test/helpers/`.
- Native source facts are pinned to upstream tag `Audacity-3.7.8` (commit
  `6120ce4`); comments cite `file:line` there.

Invariants:

- Validate strict root/nested inputs, finite ranges and action-specific fields
  before mutation. Generic calls stay bound to the safe bundled catalogue.
  Preserve native error text and existing tool/argument/result contracts.
- Verify the actual executable/version before live mutations; a `3.7.*` pin is
  not exact 3.7.8. New noncatalogue values need pinned live evidence beside the
  code. Explicit executable overrides never attach/restart another installation.
- Serialize complete operations and pipe exchanges, recreate handles and bound
  blocked I/O with a disposable helper. Never kill Audacity or replay uncertain
  edits. Dialog/window native messages stay available while pipe calls wait.
- Booleans are 1/0. Enforce the encoded native request budget; never truncate or
  split commands. Native parsing unescapes `\n` and `\\`: send Windows paths with
  forward slashes and refuse other text it would change. A lone LF reply means no
  active project. Reject ignored native setter scope keys and select explicitly.
  Track gain input is dB, readback linear; public pan is -1..1, native percentage.
- Never offer known modal commands or raw lifecycle/recording/program/preference
  bypasses. Keep all source-rate/frame/context and import guards.
- Save to new `.aup3` destinations, preserve tracks before fresh, restart empty
  projects too, and prove orderly exit before deleting disposable saves. No New.
- Noise state is unknown on attach/recovery/process changes; profile only an
  explicit one-clip room-tone interval meeting both source/render frame minimums.
  No guessed noise parameters, cross-track reduction or batch noise profiling.
- Scripted effects add no per-call undo state. Normalization, limiting and
  timing changes stay explicit and reviewable with dry-run plans and backups.
- Distinguish peak/RMS/true peak/LUFS; unavailable metrics stay unknown.
  Advisory estimates do not certify targets or recover clipping information.
- Preserve real user projects and visibility; keep backups before live work.
  Tests quit cleanly, inspect dialogs/recovery entries and restore the original
  state. Stopped-only recovery clearing backs up config and keeps every project file.
- Runtime tools never install/download models or executables, simulate
  mouse/keyboard input, or open a network listener. Windows native messages are allowed.
- Workflows use GitHub-hosted Ubuntu/macOS runners only, full-SHA actions,
  explicit permissions and positive job timeouts (`npm run check:workflows`
  enforces this). No Windows test jobs and no self-hosted runners.

Public content: English source, comments, docs and Conventional Commits. Attribute
copied/adapted source by exact file/commit/license in NOTICE.md and keep the
required notices and license text. Never add personal machine paths, private
project details or credentials. LICENSE copyright and Git author identities stay
unchanged.

## Deliver

Organization sessions: branch `<kind>/<tool>-<id>/<topic>` (organization branch
convention), rebase on `origin/main`, run the full gate, fast-forward `main`, push,
delete the branch and watch the push's `Check` run; fix forward if it fails. No
pull requests from them; other contributors follow CONTRIBUTING.md.
Publishing, tags, the `Release` and `Registry` workflows and repository settings
are owner actions. Never bump the version or date a `CHANGELOG.md` release
section by hand: record user-visible changes under `## [Unreleased]`.
