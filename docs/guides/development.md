# Developer Guide

This guide explains how to extend and work with the codebase.

## How to add a new MCP Tool
To add a new tool to the MCP server, modify `src/mcp.ts`.

1. **Define the tool** in the `ListToolsRequestSchema` handler:
   ```typescript
   {
     name: "my_new_tool",
     description: "What this tool does",
     inputSchema: { ... }
   }
   ```

2. **Implement the logic** in the `CallToolRequestSchema` handler:
   ```typescript
   if (req.params.name === "my_new_tool") {
     // Your implementation here
   }
   ```

## How to use the Logger
The system uses `pino` for logging. Import it from `./logger`.

```typescript
import { logger } from "./logger";

logger.info("Informational message");
logger.error({ err }, "Something went wrong");
```

## How to query the Vector Engine manually
You can use the `search` method on the `VectorEngine` instance:

```typescript
const engine = new VectorEngine();
await engine.initialize();
const results = await engine.search("your query", 5);
```
