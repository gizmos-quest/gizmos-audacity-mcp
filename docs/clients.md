# Client setup

These examples use the upcoming npm package. Before publication, build the
checkout and replace the command with `node` and the argument with an absolute
path to `dist/main.js`. Node 24.21+ must be visible to the client process.

## Claude Code

```sh
claude mcp add --scope user --transport stdio audacity -- npx -y @gizmos-quest/audacity-mcp
```

For a nonstandard installation, add `--env AUDACITY_EXE=/path/to/Audacity`
before `--transport`. For long effects, configure the client tool timeout to
at least ten minutes; `MCP_TOOL_TIMEOUT=900000` is a client setting.
[Official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

## Claude Desktop

Open **Settings → Developer → Edit Config**, add the `mcpServers` entry below,
and restart Claude Desktop. This also avoids assuming a particular desktop
installation's config location.

```json
{
  "mcpServers": {
    "audacity": {
      "command": "npx",
      "args": ["-y", "@gizmos-quest/audacity-mcp"]
    }
  }
}
```

[Official local-server setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## Cursor

Use the same `mcpServers` entry in `.cursor/mcp.json` for a project, or
`~/.cursor/mcp.json` for your user. Restart or reload the server after changes.
[Official Cursor MCP documentation](https://cursor.com/docs/context/mcp).

## VS Code

Create `.vscode/mcp.json`; VS Code uses `servers` rather than `mcpServers`:

```json
{
  "servers": {
    "audacity": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@gizmos-quest/audacity-mcp"]
    }
  }
}
```

Use **MCP: List Servers** to inspect/start it. Review the server trust prompt
before allowing access to local audio and projects.
[Official VS Code MCP documentation](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).

## Codex

```sh
codex mcp add audacity -- npx -y @gizmos-quest/audacity-mcp
```

Then configure the entry in `~/.codex/config.toml`:

```toml
[mcp_servers.audacity]
command = "npx"
args = ["-y", "@gizmos-quest/audacity-mcp"]
startup_timeout_sec = 90
tool_timeout_sec = 900
```

Codex's default tool timeout is 60 seconds; effects can take much longer.
[Official OpenAI MCP documentation](https://developers.openai.com/codex/mcp/).

## Windows command resolution

If a client cannot launch `npx`, use the shell wrapper:

```json
{"command":"cmd","args":["/c","npx","-y","@gizmos-quest/audacity-mcp"]}
```

Prefer a fully qualified Node executable for source-checkout setups. Run
Audacity and the client under the same user and privilege level. Set any
`AUDACITY_*` overrides on the server's client entry, not only in another shell.
