# raglike-md 🚀

A high-performance, local semantic search engine for Markdown documentation. Built with **Bun**, **PGlite (pgvector)**, **External Postgres Support**, and **Xenova Transformers**.

`raglike-md` recursively crawls your documentation, generates granular embeddings locally using the `all-mpnet-base-v2` model, and provides a semantic search interface via **Model Context Protocol (MCP)** or a **REST API**.

---

## ✨ Key Features

- **Hybrid Search (Vector + Full-Text):** Combines conceptual similarity (pgvector) with exact keyword matching (tsvector). Ranked using **Reciprocal Rank Fusion (RRF)** for superior precision.
- **Cross-Encoder Reranking:** Optional second-stage reranking using `bge-reranker-base` for ultra-high precision on complex technical queries.
- **HNSW Acceleration:** Automatically implements Hierarchical Navigable Small World indexing for sub-second searches across massive datasets.
- **Smart Chunking:** Uses a sliding window strategy with overlap (~600 chars) to ensure AI models receive complete context without losing semantic continuity.
- **Dual Database Architecture:** Automatically switches between local persistent **PGlite** (WASM-powered) and external **Postgres**.
- **Parallel Ingestion:** High-speed indexing that embeds and batches multiple document chunks simultaneously.
- **MCP & REST API:** Native support for the Model Context Protocol and standard HTTP interfaces.


---

## 🏗️ Architecture & Documentation

The system follows a "RAG-lite" (Retrieval-Augmented Generation) architecture, focusing on the retrieval layer.

- **[Quick Setup Guide](docs/setup.md)**: How to get up and running quickly.
- **[Architecture Overview](docs/architecture/overview.md)**: High-level system design and component breakdown.
- **[Server Modes & Usage](docs/architecture/server-modes.md)**: Deep dive into MCP Tools and API Endpoints.
- **[Search Protocol](docs/architecture/protocol.md)**: API and MCP tool communication specifications.
- **[MCP Client Setup Guide](docs/guides/mcp-client-setups.md)**: Configuration for Cursor, Claude Code, Windsurf, and more.
- **[MCP HTTP Stream Guide](docs/guides/mcp-http-stream.md)**: Deep dive into using MCP over HTTP/SSE.

---

## 🚀 Running MCP with Docker (Recommended)

The most portable way to use `raglike-md` with AI tools (Cursor, Claude Code, etc.) is via **SSE (Server-Sent Events)** inside Docker.

1. **Start the server:**
   ```bash
   docker run -d \
     -p 4321:4321 \
     -e ENABLE_API=true \
     -e ENABLE_MCP=true \
     -v $(pwd)/docs:/app/docs \
     raglike-md
   ```

2. **Quick Config:**

| Tool | Type | URL |
| :--- | :--- | :--- |
| **Cursor** | SSE | `http://localhost:4321/mcp` |
| **Claude Code** | SSE | `claude mcp add --transport sse raglike http://localhost:4321/mcp` |
| **Windsurf** | SSE | `url: http://localhost:4321/mcp` in `mcp_config.json` |
| **Cline** | SSE | Add Remote Server: `http://localhost:4321/mcp` |

See the **[MCP Client Setup Guide](docs/guides/mcp-client-setups.md)** for detailed tool-specific instructions.

---

## 🔌 Default MCP Configuration

### JSON (Cursor, Claude, Windsurf, Cline)
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

## 📚 MCP (Tool Usage Examples)

The `raglike-md` server provides a set of tools to help AI agents navigate and understand your documentation.

### 1. Conceptual Research (High Precision)
**Tool:** `semantic_markdown_search`
**Goal:** Find precise information about a concept using the cross-encoder.
**Prompt:** *"Find precise information about the protocol, use reranking for accuracy."*
**Agent Action:**
```json
{
  "name": "semantic_markdown_search",
  "arguments": {
    "query": "SSE connection protocol handling",
    "limit": 3,
    "rerank": true
  }
}
```

### 2. Context Expansion
**Tool:** `read_chunk_neighbors`
**Goal:** Get the sentences before and after a search result to see the full context.
**Prompt:** *"Show me what comes after the chunk explaining the 'Context Slop' strategy."*
**Agent Action:**
```json
{
  "name": "read_chunk_neighbors",
  "arguments": {
    "chunk_id": 42
  }
}
```

### 3. Full Document Retrieval
**Tool:** `get_full_document`
**Goal:** Read the entire file once the relevant one has been identified.
**Prompt:** *"Read the entire architecture overview document."*
**Agent Action:**
```json
{
  "name": "get_full_document",
  "arguments": {
    "file_path": "docs/architecture/overview.md"
  }
}
```

---

## 🌐 API Usage

Start the API server:
```bash
bun start --api
```

### 1. Semantic Search
**Endpoint:** `POST http://localhost:4321/search`

```json
{
  "query": "How do I configure the protocol?",
  "limit": 3,
  "rerank": true
}
```

### 2. Upload Document
**Endpoint:** `POST http://localhost:4321/upload` (multipart/form-data)

Upload a `.md` or `.pdf` file to be indexed immediately.

---

## 🐳 Running with Docker Compose (Recommended)

The easiest way to run the full stack (Search Engine + Postgres Database).

```yaml
services:
  db:
    image: ankane/pgvector:latest
    environment:
      - POSTGRES_DB=raglike
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
    volumes:
      - pgdata:/var/lib/postgresql/data

  raglike-md:
    image: raglike-md
    ports:
      - "4321:4321"
    environment:
      - ENABLE_API=true
      - ENABLE_MCP=true
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./docs:/app/docs
```

Run it with:
```bash
docker compose up -d
```

---

## 🛠️ Local Development

If you have [Bun](https://bun.sh) installed, you can run the project directly:

### Setup
```bash
bun install
```

### Environment Variables
- `POSTGRES_URL`: (Optional) Connection string for an external Postgres database.
- `ENABLE_API`: Set to `true` to enable the REST API.
- `ENABLE_MCP`: Set to `true` to enable the MCP server.
- `HOST`: The hostname/interface to bind to (default: `0.0.0.0`).

---

## 📝 Logging
Logs are stored in `.logs/app.log` using the **Pino** logger. The system detects its environment and logs database connection status accordingly.

## ⚖️ License
MIT
