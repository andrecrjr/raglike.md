# MCP Client Configuration Guide

`raglike-md` is optimized for **SSE (Server-Sent Events)** over HTTP, allowing you to run the search engine in a **Docker container**. This ensures a consistent environment and easy remote access for your AI tools.

## Recommended Transport: SSE via Docker

While `raglike-md` supports local Stdio, we recommend using Docker for better isolation and ease of setup.

### Step 1: Start the Docker Container
Run the following command to start the MCP server with HTTP/SSE enabled:

```bash
docker run -d \
  -p 4321:4321 \
  -e ENABLE_API=true \
  -e ENABLE_MCP=true \
  -v $(pwd)/docs:/app/docs \
  raglike-md
```

### Step 2: Configure your Client
Use the unified endpoint: `http://localhost:4321/mcp`

---

## 1. Cursor (IDE)

Cursor allows you to connect to remote MCP servers directly via the UI.

1. Open **Settings** (`Cmd+,` or `Ctrl+,`).
2. Navigate to **Features** > **MCP**.
3. Click **"+ Add New MCP Server"**.
4. **Configuration**:
   - **Name**: `raglike-md`
   - **Type**: `sse`
   - **URL**: `http://localhost:4321/mcp`

---

## 2. Claude Code (CLI)

Add the `raglike-md` server to your global Claude Code configuration:

```bash
claude mcp add --transport sse raglike-md http://localhost:4321/mcp
```

---

## 3. Windsurf (IDE)

Windsurf manages MCP servers via a global JSON file.

**Config File Location:**
- **macOS/Linux**: `~/.codeium/windsurf/mcp_config.json`
- **Windows**: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`

**Configuration:**
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

## 4. Cline / Roo Code (VS Code Extension)

1. Open the Cline panel in VS Code.
2. Click the **MCP Servers** icon (three stacked boxes).
3. Select the **Remote Servers** tab.
4. Click **"+ Add Remote Server"**.
5. **Name**: `raglike-md`
6. **URL**: `http://localhost:4321/mcp`

---

## 5. Antigravity

Add `raglike-md` to your `mcp_servers.json` configuration:

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

---

## Troubleshooting

- **Check Docker Logs**: `docker logs <container_id>` to ensure the server started correctly.
- **Firewall/Network**: Ensure port `4321` is open and reachable by your IDE.
- **SSE Connection**: Verify the endpoint is alive by visiting `http://localhost:4321/mcp` in your browser (it should show a session endpoint).
