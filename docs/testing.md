# Development and testing

Node 24.21+ is the minimum. The runtime uses the official MCP SDK v2 and zod;
Biome, Vitest/v8 coverage and fast-check are development tools. No audio runtime
or model is installed/downloaded by a server tool.

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
| Properties | Generated commands and GetInfo replies (fast-check) checked against a model of Audacity 3.7.8's parameter parser and JSON output |
| Coverage | All `src/**/*.ts`, including unimported files; enforced floors: statements 96%, branches 92%, functions 96%, lines 97% |
| Built E2E | Production stdio entry/helper and SDK boundary with recorded native bytes, fragmentation/delay/disconnect, uncertainty and recovery; Windows framing through portable handle doubles |
| Package check | Allowlisted files, size limits, metadata and installed-tarball stdio startup; never publishes |

Unit tests mirror the source tree: `test/<path>/<module>.test.ts` covers
`src/<path>/<module>.ts` (or `scripts/`), and `<module>.<aspect>.test.ts` splits a
large module by behavior. Cross-module suites are `server.contract.test.ts`
(`tools/list` snapshot and argument shapes), `server.docs.test.ts`,
`safety-regressions.test.ts` and `tasks/contracts.test.ts`. The property tests in
`format.property.test.ts` check that an accepted command reads back unchanged,
that text is refused exactly when native parsing would change it, and that GetInfo
replies parse losslessly. Shared fakes live in `test/helpers/`; `test/e2e/`
holds the built-runtime tier.

CI uses only GitHub-hosted Ubuntu and macOS runners with Node 24 and current;
Windows test jobs are not used. Every job is bounded, permissions are explicit
and actions are pinned by full commit SHA. One cell also runs
`npm audit signatures`; CodeQL analyzes the code and the workflows, and OpenSSF
Scorecard reports supply-chain checks. Organization sessions run these checks
on Linux through `remote-run`, never Windows or desktop test suites.
The gate covers Windows CRLF/NUL framing, fragmented UTF-8, the default lone-LF
idle deadline and recovery latch through portable handle/process doubles in
`e2e/pipe-framing.test.ts`. Windows drive-relative/rooted and UNC paths use
`node:path.win32` with a controlled working directory in `format.test.ts`.
`controls.test.ts` uses the native window fake to prove dialog refusal before
reconnect and acceptance after closure; ownership aliases also run on every host.
These cases exercise the production Windows branches without host-based skips.
Replay and fakes do not qualify Windows kernel pipe I/O or native GUI behavior.
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

## Native evidence boundary

The retained recordings and adjacent source/effect evidence refer to exact
English Audacity **3.7.8 ARM64 and x64**; 3.7.9 is also verified. Portable gates
do not establish new native project/lifecycle, hardware or DSP results. Admit
another patch level only with its source diff against `Audacity-3.7.8` and
separately authorized native evidence, rather than broadening the catalogue
from replay results.

## Example workflow

The [voice-over example](../examples/voiceover/README.md) generates a 12-second
voice-like fixture and stereo bed from original deterministic synthesis. Its
runner uses the built server over a fresh SDK stdio connection, previews cleanup,
ducking and loudness gain, preserves project backups, exports audio and label
sidecars, and checks the actual delivery file. No audio binaries are committed.

```sh
npm run build
npm run example:voiceover -- --live
```

This is an explicit Windows/English Audacity **3.7.8** opt-in with ffmpeg/ffprobe
already installed. Quit Audacity and close other MCP controllers first: the
runner refuses a running app or
recovery entries before mutation. It creates a new output directory under
`.work/`, retains artifacts and a call/timing report, and verifies orderly exit,
no dialogs and empty ActiveProjects on success. On failure it retains the project
and artifacts, attempting a saved orderly exit only for the session it started.
It never kills a process or replays an uncertain edit. See the example README
for recovery steps and custom output paths.

The example runner is never part of hosted CI: hosted runners have no Audacity.
Unit tests cover deterministic synthesis and workflow assertions without native
I/O; the opt-in run establishes actual DSP and lifecycle behavior.

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
