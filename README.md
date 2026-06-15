# raglike-md 🚀

### **The Zero-UI Knowledge Engine for AI Agents**

`raglike-md` is a high-performance, local semantic search engine specifically engineered for AI Agents (like Cursor, Claude Code, and Windsurf). It transforms your documentation and codebases into a high-fidelity knowledge base that agents can navigate with structural precision.

Built with **Bun**, **PGlite (pgvector)**, **MDAST**, and **Xenova Transformers**.

---

## 🧠 Why raglike-md?

Most RAG systems use generic character-based chunking that breaks context. `raglike-md` is **Code-Aware**:

- **Structural AST Chunking:** Splits documents by Markdown headers (#, ##) instead of raw character counts, preserving logical context.
- **Code-Block Bundling:** Strictly binds code blocks (```ts ... ```) to their preceding contextual paragraphs. Code is never split across chunks.
- **Zero-UI Git Pipeline:** Ingest repositories automatically via Webhooks (GitHub/GitLab). No manual uploads required.
- **Multi-Repo Scoping:** Search across multiple repositories with scoped queries.
- **Agent-First Protocol:** Native **Model Context Protocol (MCP)** support via SSE, optimized for agentic workflows.

---

## ✨ Key Features

- **4-way Hybrid Search:** Combines conceptual similarity (pgvector), English keyword matching (stemmed), literal matching (non-stemmed), and literal heading boosts using RRF.
- **Cross-Encoder Reranking:** Secondary pass using `bge-reranker-base` for ultra-high precision.
- **Secure & Team-Ready:** Bearer Token authentication and Webhook signature validation.
- **HNSW Acceleration:** Sub-second searches across massive datasets.
- **Local Embeddings:** All processing happens on your machine using `all-mpnet-base-v2`.

---

## 🚀 Quick Start (Docker SSE)

The most portable way to use `raglike-md` with AI tools (Cursor, Claude Code, etc.) is via **SSE (Server-Sent Events)** inside Docker.

1. **Start the server:**
   ```bash
   docker run -d \
     -p 4321:4321 \
     -e ENABLE_MCP=true \
     -e API_TOKEN=your_secure_token \
     -e WEBHOOK_SECRET=your_webhook_secret \
     -v $(pwd)/.repos:/app/.repos \
     raglike-md
   ```

2. **Tool Configuration:**

| Tool | Type | URL | Auth |
| :--- | :--- | :--- | :--- |
| **Cursor** | SSE | `http://localhost:4321/mcp` | Add `Authorization: Bearer your_token` |
| **Claude Code** | SSE | `claude mcp add --transport sse raglike http://localhost:4321/mcp` | |
| **Windsurf** | SSE | `url: http://localhost:4321/mcp` | |

---

## 🔄 Git Ingestion (Zero-UI)

Configure a Webhook on your GitHub/GitLab repository to trigger automatic re-indexing on every push.

**Endpoint:** `POST http://localhost:4321/api/v1/sync/webhook`
**Secret:** Matches your `WEBHOOK_SECRET` environment variable.

Supported Events:
- **GitHub:** `push` event (Signature: `x-hub-signature-256`)
- **GitLab:** `Push Hook` (Token: `x-gitlab-token`)

---

## 💻 Terminal Sync (raglike-cli)

Synchronize local folders directly from your terminal.

```bash
# Option 1: Run without installing (zero-install)
bun x ./cli ./my-notes --server http://localhost:4321

# Option 2: Install globally
bun run install-cli
raglike-cli ./my-notes
```

- **Delta Sync:** Only uploads new or changed files.
- **Config Support:** Uses `.raglike` (JSON) files for persistent settings.
- **Recursive:** Scans subdirectories for `.md` and `.pdf`.

[Read the CLI Guide →](docs/guides/cli.md)

---

## 📚 MCP Tools

### 1. `semantic_markdown_search`
Find precise information across all ingested repositories.
**Arguments:**
- `query`: The conceptual query.
- `limit`: Number of results (default: 3).
- `rerank`: Use cross-encoder (default: false).
- `repository`: Optional repo ID (e.g., "owner-repo") to scope search.

### 2. `read_chunk_neighbors`
Get the text before and after a result to expand context.

### 3. `get_full_document`
Retrieve the full raw markdown content of a file.

---

## 🌐 API Reference

### Semantic Search
`POST /search`
```json
{
  "query": "How does the protocol handle SSE?",
  "limit": 3,
  "repository": "my-org-project"
}
```

### Generate Embeddings
`POST /api/v1/embeddings`
```json
{
  "texts": ["Hello world", "Semantic intelligence"]
}
```
*Returns `{"success": true, "embeddings": [[...], [...]]}`*

---

## 🛠️ Local Development

```bash
bun install
bun run src/index.ts --mcp
```

### Environment Variables
- `API_TOKEN`: Secure your MCP/REST endpoints.
- `WEBHOOK_SECRET`: Secure your Git ingestion pipeline.
- `API_EMBEDDING_URL`: (Optional) Offload embedding generation to an external API.
- `API_EMBEDDING_TOKEN`: (Optional) Bearer token for the external embedding API.
- `POSTGRES_URL`: (Optional) Use an external Postgres instance.

---

## ⚖️ License
MIT
