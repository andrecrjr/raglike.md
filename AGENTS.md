# raglike-md 🚀

High-performance local semantic search engine using Bun, PGlite, and Xenova Transformers. This file serves as the primary technical guide for both human developers and AI agents.

- You must use only docker.
- You must use biome lint to check if code is correct always for each file you use.
- You are a senior perfect typescript developer, avoid `any` at all costs.

## Tech Stack
- **Runtime:** [Bun](https://bun.sh) (Default underlying runtime)
- **Containerization:** [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/) (Primary development/deployment focus)
- **Database:** [PGlite](https://pglite.dev/) (local WASM Postgres) or external Postgres with `pgvector`.
- **Embeddings:** `all-mpnet-base-v2` (768-dimensional) via `@xenova/transformers`.
- **API:** REST API and [Model Context Protocol (MCP)](https://modelcontextprotocol.io).
- **Logging:** [Pino](https://github.com/pinojs/pino).

## Engine & Search Logic

### 1. Models
- **Embeddings:** `Xenova/all-mpnet-base-v2` (768-dimensional) or external API via `API_EMBEDDING_URL`.
- **Metric:** Cosine Similarity (`vector_cosine_ops` in pgvector).
- **Reranking:** `Xenova/bge-reranker-base` (Cross-Encoder).

### 2. Search Strategy (Two-Stage Retrieval)
`raglike-md` uses a sophisticated two-stage search pipeline to ensure both speed and precision:

1.  **Stage 1: Hybrid Retrieval (4-way RRF)**
    - Combines four distinct signals using **Reciprocal Rank Fusion (RRF)** (Enabled by default):
        - **Vector Search (1.0)**: Semantic similarity using `all-mpnet-base-v2`.
        - **English Text Search (1.2)**: Keyword matching with stemming and stop-words.
        - **Simple Text Search (1.5)**: Literal keyword matching (no stemming) to preserve technical terms.
        - **Heading Literal Match (5.0)**: Strong boost for queries appearing directly in document headings. Now supports flexible word-based matching for better resilience to phrasing and typos.
    - Parameters: `k = 60`, `recall_limit = 100+`.


2.  **Stage 2: Cross-Encoder Reranking (Optional)**
    - For high-precision requirements, the engine can rerank the top candidates from Stage 1.
    - The Cross-Encoder processes the query and document content together to produce a high-fidelity relevance score.
    - **Usage:** Toggle via the `rerank` parameter in MCP or REST API.
    - **Performance Note:** Reranking increases latency significantly (5x-10x) as it processes ~50 candidates through a transformer on the CPU.

### 3. Chunking Strategy
- **Type:** Hierarchical Markdown-aware chunking.
- **Size:** Sliding window of ~1000 characters.
- **Overlap:** ~250 characters to preserve cross-chunk context.
- **Minimum Length:** Chunks shorter than 20 characters are filtered as noise.
- **Context Slop:** Chunks are enriched with "Context Slop" (breadcrumbs and sentences from adjacent chunks) to provide the LLM with immediate surroundings without fetching neighbors.

## MCP (Tool Usage Examples)

The `raglike-md` server provides a set of tools to help AI agents navigate and understand your documentation.

### 1. Conceptual Research (with Reranking)
**Tool:** `semantic_markdown_search`
**Goal:** Find precise information with high confidence using the cross-encoder.
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

### 2. REST API Usage (CURL)
**Endpoint:** `POST /search`
**Payload:**
```bash
curl -X POST http://localhost:4321/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "how the protocol handles SSE",
    "limit": 3,
    "rerank": true
  }'
```

### 3. Context Expansion
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

### 4. Full Document Retrieval
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
- **API (`src/api.ts`):** Bun-native HTTP server hosting REST endpoints and SSE-based MCP. Handles file uploads to `.docs-ingested/`.
- **MCP (`src/mcp.ts`):** Tool definitions and logic for Model Context Protocol integration.

## 📁 Storage Folders
- `docs/`: Standard workspace documentation (committed to version control).
- `.docs-ingested/`: Documents uploaded via the frontend (git-ignored).
- `.db/`: Persistent PGlite database storage.

## 🚀 Development Workflows

### Docker-First Workflow (ALWAYS Preferred)
- **Start Stack:** `docker compose up -d`
- **Rebuild & Restart:** `docker compose build raglike-md && docker compose up -d raglike-md`
- **In-Container Testing:** `docker compose exec raglike-md bun test`

### 🪵 Logging & Observability
- **Container Logs (STDOUT):** `docker compose logs -f raglike-md`
- **Persistent App Logs:** `docker compose exec raglike-md cat .logs/app.log`
- **Real-time App Logs:** `docker compose exec raglike-md tail -f .logs/app.log`
- **Search Troubleshooting:** Look for `Performing search` and `Initial search results found` entries in `app.log`.

### Local Development (Bun)
- **Setup:** `bun install`
- **Run:** `bun run src/index.ts --api --mcp`

## Conventions & Excellence (must use)

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
