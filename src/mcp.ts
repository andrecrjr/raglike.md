import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { VectorEngine } from "./engine";
import { logger } from "./logger";

export function createMcpServer(engine: VectorEngine) {
	const server = new Server(
		{ name: "raglike-md", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: "semantic_markdown_search",
				description:
					"Searches through nested workspace markdown files using local pgvector embeddings and hybrid RRF search. Optionally reranks results using a cross-encoder for higher accuracy.",
				inputSchema: {
					type: "object",
					properties: {
						query: {
							type: "string",
							description: "The conceptual query text string.",
						},
						limit: {
							type: "number",
							default: 3,
							description: "Number of results to return.",
						},
						rerank: {
							type: "boolean",
							default: false,
							description:
								"Whether to perform a secondary reranking pass using a cross-encoder (higher accuracy, more latency).",
						},
						repository: {
							type: "string",
							description: "Optional repository ID to scope the search.",
						},
						hybrid: {
							type: "boolean",
							default: false,
							description:
								"Whether to perform hybrid search using Reciprocal Rank Fusion (RRF) combining vector and keyword searches (default: false).",
						},
					},
					required: ["query"],
				},
			},
			{
				name: "read_chunk_neighbors",
				description:
					"Fetches the text immediately preceding and following a specific chunk. Use this to get more context around a search result.",
				inputSchema: {
					type: "object",
					properties: {
						chunk_id: {
							type: "number",
							description:
								"The numeric ID of the chunk (obtained from search results).",
						},
					},
					required: ["chunk_id"],
				},
			},
			{
				name: "get_full_document",
				description:
					"Retrieves the full raw markdown content of a file. Use this after finding a relevant file via semantic search.",
				inputSchema: {
					type: "object",
					properties: {
						file_path: {
							type: "string",
							description:
								"The relative path to the markdown file (e.g., 'docs/architecture/overview.md').",
						},
					},
					required: ["file_path"],
				},
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		logger.info(
			{ tool: req.params.name, arguments: req.params.arguments },
			"MCP Tool call",
		);
		if (req.params.name === "semantic_markdown_search") {
			try {
				const query = String(req.params.arguments?.query || "");
				const limit = Number(req.params.arguments?.limit || 3);
				const rerank = Boolean(req.params.arguments?.rerank || false);
				const repository = req.params.arguments?.repository
					? String(req.params.arguments.repository)
					: undefined;
				const hybrid = Boolean(req.params.arguments?.hybrid || false);

				const matches = await engine.search(
					query,
					limit,
					rerank,
					repository,
					hybrid,
				);
				const output = matches
					.map((m) => {
						const scoreLabel = rerank
							? "Rerank Score"
							: hybrid
								? "RRF Score / Dist"
								: "Similarity / Dist";
						const scoreValue = rerank
							? (m.rerank_score ?? 0).toFixed(4)
							: `${(m.rrf_score ?? 0).toFixed(4)} / ${(m.distance ?? 0).toFixed(4)}`;
						const repoInfo = m.repository_id
							? ` Repo: \`${m.repository_id}\``
							: "";
						return `### ID: [${m.id}] File: \`${m.file_path}\`${repoInfo} > \`${m.heading}\` (${scoreLabel}: ${scoreValue})\n---\n${m.content}\n---\n`;
					})
					.join("\n");

				return { content: [{ type: "text", text: output }] };
			} catch (err) {
				logger.error(err, "MCP Search error");
				return {
					content: [
						{ type: "text", text: `Error during search: ${String(err)}` },
					],
					isError: true,
				};
			}
		}

		if (req.params.name === "read_chunk_neighbors") {
			const chunkId = Number(req.params.arguments?.chunk_id);
			const neighbors = await engine.getChunkNeighbors(chunkId);

			if (!neighbors) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Chunk with ID ${chunkId} not found.`,
						},
					],
					isError: true,
				};
			}

			let text = `Neighbors for Chunk [${chunkId}]:\n\n`;
			if (neighbors.previous) {
				text += `PREVIOUS CHUNK [${neighbors.previous.id}] (${neighbors.previous.heading}):\n---\n${neighbors.previous.content}\n---\n\n`;
			} else {
				text += `PREVIOUS CHUNK: (None - Beginning of file)\n\n`;
			}

			if (neighbors.next) {
				text += `NEXT CHUNK [${neighbors.next.id}] (${neighbors.next.heading}):\n---\n${neighbors.next.content}\n---\n`;
			} else {
				text += `NEXT CHUNK: (None - End of file)\n`;
			}

			return { content: [{ type: "text", text }] };
		}

		if (req.params.name === "get_full_document") {
			const filePath = String(req.params.arguments?.file_path || "");
			try {
				const content = await engine.readDocument(filePath);
				if (!content)
					return {
						content: [
							{ type: "text", text: `Error: File '${filePath}' not found.` },
						],
						isError: true,
					};
				return { content: [{ type: "text", text: content }] };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
				};
			}
		}

		throw new Error("Tool unexpected.");
	});

	return server;
}

export async function startMcpServer(engine: VectorEngine) {
	const server = createMcpServer(engine);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	logger.info("MCP Layer linked cleanly via standard IO streams.");
}
