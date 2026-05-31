# Architecture Overview

This project is a semantic document retrieval system that indexes markdown files and provides a search interface via the Model Context Protocol (MCP) or a standard HTTP API.

## Core Components

### 1. Vector Engine (`src/engine.ts`)
The heart of the system. It handles:
- **Embedding Generation**: Uses `@xenova/transformers` with the `all-MiniLM-L6-v2` model to generate 384-dimensional vectors locally.
- **Storage**: Uses `PGlite`, a WASM-powered Postgres build, with the `vector` extension.
- **Indexing**: Recursively scans the `docs/` directory, splits markdown files into sections based on headers, and stores them with their embeddings.
- **Search**: Performs cosine similarity search using the `<=>` operator.

### 2. MCP Server (`src/mcp.ts`)
The primary interface for AI models.
- Implements the [Model Context Protocol](https://modelcontextprotocol.io/).
- Exposes a tool called `semantic_markdown_search`.
- Communicates over standard input/output (stdio).

### 3. HTTP API Server (`src/api.ts`)
An optional interface for traditional web clients.
- Started by passing the `--api` flag.
- Exposes a `/search` POST endpoint on port 4321.

### 4. Logger (`src/logger.ts`)
- Uses `pino` for high-performance logging.
- Logs are persisted to `.logs/app.log`.

## System Workflow

1. **Initialization**: On startup, the `VectorEngine` is initialized, and the `PGlite` database is prepared.
2. **Indexing**: The engine scans the `docs/` folder and populates the vector database.
3. **Serving**: Depending on the start flags, either the MCP server or the HTTP API server starts listening for requests.
4. **Querying**: When a query is received, it is converted into an embedding, and a similarity search is performed against the indexed chunks.
