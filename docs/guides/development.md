# Developer Guide

This guide details code conventions, testing standards, and local/containerized development workflows.

---

## 🛠️ Code Conventions & Standards

When writing TypeScript for this repository, you must adhere to the following standards:

### 1. TypeScript Strict Compliance
*   **No `any` Types**: `any` is forbidden. Use `unknown` for indeterminate types and resolve them using runtime type guards.
*   **Interfaces vs. Types**: Use `interface` for object structures and public APIs. Use `type` for unions, intersections, and primitives.
*   **Explicit Signatures**: Always type parameters, return values, and exports of public methods, helper utilities, and API endpoint handlers.
*   **Enums**: Avoid TypeScript `enum` due to runtime overhead. Use `const Object = { ... } as const` structures instead.

### 2. Resource Management
To ensure database handles and file descriptors are cleaned up deterministically, use the `using` keyword (Explicit Resource Management) when instantiating database handlers or connections:

```typescript
// Example: Using the async dispose pattern
await using engine = new VectorEngine(tempDbDir);
await engine.initialize();
```

### 3. Biome Linting & Formatting
We use **Biome** for linting and formatting. Run the linter before submitting changes:
```bash
# Lint checks
bunx biome lint .

# Auto-format and organize imports
bunx biome check --write .
```

---

## 🧪 Testing Guidelines

A feature is not considered complete without a corresponding `src/*.test.ts` file.

### 1. Running Tests (Docker-First)
To run the test suite inside the container environment:
```bash
docker compose exec raglike-md bun test
```

### 2. Integration Test Isolation
Each integration test should run against a temporary database instance (fresh directory path) to ensure test isolation:
```typescript
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDbDir = join(tmpdir(), `raglike-test-${Date.now()}`);
const engine = new VectorEngine(tempDbDir);
```

### 3. Mocking Embeddings
Avoid calling live neural networks or external API gateways during unit tests. Mock the embedding functions to return predefined vectors for test stability:
```typescript
const mockExtractor = async (text: string | string[]) => {
  return { data: new Float32Array(768).fill(0.1) };
};
```

### 4. Threshold Assertions
When verifying search quality or scores, use threshold-based assertions (e.g. `toBeGreaterThan`) rather than exact matching to prevent brittle failures as models evolve:
```typescript
expect(results[0].distance).toBeLessThan(0.5);
```

---

## ⚙️ Extending the MCP Layer

When exposing a new capability in `src/engine.ts`, you **must** expose it as a tool in `src/mcp.ts` as well:

1.  **Define the tool schema** in `src/mcp.ts` inside the `ListToolsRequestSchema` handler:
    ```typescript
    {
      name: "my_new_tool",
      description: "Detailed description of the new capability",
      inputSchema: {
        type: "object",
        properties: {
          param1: { type: "string", description: "Parameter description" }
        },
        required: ["param1"]
      }
    }
    ```
2.  **Add the execution logic** in `src/mcp.ts` inside the `CallToolRequestSchema` handler:
    ```typescript
    if (req.params.name === "my_new_tool") {
      const param1 = String(req.params.arguments?.param1 || "");
      const result = await engine.doSomething(param1);
      return { content: [{ type: "text", text: result }] };
    }
    ```
