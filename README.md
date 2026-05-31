# search-docs-api 🚀

A high-performance, local semantic search engine for Markdown documentation. Built with **Bun**, **PGlite (pgvector)**, and **Xenova Transformers**.

`search-docs-api` recursively crawls your documentation folders, generates embeddings locally using the `all-MiniLM-L6-v2` model, and provides a semantic search interface via **Model Context Protocol (MCP)** or a **REST API**.

---

## 🏗️ Architecture

The system follows a "RAG-lite" (Retrieval-Augmented Generation) architecture, focusing on the retrieval layer. For detailed information, see our [Architecture Documentation](docs/architecture/overview.md).

- **[Overview](docs/architecture/overview.md)**: High-level system design and component breakdown.
- **[Vector Engine](docs/architecture/vector-engine.md)**: Deep dive into PGlite, embeddings, and indexing.
- **[Server Modes](docs/architecture/server-modes.md)**: Details on MCP vs HTTP API configurations.
- **[Search Protocol](docs/architecture/protocol.md)**: API and tool communication specifications.

---

## 🐳 Running with Docker (Recommended)

Docker is the easiest way to run `search-docs-api` as it comes pre-packaged with all native dependencies and model weights.

### 1. Build the Image
```bash
docker build -t search-docs-api .
```

### 2. Run as a REST API
Mount your local documentation folder to the container's `/app/docs` directory:
```bash
docker run -d \
  -p 4321:4321 \
  -v /path/to/your/docs:/app/docs \
  --name search-docs-api \
  search-docs-api --api
```

### 3. Run as an MCP Server
Configure your MCP host (e.g., Cursor or Claude Desktop) to use the Docker container:
```json
"search-docs-api": {
  "command": "docker",
  "args": [
    "run",
    "-i",
    "--rm",
    "-v", "/path/to/your/docs:/app/docs",
    "search-docs-api"
  ]
}
```

---

## 🛠️ Local Development

If you have [Bun](https://bun.sh) installed, you can run the project directly:

### Setup
```bash
bun install
```

### Run Search API
```bash
bun run src/index.ts --api
```

### Run Unit Tests
```bash
bun test
```

---

## 📡 API Usage

### Semantic Search
**Endpoint:** `POST http://localhost:4321/search`

**Payload:**
```json
{
  "query": "How do I configure the protocol?",
  "limit": 3
}
```

**Response:**
```json
{
  "success": true,
  "results": [
    {
      "file_path": "docs/architecture/protocol.md",
      "heading": "# Protocol",
      "content": "Detailed documentation content...",
      "distance": 0.4215
    }
  ]
}
```

---

## 📝 Logging
Logs are stored in `.logs/app.log` using the **Pino** logger. The system is tuned for production with minimal I/O overhead.

## ⚖️ License
MIT
