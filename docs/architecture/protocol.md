# Search Protocol

`raglike-md` provides two primary interfaces for semantic search and document retrieval.

## 1. Model Context Protocol (MCP)
The preferred interface for AI agents.

### Transports
- **Stdio**: Used when running via CLI (e.g., in Claude Desktop).
- **HTTP (SSE)**: Available at `/mcp` when the API server is running. This implements the **Streamable HTTP** specification.

### Tools
- **`semantic_markdown_search`**:
    - **Description**: Conceptual search across the workspace using a two-stage retrieval strategy.
    - **Input**: `{ "query": string, "limit": number, "rerank": boolean }`
    - **Output**: Returns a formatted list of granular paragraph chunks, including the file path, heading, and relevance score (Distance or Rerank Score).
- **`read_chunk_neighbors`**:
    - **Description**: Fetches the text immediately preceding and following a specific chunk.
    - **Input**: `{ "chunk_id": number }`
    - **Output**: Returns the previous and next chunks if they exist.
- **`get_full_document`**:
    - **Description**: Retrieves the raw markdown content of a file. Use this after finding a relevant file via search.
    - **Input**: `{ "file_path": string }`
    - **Output**: The complete raw content of the Markdown file.

---

## 2. HTTP REST API
A standard interface for web clients and external tools.

### Endpoints

#### `ALL /mcp`
Unified MCP-over-HTTP endpoint (Streamable HTTP).
- **GET**: Establish an SSE event stream connection.
- **POST**: Send JSON-RPC messages.
- **DELETE**: Terminate the session.

#### `GET /list-docs`
Lists all indexed documents.
- **Response**: `{ "success": true, "docs": [ { "name": string, "path": string, "lastModified": date, "size": number } ] }`

#### `POST /search`
Conceptual search returning granular results.
- **Payload**: `{ "query": string, "limit": number, "rerank": boolean }`
- **Response**:
  ```json
  {
    "success": true,
    "results": [
      {
        "id": "number",
        "file_path": "docs/architecture/vector-engine.md",
        "heading": "## Persistence",
        "content": "...",
        "distance": 0.4215,
        "rerank_score": 0.8912
      }
    ]
  }
  ```
  *Note: `rerank_score` is only present when `rerank: true` is requested.*

#### `GET /read`
Full document retrieval.
- **Query Parameters**: `path` (relative path to the markdown file).
- **Response**: `{ "success": true, "content": string }`

#### `POST /upload`
Upload and index a `.md` or `.pdf` file.
- **Payload**: `multipart/form-data` with a `file` field.
- **Response**: `{ "success": true, "path": string }`

#### `DELETE /doc`
Remove a document.
- **Query Parameters**: `path`.
- **Response**: `{ "success": true }`
