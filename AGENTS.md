# raglike-md 🚀

High-performance local semantic search engine using Bun, PGlite, and Xenova Transformers.

## 🛠 Tech Stack
- **Runtime:** [Bun](https://bun.sh) (Default underlying runtime)
- **Containerization:** [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/) (Primary development/deployment focus)
- **Database:** [PGlite](https://pglite.dev/) (local WASM Postgres) or external Postgres with `pgvector`.
- **Embeddings:** `all-MiniLM-L6-v2` via `@xenova/transformers`.
- **API:** REST API and [Model Context Protocol (MCP)](https://modelcontextprotocol.io).
- **Logging:** [Pino](https://github.com/pinojs/pino).

## 🏗 Architecture
- **Engine (`src/engine.ts`):** Handles document crawling, chunking (sliding window ~600 chars), and embedding generation.
- **Search:** Hybrid search (Vector + Full-Text) using RRF (Reciprocal Rank Fusion).
- **HNSW:** Automatically enabled for performance.
- **API/MCP:** Interfaces defined in `src/api.ts` and `src/mcp.ts`.

## 🚀 Development Workflows

### Docker-First Workflow (Preferred)
The environment is managed via Docker Compose, ensuring consistency across deployments.

- **Start Stack (Engine + Postgres):**
  ```bash
  docker compose up -d
  ```
- **Rebuild Engine:**
  ```bash
  docker compose build raglike-md
  ```
- **View Logs:**
  ```bash
  docker compose logs -f raglike-md
  ```
- **Run Commands inside Container:**
  ```bash
  docker compose exec raglike-md bun test
  ```

### Local Development (Bun)
While Docker is focused, Bun is the default runtime for local scripts and testing.

- **Setup:** `bun install`
- **Run Engine:** `bun run src/index.ts --api --mcp`
- **Test:** `bun test`

### Environment Variables
- `POSTGRES_URL`: Connection string for external Postgres (e.g., `postgres://user:pass@db:5432/raglike`).
- `ENABLE_API`: `true` to enable REST.
- `ENABLE_MCP`: `true` to enable MCP.

## 📝 Conventions
- **TypeScript Expertise:** Write clean, type-safe, and idiomatic TypeScript. Avoid `any`, use explicit interfaces/types, and leverage modern language features.
- **SQL Standards:** Write well-formatted, performant, and secure SQL. Focus on proper indexing (like the existing pgvector HNSW usage), clear schema definitions, and efficient queries.
- **Logging:** Always use the logger from `src/logger.ts`.
- **Formatting:** Adhere to existing project styles; use Bun's built-in formatter/linter where possible.
- **Testing:** Add tests in `src/*.test.ts` for new engine features; ensure full coverage for critical logic.
- **Documentation:** Keep `docs/` updated with architecture changes.
