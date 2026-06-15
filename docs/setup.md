# Setup Guide

`raglike-md` can be run either locally via **Bun** or as a containerized service via **Docker**. This guide covers the complete installation, environment configuration, and server validation steps.

---

## 🚀 Quick Start

### Local Setup (Bun)
To set up this system locally, you need [Bun](https://bun.sh) installed (version 1.0 or higher).

1. **Install dependencies**:
   ```bash
   bun install
   ```

2. **Configure environment variables**:
   Copy the example environment file and configure your settings (e.g. define `POSTGRES_URL` if connecting to an external/outside Postgres instance):
   ```bash
   cp .env.example .env.local
   ```

3. **Run the server**:
   ```bash
   # Default MCP mode (Stdio)
   bun start

   # HTTP API mode (includes Web UI & REST API)
   bun start --api
   ```

### Docker Setup (Preferred)
The easiest way to run the full stack (Search Engine + Postgres Database) is using Docker Compose. This ensures a consistent runtime environment and handles persistence automatically.

```bash
# Start the entire stack in the background
docker compose up -d

# View real-time logs to confirm initialization
docker compose logs -f raglike-md
```

The database data is persisted under the `pgdata` volume, and the server runs on port `4321`.

---

## ⚙️ Environment Variables

Configure these variables in a `.env` file at the root of the project or pass them directly to the container/process environment.

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `ENABLE_API` | `boolean` | `true` (CLI flag overrides) | Set to `true` to enable the REST API server. |
| `ENABLE_MCP` | `boolean` | `true` (CLI flag overrides) | Set to `true` to run the Model Context Protocol (MCP) server. |
| `PORT` | `number` | `4321` | The port the HTTP server binds to. |
| `HOST` | `string` | `0.0.0.0` | The network interface host to bind the server to. |
| `API_TOKEN` | `string` | (None) | **Critical Security**: If set, enables Bearer token authentication on all REST endpoints and lists. |
| `WEBHOOK_SECRET` | `string` | (None) | Secret token used to validate incoming GitHub/GitLab webhook payloads. |
| `POSTGRES_URL` | `string` | (None) | Database connection string (e.g. `postgres://user:pass@host:5432/db`). If omitted, defaults to an embedded **PGlite** instance. |
| `API_EMBEDDING_URL` | `string` | (None) | Optional. Directs the engine to use an external API for generating embeddings instead of local execution. |
| `API_EMBEDDING_TOKEN`| `string` | (None) | Optional. Bearer auth token for the external embedding API endpoint. |

---

## 🔒 Security Configuration

### API Token Protection
When you define the `API_TOKEN` environment variable, the server secures all endpoints. Clients must send the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer your_secure_token" http://localhost:4321/list-docs
```

### Git Webhook Signature Verification
To prevent malicious payload injections, set a `WEBHOOK_SECRET`. The server uses this secret to perform HMAC-SHA256 verification on payloads sent from GitHub and token validation for GitLab.

---

## 🔍 Validation & Testing

Once your server is running, you can test operations via standard tools.

### 1. Check HTTP Search Endpoint
```bash
curl -X POST http://localhost:4321/search \
  -H "Content-Type: application/json" \
  -d '{"query": "architecture overview", "limit": 2}'
```

### 2. Check Search with Reranking
Enable the Cross-Encoder reranking pass to verify high-precision results:
```bash
curl -X POST http://localhost:4321/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "how the protocol handles SSE",
    "limit": 3,
    "rerank": true
  }'
```

---

## 📚 Detailed Architecture & Guides

For deep dives into the components and client integration, explore:
*   [Architecture Overview](architecture/overview.md)
*   [Server Modes & Usage](architecture/server-modes.md)
*   [Vector Engine Details](architecture/vector-engine.md)
*   [Search Protocol Reference](architecture/protocol.md)
*   [MCP Client Setup Guide](guides/mcp-client-setups.md)
