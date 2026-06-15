# Server Modes

`raglike-md` can run in two operational modes depending on how you intend to consume its search tools and endpoints. Both modes run on top of the same `VectorEngine` layer and share the same database.

---

## 1. MCP Mode (Default / Stdio)

This mode is designed for native desktop or terminal integrations where the AI client spawns the `raglike-md` process directly.

*   **Transport**: Standard Input/Output (`stdio`).
*   **Protocol**: JSON-RPC based Model Context Protocol (MCP).
*   **Security**: Runs within the boundary of the host operating system. The client controls the process lifecycle.
*   **Usage**:
    ```bash
    bun start
    ```

In this mode, standard logs go to stderr to prevent polluting the JSON-RPC communication on stdout.

---

## 2. HTTP API Mode (Unified)

In this mode, `raglike-md` starts a Bun-native web server that hosts REST API endpoints, an SSE-based MCP gateway, and a clean web-based search dashboard.

*   **Transport**: HTTP/TCP.
*   **Port**: `4321` (configurable via `PORT`).
*   **Usage**:
    ```bash
    bun start --api
    ```

### Exposed Services:

1.  **Stateful MCP SSE Gateway (`/mcp`)**: Allows IDEs like Cursor or Roo Code to connect remotely to the server over Server-Sent Events.
2.  **Web Search Dashboard (`/` or `/index.html`)**: A simple, interactive user interface served to search, upload, index, or delete documents.
3.  **REST Endpoints**: Programmatic endpoints for document discovery (`/list-docs`), retrieval (`/read`), custom embeddings (`/api/v1/embeddings`), and git push synchronizations (`/api/v1/sync/webhook`).

### Security & Authentication:

If the `API_TOKEN` environment variable is defined:
*   All requests (except webhook verification and root page/assets) must supply the token in the request headers: `Authorization: Bearer <token>`.
*   If the token is set, it is automatically injected into the frontend `index.html` file template on serve so the web interface can communicate with the endpoints out-of-the-box.
*   Webhook endpoints bypass bearer token verification and instead perform HMAC-SHA256 signature checks (GitHub) or plain token checks (GitLab) against the `WEBHOOK_SECRET` environment variable.

---

## 🏛 Database Persistence & Sync

Regardless of the selected mode, both interfaces hook into the unified `VectorEngine`:
*   **Shared State**: Both modes query and mutate the same SQLite/PGlite database files in `./.db` (or external database if `POSTGRES_URL` is set).
*   **Cold Starts**: The engine checks the database on startup. If data is present, it skips auto-indexing the `docs/` folder, ensuring fast boot times.
*   **Dynamic Indexing**: Uploads or deletes processed in HTTP API mode immediately update the database and become queryable by active MCP sessions in real-time.
