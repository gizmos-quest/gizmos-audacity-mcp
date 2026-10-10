# Contributing

Start with an issue describing the user problem and smallest useful change.
For bugs, include a reproducible case, OS/CPU, actual Audacity version, MCP client
and redacted doctor output. Report vulnerabilities privately via [SECURITY](SECURITY.md).

Use Node 24.21+, `npm ci`, then:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run check:package
npm audit --audit-level=high
```

Coverage includes all source modules and enforces 85% statements, 80% branches,
85% functions and 90% lines. Do not exclude untested logic to reach thresholds.
Prefer domain modules of about 300 lines or less and meaningful tests around
trust boundaries/native behavior. See [architecture](docs/architecture.md).

When adding a tool, provide strict root/nested schemas, truthful annotations,
title, useful result schema, contract tests and concise docs. Preserve existing
tool names/argument shapes and `dist/main.js` stdio startup. Array/string result
compatibility matters when adding structured content. Keep the [tool reference](docs/tools.md)
and [capability matrix](docs/feature-matrix.md) consistent with registrations.

Native changes require exact English Audacity 3.7.8 evidence before trusting
noncatalogue parameters. Preserve a user's actual project/visibility and retain
backups; quit test sessions cleanly. Never simulate input, kill Audacity, retry
uncertain edits, or download/install runtimes/models from tools. Full native
verification and fixture capture guidance is in [testing](docs/testing.md).

Use English public code/docs and Conventional Commits. Keep runtime dependencies
limited to the official MCP SDK v2 and zod unless a measured need justifies more.
Attribute any copied/adapted source with exact file/commit/license in NOTICE,
retaining required notices/license text. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
