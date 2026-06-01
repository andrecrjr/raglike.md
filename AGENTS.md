# raglike-md 🚀

High-performance local semantic search engine using Bun, PGlite, and Xenova Transformers. This file serves as the primary technical guide for both human developers and AI agents.

## 🛠 Tech Stack
- **Runtime:** [Bun](https://bun.sh) (Default underlying runtime)
- **Containerization:** [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/) (Primary development/deployment focus)
- **Database:** [PGlite](https://pglite.dev/) (local WASM Postgres) or external Postgres with `pgvector`.
- **Embeddings:** `all-MiniLM-L6-v2` (384-dimensional) via `@xenova/transformers`.
- **API:** REST API and [Model Context Protocol (MCP)](https://modelcontextprotocol.io).
- **Logging:** [Pino](https://github.com/pinojs/pino).

## 🧠 Engine & Search Logic

### 1. Embedding Model
- **Model:** `Xenova/all-MiniLM-L6-v2`
- **Metric:** Cosine Similarity (`vector_cosine_ops` in pgvector).
- **Indexing:** HNSW (Hierarchical Navigable Small Worlds) is used for performance, with parameters `m = 16` and `ef_construction = 64`.

### 2. Chunking Strategy
- **Type:** Hierarchical Markdown-aware chunking.
- **Size:** Sliding window of ~600 characters.
- **Overlap:** ~120 characters to preserve cross-chunk context.
- **Context Slop:** Chunks are enriched with "Context Slop" (breadcrumbs and sentences from adjacent chunks) to provide the LLM with immediate surroundings without fetching neighbors.

### 3. Search Algorithm (Hybrid Search)
We use **Reciprocal Rank Fusion (RRF)** to combine:
1. **Vector Search:** Concept-based similarity using pgvector.
2. **Full-Text Search:** Keyword-based search using Postgres `tsvector`.

## 📚 MCP Codex (Tool Usage Examples)

The `raglike-md` server provides a set of tools to help AI agents navigate and understand your documentation.

### 1. Conceptual Research
**Tool:** `semantic_markdown_search`
**Goal:** Find where a specific concept is discussed without knowing exact filenames.
**Prompt:** *"Find information about how the protocol handles SSE connections."*
**Agent Action:**
```json
{
  "name": "semantic_markdown_search",
  "arguments": {
    "query": "SSE connection protocol handling",
    "limit": 3
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

## 🏛 Architecture
- **Engine (`src/engine.ts`):** Core logic for document crawling, cleaning (stripping base64), chunking, and indexing.
- **API (`src/api.ts`):** Bun-native HTTP server hosting REST endpoints and SSE-based MCP.
- **MCP (`src/mcp.ts`):** Tool definitions and logic for Model Context Protocol integration.

## 🚀 Development Workflows

### Docker-First Workflow (ALWAYS Preferred)
- **Start Stack:** `docker compose up -d`
- **Rebuild & Restart:** `docker compose build raglike-md && docker compose up -d raglike-md`
- **Logs:** `docker compose logs -f raglike-md`
- **In-Container Testing:** `docker compose exec raglike-md bun test`

### Local Development (Bun)
- **Setup:** `bun install`
- **Run:** `bun run src/index.ts --api --mcp`

## 🛡 Conventions & Excellence

### 1. TypeScript Standards
- **Strict Mode:** Always on. No `any` ever. Use `unknown` if a type is truly indeterminate and narrow it.
- **Interfaces vs. Types:** Use `interface` for object shapes and public APIs (faster for the compiler); use `type` for unions, intersections, and primitives.
- **Zero Overhead:** Avoid `enum`. Use `const X = { ... } as const` for runtime performance and better tree-shaking.
- **Explicit Returns:** Always type the return value of public methods and API handlers.
- **Resource Management:** Use the `using` keyword (Explicit Resource Management) for database connections or file handles to ensure deterministic cleanup.

### 2. Testing Mandates
- **Always Test:** A feature is not complete without a corresponding `src/*.test.ts`.
- **Deterministic Embeddings:** In unit tests, mock the embedding pipeline to return fixed vectors for specific inputs to ensure test stability.
- **Threshold Assertions:** When testing search quality, use threshold-based assertions (e.g., `expect(score).toBeGreaterThan(0.8)`) rather than exact matches.
- **Integration Tests:** Use a temporary PGlite instance (fresh directory) for every integration test run to ensure isolation.

### 3. Anti-Overengineering Philosophy
- **Simple > Clever:** Prefer explicit loops and standard conditionals over complex functional abstractions or "magical" patterns.
- **No Framework Bloat:** Avoid adding heavy orchestration frameworks (like LangChain) unless the project evolves to multi-hop agentic logic. Keep the current thin layer.
- **Data over AI:** Focus on cleaning input data (stripping HTML, base64) and improving chunking boundaries rather than adding complex re-ranker layers prematurely.
- **Standard Library First:** Use Bun's built-in APIs (`Bun.serve`, `Bun.file`, `bun:test`) instead of adding redundant external dependencies.

## 🤖 Agent Operational Directives
When operating as an AI agent in this codebase:
1. **Validation First:** After any change, always rebuild and verify the logs for the `server is running in HOST:PORT` message.
2. **No Silent Failures:** Ensure all error paths are logged via `logger.error` with enough context (e.g., file paths, query strings).
3. **Surgical Updates:** Use the `replace` tool for targeted edits; do not overwrite entire files unless refactoring the core architecture.
4. **Tool Discovery:** If you add a new capability to `engine.ts`, you MUST also expose it as a tool in `mcp.ts`.
