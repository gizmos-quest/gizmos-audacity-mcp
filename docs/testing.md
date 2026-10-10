# Development and testing

Node 24.21+ is the minimum. The runtime uses the official MCP SDK v2 and zod;
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
npm run check:workflows
npm audit --audit-level=high
```

| Tier | What it establishes |
| --- | --- |
| Unit + contracts | Strict schemas, byte budgets, orchestration, state guards, public tools/argument shapes, annotations and output compatibility |
| Coverage | All `src/**/*.ts`, including unimported files; enforced floors: statements 95%, branches 91%, functions 95%, lines 96% |
| Built stdio E2E | Real production entry/helper and SDK boundary with recorded native bytes, fragmentation/delay/disconnect, uncertainty and recovery |
| Package check | Allowlisted files, size/privacy checks and installed-tarball stdio startup; never publishes |
| Live | Actual native project/lifecycle/effect behavior on the measured Audacity build |

Unit tests mirror the source tree: `test/<path>/<module>.test.ts` covers
`src/<path>/<module>.ts` (or `scripts/`), and `<module>.<aspect>.test.ts` splits a
large module by behavior. Cross-module suites are `server.contract.test.ts`
(`tools/list` snapshot and argument shapes), `server.docs.test.ts`,
`safety-regressions.test.ts` and `tasks/contracts.test.ts`. Shared fakes live in
`test/helpers/`; `test/e2e/` and `test/live/` hold the other tiers.

CI uses only GitHub-hosted Ubuntu, Windows and macOS runners with Node 24 and
current. Every job is bounded, permissions are explicit and actions are pinned
by full commit SHA. One cell also runs `npm audit signatures`; CodeQL analyzes
the code and the workflows, and OpenSSF Scorecard reports supply-chain checks.
Replay CI does not qualify native GUI behavior on POSIX.
Before publication, workflow steps must be verified locally; a configured
workflow or badge is not evidence that GitHub ran it.

## Recorded-byte E2E

The small corpus in `test/fixtures/audacity-3.7.8/` contains raw request/response
bytes from exact English 3.7.8 using synthetic audio. The manifest records
version/architecture, command/capture method and SHA-256 per file. Replay tests
may fragment, delay or disconnect those bytes; such scheduling transforms are
test fault injection, not claims about native DSP. `test/pipe.exchange.test.ts`
runs the production helper exchange against the same replay pipes in unit tests.

New recordings must use neutral names, omit personal paths/default preferences,
and retain exact framing/UTF-8 bytes. Check provenance and privacy before adding
fixtures. Never probe oversized native requests or deliberately provoke a
source-proven native crash to increase coverage.

## Native verification

```sh
npm run build
npm run test:live
```

`vitest.live.config.ts` is the explicit opt-in (it sets `AUDACITY_LIVE=1`); the
suite runs on Windows and drives the built server over stdio against hidden
Audacity. It verifies the
**actual executable/file version** before mutation: 3.7.8.0 by default, or the
value of `AUDACITY_LIVE_VERSION` (`3.7.9.0` is the only other accepted one). The
reference build is **3.7.8 ARM64 and x64**, and 3.7.9 is verified. Admit another
patch level only after its source diff against `Audacity-3.7.8` and a live run,
rather than silently broadening the catalogue.
Use English UI/registry and disable cloud/musehub modules in the isolated config.
Forward explicit `AUDACITY_*` overrides through the SDK's restricted environment.
`AUDACITY_CONFIG` only selects inspection; Audacity itself must use that config,
for example Portable Settings beside a portable executable.

Keep one session owner because Windows pipe names are fixed. The suite's first
call saves any open project to `.work/live-backups/before-live-*.aup3` and never
deletes it. Teardown discards only the disposable test project, then reopens that
backup with the original window visibility in an Audacity that was running before.
If setup could not preserve the open project, teardown leaves Audacity untouched.
Generate synthetic audio/projects. Cover every tool with
separate attempted/succeeded/expected-refusal accounting, plus save-over refusal,
blocking-dialog closure, restart/recovery and non-silent generated exports.
Unavailable device recording or optional ffmpeg is untested/refused, not passed.
`AUDACITY_LIVE_DEVICE_INDEPENDENT=1` skips the microphone/playback case; report
such a run as incomplete hardware coverage.

At teardown, quit orderly and verify actual process exit, no dialogs and no
stale ActiveProjects entries; a failed teardown is not a pass.
Running-project entries are legitimate. Config recovery clearing is stopped-only,
with backup and all project files retained. Never terminate Audacity or simulate
mouse/keyboard input from the server. Retain uncertain saves and scratch.

## Catalogue and release checks

`npm run catalogue` reads the running English instance after project
preservation. Captures sanitize installed plugin IDs and absolute path defaults.
Review new native values against the exact pinned build; add adjacent evidence
comments and regressions before expanding the safe surface.

Source facts are pinned to the upstream tag `Audacity-3.7.8` (commit
`6120ce413cf8abd4cca7f9470915f0ff0a0d2ded`); code comments cite `file:line` there.
`catalogue/parameters.json` holds the parameter keys, types, defaults, limits and
choices of every built-in effect, scripting command and bundled Nyquist plug-in,
read from that tag. CI has no Audacity source, so regenerate it by hand:

```sh
git clone --depth 1 --branch Audacity-3.7.8 https://github.com/audacity/audacity.git ../audacity
npm run parameters -- ../audacity
```

The script refuses a modified checkout, an unknown declaration shape and a
catalogue command without source declarations. `test/scripts/source-parameters.test.ts`
compares the result with the live catalogue and lists every accepted difference.

Keep README/tool reference/capability table consistent with `tools/list`. Check
direct dependency freshness with `npm view <package> version`; use matching
Vitest and `@vitest/coverage-v8`. Public source/test modules should remain about
300 lines or less. Run the final privacy scan without rewriting history or
altering LICENSE/Git author identities. Per-run results belong in release notes
or verification logs, not hard-coded machine-specific documentation.

Owner setup and the manual release workflow are documented in [publishing](publishing.md).
