# AGENTS.md

- Keep this server Audacity-only. TypeScript, Node 24+, the official MCP SDK
  v2 and zod; no other runtime dependencies without a measured need.
- Every tool validates its input strictly and reports Audacity's own error
  text. Generic tools stay bound to the catalogue; new task tools bundle
  existing pipe commands.
- Before trusting a parameter or command that is not in the catalogue, try it
  against a live Audacity 3.7.x and record that in the code comment.
- Never offer a command that opens a modal dialog: it blocks the pipe.
- Public code, comments and docs in English. Commit messages in English,
  Conventional Commits. No pull requests: verified work goes to `main`.
- Verify with `npm run typecheck`, `npm test`, `npm run build` and the live
  test against a hidden Audacity (see README).
