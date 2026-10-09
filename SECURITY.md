# Security policy

The latest released version receives security fixes. This repository is preparing
its first public release; no published version is claimed yet.

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/gizmos-quest/gizmos-audacity-mcp/security/advisories/new).
If that feature is not enabled yet, contact **admin [at] gizmos [dot] quest**.
Do not include private audio, personal paths or exploit details in a public issue.
Provide the affected version, reproducible steps and expected impact. Maintainers
will acknowledge and coordinate a fix and disclosure; no response-time guarantee
is made before the report is reviewed.

Relevant boundaries include pipe-command injection, strict input validation,
file overwrite/deletion, process control and uncertain-outcome recovery.
`mod-script-pipe` intentionally trusts local processes running as Audacity's user;
this server does not create an authentication boundary around that native pipe.
Run one trusted controller and use backups before destructive edits.

Audacity and optional ffmpeg/ffprobe are separate projects. Report vulnerabilities
in those applications upstream, and tell us when the server makes their impact
reachable. See [native safety](docs/safety.md) for operational limits.
