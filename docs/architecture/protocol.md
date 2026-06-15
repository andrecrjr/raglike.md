# Search & API Protocol

`raglike-md` provides two primary interfaces: the Model Context Protocol (MCP) for AI tools and a standard REST API for traditional HTTP clients.

---

## 1. Model Context Protocol (MCP)

Exposes capabilities directly to AI assistants.

### Transports
*   **Stdio**: Standard Input/Output streams, typically used for local client integrations (e.g. Claude Desktop).
*   **HTTP (SSE)**: Stateful Server-Sent Events transport mounted at `/mcp` for remote or containerized clients (e.g. Cursor).

### Tools

#### 🛠️ `semantic_markdown_search`
Performs conceptual semantic search across all indexed files using a two-stage retrieval strategy.
*   **Arguments**:
    *   `query` (`string`, **required**): The search query text.
    *   `limit` (`number`, optional, default: `3`): Maximum number of matching chunks to return.
    *   `rerank` (`boolean`, optional, default: `false`): Run a secondary cross-encoder pass on candidate chunks for higher accuracy.
    *   `repository` (`string`, optional): Scope the search to a specific repository ID (e.g., `owner-repo`).
    *   `hybrid` (`boolean`, optional, default: `true`): Use Reciprocal Rank Fusion (RRF) to merge vector and keyword/heading search signals. Set to `false` for pure vector similarity.
*   **Response**: A list of structured chunks including document paths, headings, similarity scores, and text contents.

#### 🛠️ `read_chunk_neighbors`
Retrieves the logical sections immediately preceding and succeeding a specific chunk inside the original document. Useful when an AI agent needs to expand its context window.
*   **Arguments**:
    *   `chunk_id` (`number`, **required**): The numeric ID of the chunk to inspect.
*   **Response**: Contents of the previous and next chunks (if they exist).

#### 🛠️ `get_full_document`
Retrieves the complete, raw markdown content of a file.
*   **Arguments**:
    *   `file_path` (`string`, **required**): Relative file path (e.g., `docs/architecture/overview.md`).
*   **Response**: The raw content of the Markdown file.

---

## 2. HTTP REST API

Provides a programmatic REST interface. Requires bearer auth if `API_TOKEN` is configured.

### Endpoints

#### `ALL /mcp`
Unified SSE gateway for Model Context Protocol over HTTP.
*   **GET**: Initiates a stateful Server-Sent Events connection.
*   **POST**: Sends JSON-RPC messages (requires `sessionId` query parameter).
*   **DELETE**: Closes the active session (requires `sessionId` query parameter).

#### `GET /list-docs`
Lists all currently indexed files.
*   **Response**:
    ```json
    {
      "success": true,
      "docs": [
        {
          "name": "overview.md",
          "path": "docs/architecture/overview.md",
          "lastModified": "2026-06-15T18:00:00.000Z",
          "size": 2484
        }
      ]
    }
    ```

#### `POST /search`
Performs semantic/hybrid search over the knowledge base.
*   **Payload**:
    ```json
    {
      "query": "SSE connection details",
      "limit": 3,
      "rerank": true,
      "repository": "facebook-react",
      "hybrid": true
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "results": [
        {
          "id": 102,
          "file_path": ".repos/facebook-react/docs/sse.md",
          "heading": "## Connection Handling",
          "content": "SSE connection details go here...",
          "distance": 0.3541,
          "rerank_score": 0.9412,
          "repository_id": "facebook-react"
        }
      ]
    }
    ```

#### `POST /api/v1/embeddings`
Generates vector representations for a list of strings using the active embedding model.
*   **Payload**:
    ```json
    {
      "texts": [
        "First sentence to embed",
        "Second sentence to embed"
      ]
    }
    ```
*   **Response**:
    ```json
    {
      "success": true,
      "embeddings": [
        [0.012, -0.054, 0.103, "... 768 elements"],
        [-0.045, 0.089, -0.012, "... 768 elements"]
      ]
    }
    ```

#### `GET /read`
Retrieves the full content of an indexed document.
*   **Query Parameters**:
    *   `path` (**required**): Relative path to the file.
*   **Response**:
    ```json
    {
      "success": true,
      "content": "Raw markdown document contents..."
    }
    ```

#### `POST /upload`
Uploads and indexes a `.md` or `.pdf` document immediately.
*   **Payload**: `multipart/form-data` containing a `file` field.
*   **Response**:
    ```json
    {
      "success": true,
      "path": ".docs-ingested/my-document.md"
    }
    ```

#### `DELETE /doc`
Removes a document from both the local disk (if located in `.docs-ingested/`) and the vector database.
*   **Query Parameters**:
    *   `path` (**required**): The file path to remove.
*   **Response**:
    ```json
    {
      "success": true
    }
    ```

#### `POST /api/v1/sync/webhook`
GitHub and GitLab webhook receiver for zero-UI Git synchronization.
*   **Headers**:
    *   GitHub: `x-hub-signature-256` and `x-github-event: push`
    *   GitLab: `x-gitlab-token` and `x-gitlab-event: Push Hook`
*   **Response**:
    ```json
    {
      "success": true,
      "message": "Sync triggered"
    }
    ```
