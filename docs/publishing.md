# Publishing

Publication is an owner action after review. The prepared package name is
`@gizmos-quest/audacity-mcp`; an available npm name does not establish reservation
or publishing rights. `server.json` uses `io.github.gizmos-quest/gizmos-audacity-mcp`.
No package, registry entry or GitHub release is claimed before publication.

Before the first release:

1. Review current-tree privacy and historical content separately. Implementation
   does not rewrite history. Confirm LICENSE and attribution are preserved.
2. Make the reviewed repository public and enable GitHub-hosted Actions. Ensure
   runner groups never grant this public repository access to private runners.
3. Run the hosted matrix/CodeQL and review logs. Enable private vulnerability
   reporting and confirm the community enforcement contact is monitored.
4. Establish ownership/publishing rights for the npm scope/package and configure
   its Trusted Publisher as GitHub organization **gizmos-quest**, repository
   **gizmos-audacity-mcp**, workflow filename **release.yml**, no environment name.
   Allow direct `npm publish`; the workflow uses no long-lived npm token.
   Create the trust configuration close to release: its first successful publish
   must occur within two days before an unvalidated configuration expires.
5. Update any first-release preparation wording once installation is available.

[Official npm trusted-publishing guidance](https://docs.npmjs.com/trusted-publishers/)
describes package-settings setup and any required package bootstrap. The hosted
release workflow checks npm ≥11.5.1 and uses OIDC with `npm publish --provenance`.

Dispatch **Release** on `main` with `initial` for the current upcoming version,
or `patch`, `minor`, `major` for a bump. It runs local-equivalent validation,
checks/publishes the exact package, then writes `chore(release): vX.Y.Z`, tag and
GitHub release. Package, lockfile, registry manifest and changelog versions stay
in sync. Agents do not manually tag or publish from their worktree.

The job runs only in `gizmos-quest/gizmos-audacity-mcp`, never in a fork. Main
and the release tag are checked again right before `npm publish`: a main that
moved during the gates stops the run before publication. If main moves after
publication, the job pushes the tag of the published release commit first and
merges that commit into the newer main; when the merge needs a person, merge the
tag by hand and rerun the same dispatch, which resumes from the tag. Existing npm
versions must match the exact tarball integrity; mismatches and conflicting tags
stop the workflow for inspection. A publish cannot be rolled back by resetting Git.
Registry publication remains separate: review the current official MCP Registry
requirements before submitting `server.json`. No MCPB is prepared because the
bundled client runtime's Node 24 requirement has not been qualified.
