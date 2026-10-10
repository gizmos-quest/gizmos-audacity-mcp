# Publishing

Publication is an owner action. The npm package is `@gizmos-quest/audacity-mcp`;
`server.json` describes it for the official MCP Registry as
`io.github.gizmos-quest/gizmos-audacity-mcp` (the package's `mcpName`). Agents
never publish, tag by hand or change repository settings.

## Before the first release

1. **Make the repository public**, then switch on what public repositories get:
   private vulnerability reporting, secret scanning with push protection,
   Dependabot alerts and a ruleset for `main` that blocks force pushes and
   deletion. Runner groups must never grant this repository self-hosted runners.
2. **Watch the first hosted runs** of `Check` and `CodeQL`. A configured workflow
   is not evidence that GitHub ran it.
3. **Create the npm package once.** npm configures trusted publishing only for
   an existing package. With the `gizmos-quest` npm organization in place,
   publish a placeholder from an empty folder with your own login and 2FA:

   ```sh
   npm init -y
   npm pkg set name=@gizmos-quest/audacity-mcp version=0.0.0 license=MIT description="Placeholder for trusted publishing"
   npm publish --access public
   npm deprecate @gizmos-quest/audacity-mcp@0.0.0 "Placeholder; use 0.1.0 or later"
   ```

4. **Add the trusted publisher** in the package settings on npmjs.com:
   *Trusted publishing → GitHub Actions* with organization `gizmos-quest`,
   repository `gizmos-audacity-mcp`, workflow filename `release.yml` and no
   environment, and allow direct publishing (new configurations only stage by
   default). An unvalidated configuration expires after 48 hours, so add it
   right before the first release and recreate it if it lapsed.
5. **Dispatch Release** on `main` with level `initial` (next section).
6. **Lock publishing** once 0.1.0 is on npm: *Publishing access → Require
   two-factor authentication and disallow tokens*. Trusted publishing keeps
   working. Then drop the "upcoming package" notes in the README,
   `docs/clients.md` and `SECURITY.md`.

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) documents the
settings page.

## Each release

Dispatch **Release** (*Actions → Release → Run workflow* on `main`) with
`initial` for the version already in `package.json` (first release only), or
`patch`, `minor` or `major`. The job runs only in
`gizmos-quest/gizmos-audacity-mcp`, never in a fork. It moves the changelog's
Unreleased notes under the new version (dated by the dispatch commit), sets the
version in `package.json`, the lockfile and `server.json`, and runs the CI gates.
Right before `npm publish` it checks main and the tag again: a main that moved
during the gates stops the run. It publishes the exact tarball through OIDC with
provenance (no npm token), verifies its integrity on the registry, and then
pushes `chore(release): vX.Y.Z`, the tag and the GitHub release.

If main moves after publication, the job pushes the tag of the published release
commit first and merges that commit into the newer main; when the merge needs a
person, merge the tag by hand and rerun the same dispatch, which resumes from the
tag. An existing npm version must match the exact tarball integrity; a mismatch
or a conflicting tag stops the workflow for inspection. A publish cannot be
rolled back by resetting Git.

## MCP Registry

After npm has the new version, publish the registry entry from the release tag
with [`mcp-publisher`](https://modelcontextprotocol.io/registry/quickstart) and a
GitHub account in the `gizmos-quest` organization:

```sh
git checkout vX.Y.Z
mcp-publisher login github
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.gizmos-quest/gizmos-audacity-mcp"
```

The registry checks that the npm package's `mcpName` matches `server.json`. It is
in preview, so this step stays manual. No MCPB bundle is prepared: the Node 24
requirement of the bundled client runtime has not been qualified.
