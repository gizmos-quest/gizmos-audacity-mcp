# Contributor and agent instructions

Read README, NOTICE, `src/` and `test/` before changing code. Native evidence and
limits are in [docs/safety.md](docs/safety.md) and [docs/effects.md](docs/effects.md).
Keep those facts, the tool reference and capability matrix consistent with
registrations. `CLAUDE.md` points here.

## Commands

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

Lint fails on Biome warnings as well as errors. Native changes also need
`npm run test:live` on exact English Audacity 3.7.8. Check package freshness
with `npm view <package> version`. Do not claim skipped or incomplete checks
passed. [Testing](docs/testing.md) explains preservation, recorded fixtures,
architecture/platform evidence and teardown.

Native source facts are pinned to the upstream tag `Audacity-3.7.8` (commit
`6120ce4`); comments cite `file:line` at that tag. Clone it beside the checkout
(`git clone --depth 1 --branch Audacity-3.7.8 https://github.com/audacity/audacity.git ../audacity`)
and regenerate parameter limits with `npm run parameters -- ../audacity`.

## Architecture

- `main.ts` / `server.ts`: CLI/stdio entry and MCP assembly.
- `tools.ts` / `tool-*.ts`: strict registrations, metadata, reports/progress;
  `tool-input.ts` holds the shared input schemas, `errors.ts` the error helpers.
- `pipe.ts` / `pipe-worker.ts` / `format.ts`: byte framing, bounded transport.
- `app.ts` and platform modules: discovery, config, native window lifecycle.
- `catalogue.ts` / `effects/`: safe catalogue and native effect policy.
- `ops.ts` / `audacity/`: stateful native operations, validated GetInfo readers
  and selection transactions.
- `tasks/`, `analysis/`, `controls/`, labels and batch: domain workflows.

Use TypeScript, Node 24.21+, official MCP SDK v2 (`@modelcontextprotocol/server`)
and zod. No extra runtime dependency without a measured need. Keep source/tests
about 300 lines or less; generated catalogue JSON and lockfile are exceptions.
Prefer the smallest domain change over speculative abstractions. Tests mirror
`src/` as `test/<path>/<module>.test.ts`; shared fakes live in `test/helpers/`.

## Invariants

- Validate strict root/nested inputs, finite ranges and action-specific fields
  before mutation. Generic calls stay bound to the safe bundled catalogue.
  Preserve native error text and existing tool/argument/result contracts.
- Verify actual executable/version before live mutations. A `3.7.*` pin is not
  exact 3.7.8. New noncatalogue values need pinned live evidence beside the code.
  Explicit executable overrides must not attach/restart a different installation.
- Serialize complete operations and pipe exchanges, recreate handles and bound
  blocked I/O with a disposable helper. Never kill Audacity or replay uncertain
  edits. Dialog/window native messages remain available while pipe calls wait.
- Booleans are 1/0. Enforce the encoded native request budget; never truncate or
  split commands. Native parsing unescapes `\n` and `\\`: send Windows paths with
  forward slashes and refuse other text it would change. A lone LF reply means no
  active project. Reject ignored native setter scope keys and select explicitly.
  Track gain input is dB/readback linear; public pan is -1..1/native percentage.
- Never offer known modal commands or raw lifecycle/recording/program/preference
  bypasses. Preserve all source-rate/frame/context guards and import guards.
- Save to new `.aup3` destinations, preserve tracks before fresh, restart empty
  projects too, and prove orderly exit before deleting disposable saves. No New.
- Keep noise state unknown on attach/recovery/process changes; profile only an
  explicit one-clip room-tone interval with both source/render frame minimums.
  No guessed noise parameters, cross-track reduction or batch noise profiling.
- Scripted effects add no per-call undo state. Normalization, limiting and
  timing changes stay explicit and reviewable with dry-run plans/backups.
- Distinguish peak/RMS/true peak/LUFS and keep unavailable metrics unknown.
  Advisory estimates do not certify targets or recover clipping information.
- Preserve actual user projects/visibility and retain backups before live work.
  Cleanly quit tests, inspect dialogs/recovery entries, then restore original state.
  Stopped-only recovery clearing backs up config and retains every project file.
- Runtime tools never install/download models/executables, simulate mouse/keyboard
  input, or introduce a network listener. Windows native messages are allowed.
- GitHub Actions uses hosted runners only, full-SHA actions, explicit permissions
  and positive job timeouts. Preserve this repository's runner restrictions.

Keep public source/comments/docs/commits English and use Conventional Commits.
Attribute copied/adapted source by exact file/commit/license in NOTICE and retain
applicable notices/license text. Never add personal machine paths, private
project details or credential material. LICENSE copyright and Git author
identities must stay unchanged.
