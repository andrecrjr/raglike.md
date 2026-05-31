# raglike-md 🚀

A high-performance, local semantic search engine for Markdown documentation. Built with **Bun**, **PGlite (pgvector)**, and **Xenova Transformers**.

`raglike-md` recursively crawls your documentation folders, generates embeddings locally using the `all-MiniLM-L6-v2` model, and provides a semantic search interface via **Model Context Protocol (MCP)** or a **REST API**.

---

## 🏗️ Architecture

The system follows a "RAG-lite" (Retrieval-Augmented Generation) architecture, focusing on the retrieval layer. For detailed information, see our [Architecture Documentation](docs/architecture/overview.md).

- **[Overview](docs/architecture/overview.md)**: High-level system design and component breakdown.
- **[Vector Engine](docs/architecture/vector-engine.md)**: Deep dive into PGlite, embeddings, and indexing.
- **[Server Modes](docs/architecture/server-modes.md)**: Details on MCP vs HTTP API configurations.
- **[Search Protocol](docs/architecture/protocol.md)**: API and tool communication specifications.

---

## 🐳 Running with Docker (Recommended)

Docker is the easiest way to run `raglike-md` as it comes pre-packaged with all native dependencies and model weights.

### 1. Build the Image
```bash
docker build -t raglike-md .
```

### 2. Run as a REST API
Mount your local documentation folder to the container's `/app/docs` directory:
```bash
docker run -d \
  -p 4321:4321 \
  -v /path/to/your/docs:/app/docs \
  --name raglike-md \
  raglike-md --api
```

### 4. Run with Environment Variables
You can control the server modes using environment variables (`ENABLE_API` and `ENABLE_MCP`).
```bash
docker run -d \
  -p 4321:4321 \
  -e ENABLE_API=true \
  -e ENABLE_MCP=true \
  -v /path/to/your/docs:/app/docs \
  --name raglike-md \
  raglike-md
```

### 5. Using Docker Compose
A `docker-compose.yml` is provided:
```yaml
services:
  raglike-md:
    build: .
    ports:
      - "4321:4321"
    environment:
      - ENABLE_API=true
      - ENABLE_MCP=true
    volumes:
      - ./docs:/app/docs
    restart: unless-stopped
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
