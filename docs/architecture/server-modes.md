# Server Modes

The application supports two distinct operational modes.

## 1. MCP Mode (Default)
This is the default mode, optimized for integration with AI hosts like Claude Desktop or other MCP-compatible clients.

- **Transport**: Standard IO (stdin/stdout).
- **Communication Protocol**: JSON-RPC based Model Context Protocol.

### Tools Available
- `semantic_markdown_search`: Searches through nested workspace markdown files using local pgvector embeddings.
- `read_chunk_neighbors`: Fetches the text immediately preceding and following a specific chunk. Useful for expanding context around a search result.
- `get_full_document`: Retrieves the full raw markdown content of a file.

> [!TIP]
> See the **[MCP Codex](../../README.md#📚-mcp-codex-tool-usage-examples)** in the root README for concrete examples of how to use these tools.

### Usage
```bash
bun start
```

## 2. HTTP API Mode (Unified)
This mode is useful for standalone use, integration with traditional web applications, or remote MCP access.

- **Transport**: HTTP/TCP.
- **Port**: 4321 (default).

### Endpoints
- **`/mcp`**: Unified endpoint for MCP-over-HTTP (Streamable HTTP). 
    - `GET /mcp`: Establish an SSE stream.
    - `POST /mcp`: Send JSON-RPC messages.
    - `DELETE /mcp`: Close the session.
- `GET /list-docs`: Lists all indexed markdown documents.
- `GET /read?path=...`: Retrieves the full raw markdown content of a file.
- `POST /search`: Conceptual search using local embeddings. Expects JSON body: `{"query": "...", "limit": 3}`.
- `POST /upload`: Uploads a `.md` or `.pdf` file to the `docs/` directory and indexes it immediately. Expects `multipart/form-data`.
- `DELETE /doc?path=...`: Removes a document from both the filesystem and the vector database.
- `GET /index.html`: Serves a simple web interface for searching and managing documents.

### Usage
```bash
bun start --api
```

## Persistence across Modes
Both modes utilize the unified `VectorEngine` database layer. Whether running as an MCP server or an HTTP API, the system will:
1. Detect and connect to the persistent database (Local PGlite or External Postgres).
2. Skip auto-ingestion if data is already present.
3. Provide consistent, granular search results across all interfaces.
