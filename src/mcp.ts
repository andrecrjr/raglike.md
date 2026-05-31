import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VectorEngine } from "./engine";
import { logger } from "./logger";

export async function startMcpServer(engine: VectorEngine) {
  const server = new Server(
    { name: "raglike-md", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: "semantic_markdown_search",
      description: "Searches through nested workspace markdown files using local pgvector embeddings.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The conceptual query text string." },
          limit: { type: "number", default: 3 }
        },
        required: ["query"]
      }
    }]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "semantic_markdown_search") throw new Error("Tool unexpected.");
    
    const query = String(req.params.arguments?.query || "");
    const limit = Number(req.params.arguments?.limit || 3);

    const matches = await engine.search(query, limit);
    const output = matches.map(m => `### File: \`${m.file_path}\` > \`${m.heading}\` (Score: ${m.distance.toFixed(4)})\n---\n${m.content}\n---\n`).join("\n");

    return { content: [{ type: "text", text: output }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP Layer linked cleanly via standard IO streams.");
}
