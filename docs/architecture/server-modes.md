# Server Modes

The application supports two distinct operational modes.

## 1. MCP Mode (Default)
This is the default mode, optimized for integration with AI hosts like Claude Desktop or other MCP-compatible clients.

- **Transport**: Standard IO (stdin/stdout).
- **Communication Protocol**: JSON-RPC based Model Context Protocol.
- **Capabilities**: Exposes tools for semantic search.

### Usage
```bash
bun start
```

## 2. HTTP API Mode
This mode is useful for standalone use or integration with traditional web applications.

- **Transport**: HTTP/TCP.
- **Port**: 4321 (default).
- **Endpoint**: `POST /search`
- **Payload**:
  ```json
  {
    "query": "how to install",
    "limit": 5
  }
  ```

### Usage
```bash
bun start --api
```
