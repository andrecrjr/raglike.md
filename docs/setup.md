# Setup Guide

To set up this system, you need [Bun](https://bun.sh) installed.

## Quick Start

1. **Install dependencies**:
   ```bash
   bun install
   ```

2. **Run the server**:
   ```bash
   # Default MCP mode (Stdio)
   bun start

   # HTTP API mode
   bun start --api
   ```

## Model Context Protocol (MCP) Setup

`raglike-md` implements the Model Context Protocol, allowing it to be used as a tool provider for AI assistants like Claude Desktop.

### Claude Desktop Configuration

To use `raglike-md` with Claude Desktop, add the following to your `claude_desktop_config.json` (usually located at `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "raglike-md": {
      "command": "bun",
      "args": ["run", "src/index.ts", "--mcp"],
      "cwd": "/path/to/your/raglike-md",
      "env": {
        "POSTGRES_URL": "postgres://user:pass@localhost:5432/raglike"
      }
    }
  }
}
```

*Note: Replace `/path/to/your/raglike-md` with the actual absolute path to the project directory.*

## HTTP API Setup

The REST API provides a simple way to interact with the search engine from any web application.

### Start the API Server
```bash
bun start --api
```

The server will be available at `http://localhost:4321`.

### Environment Variables
- `ENABLE_API`: Set to `true` to enable the REST API.
- `ENABLE_MCP`: Set to `true` to enable the MCP server.
- `HOST`: The hostname/interface to bind the server to (default: `0.0.0.0` to allow all network access).
- `POSTGRES_URL`: Connection string for an external Postgres database (e.g., `postgres://user:pass@localhost:5432/raglike`). If not provided, the engine defaults to a local PGlite instance in the `.db/` folder.

## Testing the API

Once the server is running (either via Bun or Docker), you can test the search functionality using `curl`.

### Basic Search
```bash
curl -X POST http://localhost:4321/search \
  -H "Content-Type: application/json" \
  -d '{"query": "architecture overview", "limit": 2}'
```

### Search with Reranking (High Precision)
To enable the Cross-Encoder reranker for more accurate results, add `"rerank": true` to your request. **Note:** This will significantly increase the response time as it performs a secondary retrieval pass using a transformer model on the CPU.
```bash
curl -X POST http://localhost:4321/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "how the protocol handles SSE",
    "limit": 3,
    "rerank": true
  }'
```

## Docker Setup

The easiest way to run the full stack (Search Engine + Postgres Database) is using Docker Compose. This is the **preferred method** for development and testing.

```bash
# Build and start the stack
docker compose up -d --build

# View logs
docker compose logs -f raglike-md
```

The Docker setup automatically configures the environment variables and volumes for persistent data. When the container starts, it will automatically download the necessary embedding and reranker models.

## Detailed Documentation

For more information on how the system works and how to integrate it, refer to the following documents:

- [Architecture Overview](architecture/overview.md)
- [Server Modes & Usage](architecture/server-modes.md)
- [Vector Engine Details](architecture/vector-engine.md)
- [Search Protocol](architecture/protocol.md)
