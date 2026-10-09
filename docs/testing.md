# Development and testing

Node 24+ is the minimum. The runtime uses the official MCP SDK v2 and zod;
Biome and Vitest/v8 coverage are development tools. No audio runtime or model
is installed/downloaded by a server tool.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run check:package
npm pack --dry-run
npm audit --audit-level=high
```

| Tier | What it establishes |
| --- | --- |
| Unit + contracts | Strict schemas, byte budgets, orchestration, state guards, public tools/argument shapes, annotations and output compatibility |
| Coverage | All `src/**/*.ts`, including unimported files; statements 85%, branches 80%, functions 85%, lines 90% release floors |
| Built stdio E2E | Real production entry/helper and SDK boundary with recorded native bytes, fragmentation/delay/disconnect, uncertainty and recovery |
| Package check | Allowlisted files, size/privacy checks and installed-tarball stdio startup; never publishes |
| Live | Actual native project/lifecycle/effect behavior on the measured Audacity build |

CI uses only GitHub-hosted Ubuntu, Windows and macOS runners with Node 24 and
current. Every job is bounded, permissions are explicit and actions are pinned
by full commit SHA. Replay CI does not qualify native GUI behavior on POSIX.
Before publication, workflow steps must be verified locally; a configured
workflow or badge is not evidence that GitHub ran it.

## Recorded-byte E2E

The small corpus in `test/fixtures/audacity-3.7.8/` contains raw request/response
bytes from exact English 3.7.8 using synthetic audio. The manifest records
version/architecture, command/capture method and SHA-256 per file. Replay tests
may fragment, delay or disconnect those bytes; such scheduling transforms are
test fault injection, not claims about native DSP.

New recordings must use neutral names, omit personal paths/default preferences,
and retain exact framing/UTF-8 bytes. Check provenance and privacy before adding
fixtures. Never probe oversized native requests or deliberately provoke a
source-proven native crash to increase coverage.

## Native verification

```sh
npm run build
npm run test:live
```

The script explicitly opts in with `AUDACITY_LIVE=1` and drives the built server
over stdio against hidden Audacity. Verify the **actual executable/file version**
before mutation; the primary target is **3.7.8 ARM64 and x64**. Test 3.7.9
separately and report its evidence rather than silently broadening the catalogue.
Use English UI/registry and disable cloud/musehub modules in the isolated config.
Forward explicit `AUDACITY_*` overrides through the SDK's restricted environment.
`AUDACITY_CONFIG` only selects inspection; Audacity itself must use that config,
for example Portable Settings beside a portable executable.

Keep one session owner because Windows pipe names are fixed. Before live work,
preserve the actual user's open project to a new retained backup with fresh and
record its visibility. Generate synthetic audio/projects. Cover every tool with
separate attempted/succeeded/expected-refusal accounting, plus save-over refusal,
blocking-dialog closure, restart/recovery and non-silent generated exports.
Unavailable device recording or optional ffmpeg is untested/refused, not passed.

At teardown, quit orderly, verify actual process exit, no dialogs or stale
ActiveProjects entries, then restore the original project and visibility.
Running-project entries are legitimate. Config recovery clearing is stopped-only,
with backup and all project files retained. Never terminate Audacity or simulate
mouse/keyboard input from the server. Retain uncertain saves and scratch.

## Catalogue and release checks

`npm run catalogue` reads the running English instance after project
preservation. Captures sanitize installed plugin IDs and absolute path defaults.
Review new native values against the exact pinned build; add adjacent evidence
comments and regressions before expanding the safe surface.

Keep README/tool reference/capability table consistent with `tools/list`. Check
direct dependency freshness with `npm view <package> version`; use matching
Vitest and `@vitest/coverage-v8`. Public source/test modules should remain about
300 lines or less. Run the final privacy scan without rewriting history or
altering LICENSE/Git author identities. Per-run results belong in release notes
or verification logs, not hard-coded machine-specific documentation.

Owner setup and the manual release workflow are documented in [publishing](publishing.md).
