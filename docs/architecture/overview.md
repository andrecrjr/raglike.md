# Architecture Overview

This project is a semantic document retrieval system that indexes markdown files and provides a search interface via the Model Context Protocol (MCP) or a standard HTTP API.

## Core Components

### 1. Vector Engine (`src/engine.ts`)
The heart of the system. It handles:
- **Dual Database Support**: Automatically switches between local **PGlite** (with disk persistence in `./.db`) and external **Postgres** (via `POSTGRES_URL`).
- **Smart Chunking**: Splits documents by headers and then into overlapping chunks (~600 chars) to preserve context. Each chunk is indexed with its hierarchical context (H1 > Heading).
- **Embedding Generation**: Uses `@xenova/transformers` with the `all-mpnet-base-v2` model to generate 768-dimensional vectors locally.
- **Hybrid Search**: Combines semantic similarity (pgvector) with keyword ranking (tsvector) for precise results.
- **Cross-Encoder Reranking**: Optional second-stage retrieval using `bge-reranker-base` to refine search results for maximum accuracy.

### 2. MCP Server (`src/mcp.ts`)
The primary interface for AI models.
- Implements the [Model Context Protocol](https://modelcontextprotocol.io/).
- **Tools**:
    - `semantic_markdown_search`: Returns granular document chunks using hybrid ranking.
    - `get_full_document`: Retrieves raw raw markdown content for full context.


### 3. HTTP API Server (`src/api.ts`)
An optional interface for traditional web clients.
- **Endpoints**:
    - `POST /search`: Conceptual search returning granular chunks.
    - `GET /read?path=...`: Full document retrieval.

## System Workflow

1. **Initialization**: On startup, the `VectorEngine` detects its environment (Docker, External URL, or Local) and initializes the appropriate database connection.
2. **Persistence Check**: The engine checks if data already exists. If the database is populated, it skips the expensive re-indexing phase.
3. **Indexing (Optional)**: If empty, the engine recursively scans the `docs/` folder, chunks the files into paragraphs, and populates the database.
4. **Querying**: When a query is received, it is converted into an embedding, and a similarity search is performed. The user can then fetch the full file path returned by the search for deeper context.
