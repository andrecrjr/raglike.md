# MCP Client Setup Guide

`raglike-md` implements the Model Context Protocol (MCP). It is optimized to run over HTTP using **Server-Sent Events (SSE)** inside a Docker container, providing remote access to your IDEs and development agents.

---

## 🐋 Starting the Server via Docker (Recommended)

To run `raglike-md` in Docker with MCP enabled:

```bash
docker run -d \
  -p 4321:4321 \
  -e ENABLE_API=true \
  -e ENABLE_MCP=true \
  -e API_TOKEN=your_secure_auth_token \
  -v $(pwd)/docs:/app/docs \
  -v $(pwd)/.repos:/app/.repos \
  raglike-md
```

If you set `API_TOKEN`, remember that certain clients (like Cursor) must pass the token in their authorization headers.

---

## 1. Cursor (IDE)

Cursor connects to remote MCP servers over HTTP/SSE.

1.  Open **Settings** (`Cmd+,` or `Ctrl+,`).
2.  Navigate to **Features** > **MCP**.
3.  Click **"+ Add New MCP Server"**.
4.  Configure as follows:
    *   **Name**: `raglike-md`
    *   **Type**: `sse`
    *   **URL**: `http://localhost:4321/mcp`
5.  If you have configured `API_TOKEN`:
    *   Add a header: `Authorization` with value `Bearer your_secure_auth_token`

---

## 2. Claude Code (CLI)

Add the `raglike-md` server directly to your Claude Code instance using the CLI command:

```bash
claude mcp add --transport sse raglike-md http://localhost:4321/mcp
```

If `API_TOKEN` is enabled on the server, configure it in your environment:
```bash
# Note: Claude Code automatically forwards authorization headers if configured
claude mcp add --transport sse raglike-md http://localhost:4321/mcp
```

---

## 3. Windsurf (IDE)

Windsurf reads its MCP configurations from a static JSON configuration file.

*   **Config Location**:
    *   macOS/Linux: `~/.codeium/windsurf/mcp_config.json`
    *   Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`

Add the server connection details inside the `mcpServers` object:

```json
{
  "mcpServers": {
    "raglike-md": {
      "url": "http://localhost:4321/mcp"
    }
  }
}
```

---

## 4. Roo Code / Cline (VS Code Extension)

1.  Open the extension settings panel.
2.  Navigate to the **MCP Servers** dashboard tab.
3.  Click **"+ Add Remote Server"**.
4.  Configure:
    *   **Name**: `raglike-md`
    *   **URL**: `http://localhost:4321/mcp`
    *   **Headers** (Optional): Add `{"Authorization": "Bearer your_secure_auth_token"}` if required.

Alternatively, you can edit the extension configuration file (`~/.vscode/extensions/.../mcp_settings.json` or similar depending on the plugin) directly:

```json
{
  "mcpServers": {
    "raglike-md": {
      "command": "bun",
      "args": ["run", "src/index.ts", "--mcp"],
      "cwd": "/path/to/raglike-md",
      "env": {
        "POSTGRES_URL": "postgres://user:pass@localhost:5432/raglike"
      }
    }
  }
}
```

---

## 5. Codex (Coding Agent)

Codex uses a **TOML** configuration file located at `~/.codex/config.toml`.

### SSE Configuration (Recommended)
```toml
[mcp_servers.raglike]
enabled = true
url = "http://localhost:4321/mcp"
```

### Stdio Configuration (Local Process)
```toml
[mcp_servers.raglike]
enabled = true
command = "bun"
args = ["run", "src/index.ts", "--mcp"]
env = { ENABLE_MCP = "true" }
```

---

## 6. Antigravity

Configure your client settings by adding `raglike-md` to your `mcp_servers.json` configuration block:

```json
{
  "servers": [
    {
      "name": "raglike-md",
      "transport": "sse",
      "url": "http://localhost:4321/mcp",
      "enabled": true
    }
  ]
}
```
