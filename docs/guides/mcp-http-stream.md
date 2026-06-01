# Using MCP with HTTP Streams (SSE)

`raglike-md` supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) over HTTP using Server-Sent Events (SSE). This allows remote clients or web-based AI hosts to interact with the search engine as a stateful MCP server.

## Prerequisites

1.  **Start the server with Docker**:
    The easiest way to run the MCP server with HTTP/SSE enabled is via Docker.
    
    ```bash
    docker run -d \
      -p 4321:4321 \
      -e ENABLE_API=true \
      -e ENABLE_MCP=true \
      -v $(pwd)/docs:/app/docs \
      raglike-md
    ```

2.  **Verify the server is running**:
    The server will be accessible at `http://localhost:4321/mcp`.

---

## Communication Flow

The MCP HTTP transport is stateful and uses three primary actions:

1. **Establish Connection (SSE)**: `GET /mcp`
2. **Send Messages (JSON-RPC)**: `POST /mcp`
3. **Close Session**: `DELETE /mcp`

### 1. Establishing the SSE Stream

To start a session, the client must connect to the SSE endpoint. The server will assign a unique `sessionId` and send it as the first event.

**Request:**
```bash
curl -N http://localhost:4321/mcp
```

**Response (Stream):**
```text
event: endpoint
data: /mcp?sessionId=73a3c98d-6916-4b82-8929-798418043644
```

> **Note**: Subsequent `POST` and `DELETE` requests **must** include the `sessionId` in the query parameters to route messages to the correct session.

### 2. Sending JSON-RPC Messages

Once you have the `sessionId`, you can send standard MCP requests (like `list_tools` or `call_tool`) via a `POST` request.

#### Example: List Available Tools
**Request:**
```bash
curl -X POST "http://localhost:4321/mcp?sessionId=YOUR_SESSION_ID" \
     -H "Content-Type: application/json" \
     -d '{
       "jsonrpc": "2.0",
       "id": 1,
       "method": "tools/list",
       "params": {}
     }'
```

The response to this request will arrive **as an event in the SSE stream** opened in step 1, not as the HTTP response to the POST request.

**SSE Stream Output:**
```text
event: message
data: {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
```

#### Example: Semantic Search
**Request:**
```bash
curl -X POST "http://localhost:4321/mcp?sessionId=YOUR_SESSION_ID" \
     -H "Content-Type: application/json" \
     -d '{
       "jsonrpc": "2.0",
       "id": 2,
       "method": "tools/call",
       "params": {
         "name": "semantic_markdown_search",
         "arguments": {
           "query": "architecture overview",
           "limit": 1
         }
       }
     }'
```

### 3. Terminating the Session

To cleanly close the MCP session and release resources on the server:

**Request:**
```bash
curl -X DELETE "http://localhost:4321/mcp?sessionId=YOUR_SESSION_ID"
```

---

## Client Implementation Example (TypeScript)

If you are building a client using the `@modelcontextprotocol/sdk`, you can use the `SSEClientTransport`:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://localhost:4321/mcp"));
const client = new Client({ name: "my-client", version: "1.0.0" }, { capabilities: {} });

await client.connect(transport);

// Now you can call tools
const tools = await client.listTools();
console.log(tools);
```

## Troubleshooting

- **Session Not Found**: Ensure you are passing the correct `sessionId` returned by the initial `GET /mcp` request.
- **CORS Issues**: If accessing from a browser, ensure the server host allows the origin (currently defaults to `0.0.0.0`).
- **Connection Timeout**: SSE connections might be closed by proxies or load balancers if idle for too long. Implement a heartbeat/ping if necessary.
