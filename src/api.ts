import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { VectorEngine } from "./engine";
import { GitManager } from "./git";
import { logger } from "./logger";
import { createMcpServer } from "./mcp";

interface DocInfo {
	name: string;
	path: string;
	lastModified: Date;
	size: number;
}

export async function startHttpServer(engine: VectorEngine) {
	const gitManager = new GitManager(engine);
	const includeMcp =
		process.env.ENABLE_MCP === "true" || Bun.argv.includes("--mcp");
	let mcpTransport: WebStandardStreamableHTTPServerTransport | undefined;

	if (includeMcp) {
		mcpTransport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
		});
		const mcpServer = createMcpServer(engine);
		await mcpServer.connect(mcpTransport);
		logger.info(
			"MCP Layer integrated into HTTP server via /mcp endpoint (Stateful SSE).",
		);
	}

	const server = Bun.serve({
		port: Number(process.env.PORT) || 4321,
		hostname: process.env.HOST || "0.0.0.0",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			logger.info(
				{ method: req.method, path: url.pathname },
				"Incoming request",
			);

			// Security: Bearer Token Auth
			const authToken = process.env.API_TOKEN;
			if (authToken) {
				const authHeader = req.headers.get("Authorization");
				const expectedHeader = `Bearer ${authToken}`;
				const isWebhook = url.pathname === "/api/v1/sync/webhook";
				const isRoot =
					req.method === "GET" &&
					(url.pathname === "/" ||
						url.pathname === "/index.html" ||
						url.pathname === "/favicon.ico");

				if (
					!isWebhook &&
					!isRoot &&
					(!authHeader || authHeader !== expectedHeader)
				) {
					return new Response("Unauthorized", { status: 401 });
				}
			}

			// Webhook Endpoint
			if (req.method === "POST" && url.pathname === "/api/v1/sync/webhook") {
				try {
					const signature =
						req.headers.get("x-hub-signature-256") ||
						req.headers.get("x-gitlab-token");
					const bodyText = await req.text();
					const secret = process.env.WEBHOOK_SECRET;

					if (secret && req.headers.has("x-hub-signature-256")) {
						const hmac = createHmac("sha256", secret);
						const digest = `sha256=${hmac.update(bodyText).digest("hex")}`;
						if (
							!signature ||
							signature.length !== digest.length ||
							!timingSafeEqual(Buffer.from(signature), Buffer.from(digest))
						) {
							return Response.json(
								{ error: "Invalid signature" },
								{ status: 401 },
							);
						}
					} else if (secret && req.headers.has("x-gitlab-token")) {
						if (signature !== secret) {
							return Response.json({ error: "Invalid token" }, { status: 401 });
						}
					}

					const payload = JSON.parse(bodyText);
					if (req.headers.get("x-github-event") === "push") {
						const repoUrl = payload.repository.clone_url;
						const repoId = payload.repository.full_name.replace("/", "-");
						gitManager
							.syncRepository(repoUrl, repoId)
							.catch((err) =>
								logger.error({ err, repoId }, "Async sync failed"),
							);
						return Response.json({ success: true, message: "Sync triggered" });
					}

					if (req.headers.get("x-gitlab-event") === "Push Hook") {
						const repoUrl = payload.project.git_http_url;
						const repoId = payload.project.path_with_namespace.replace(
							"/",
							"-",
						);
						gitManager
							.syncRepository(repoUrl, repoId)
							.catch((err) =>
								logger.error({ err, repoId }, "Async sync failed"),
							);
						return Response.json({ success: true, message: "Sync triggered" });
					}

					return Response.json({ error: "Unsupported event" }, { status: 400 });
				} catch (err) {
					logger.error(err, "Webhook processing error");
					return Response.json(
						{ error: "Internal server error" },
						{ status: 500 },
					);
				}
			}

			// MCP SSE endpoint
			if (includeMcp && mcpTransport && url.pathname === "/mcp") {
				return await mcpTransport.handleRequest(req);
			}

			// Root
			if (
				req.method === "GET" &&
				(url.pathname === "/" || url.pathname === "/index.html")
			) {
				const indexPath = path.join(process.cwd(), "index.html");
				let content = await Bun.file(indexPath).text();

				// Inject API_TOKEN if present for the frontend to use
				if (process.env.API_TOKEN) {
					content = content.replace(
						"<!-- AUTH_INJECTION -->",
						`<script>window.API_TOKEN = "${process.env.API_TOKEN}";</script>`,
					);
				}

				return new Response(content, {
					headers: { "Content-Type": "text/html" },
				});
			}

			// List Docs
			if (req.method === "GET" && url.pathname === "/list-docs") {
				try {
					const rootDirs = ["docs", ".docs-ingested"];
					const allDocs: DocInfo[] = [];
					for (const dirName of rootDirs) {
						const dirPath = path.join(process.cwd(), dirName);
						if (!fs.existsSync(dirPath)) continue;
						const entries = await readdir(dirPath, {
							recursive: true,
							withFileTypes: true,
						});
						const docs = await Promise.all(
							entries
								.filter(
									(e) =>
										e.isFile() &&
										(e.name.endsWith(".md") || e.name.endsWith(".pdf")),
								)
								.map(async (e) => {
									const relativePath = path
										.join(path.relative(dirPath, e.parentPath), e.name)
										.replace(/^\.\//, "");
									const stats = fs.statSync(path.join(e.parentPath, e.name));
									return {
										name: e.name,
										path: `${dirName}/${relativePath}`,
										lastModified: stats.mtime,
										size: stats.size,
									};
								}),
						);
						allDocs.push(...docs);
					}
					return Response.json({ success: true, docs: allDocs });
				} catch (err) {
					return Response.json({ error: String(err) }, { status: 500 });
				}
			}

			// Search
			if (req.method === "POST" && url.pathname === "/search") {
				try {
					const body = (await req.json()) as {
						query: string;
						limit?: number;
						rerank?: boolean;
						repository?: string;
						hybrid?: boolean;
					};
					const hybrid =
						body.hybrid !== undefined ? Boolean(body.hybrid) : true;
					const results = await engine.search(
						body.query,
						body.limit || 3,
						body.rerank || false,
						body.repository,
						hybrid,
					);
					return Response.json({ success: true, results });
				} catch (err) {
					logger.error(err, "Search error");
					return Response.json({ error: "Invalid request" }, { status: 400 });
				}
			}

			// Embeddings
			if (req.method === "POST" && url.pathname === "/api/v1/embeddings") {
				try {
					const body = (await req.json()) as { texts: string[] };
					if (!body.texts || !Array.isArray(body.texts)) {
						return Response.json(
							{ error: "Invalid request. 'texts' array is required." },
							{ status: 400 },
						);
					}
					const embeddings = await engine.getPublicEmbeddings(body.texts);
					return Response.json({ success: true, embeddings });
				} catch (err) {
					logger.error(err, "Embeddings generation error");
					return Response.json({ error: String(err) }, { status: 500 });
				}
			}

			// Upload
			if (req.method === "POST" && url.pathname === "/upload") {
				try {
					const formData = await req.formData();
					const file = formData.get("file") as File;
					if (!file)
						return Response.json({ error: "No file" }, { status: 400 });
					const buffer = await file.arrayBuffer();
					const targetDir = ".docs-ingested";
					if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir);

					const targetPath = path.join(targetDir, file.name);
					await Bun.write(targetPath, buffer);

					const finalPath = await engine.indexSingleFile(
						path.resolve(process.cwd(), targetPath),
					);
					return Response.json({
						success: true,
						path: finalPath || targetPath,
					});
				} catch (err) {
					logger.error(err, "Upload processing error");
					return Response.json({ error: String(err) }, { status: 500 });
				}
			}

			// Read Document
			if (req.method === "GET" && url.pathname === "/read") {
				try {
					const filePath = url.searchParams.get("path");
					if (!filePath)
						return Response.json({ error: "Missing path" }, { status: 400 });
					const content = await engine.readDocument(filePath);
					if (content === null)
						return Response.json({ error: "File not found" }, { status: 404 });
					return Response.json({ success: true, content });
				} catch (err) {
					return Response.json({ error: String(err) }, { status: 500 });
				}
			}

			// Delete Document
			if (req.method === "DELETE" && url.pathname === "/doc") {
				try {
					const filePath = url.searchParams.get("path");
					if (!filePath)
						return Response.json({ error: "Missing path" }, { status: 400 });
					const fullPath = path.resolve(process.cwd(), filePath);
					if (!fullPath.startsWith(process.cwd())) {
						return Response.json(
							{ error: "Security violation" },
							{ status: 403 },
						);
					}
					if (fs.existsSync(fullPath)) {
						fs.unlinkSync(fullPath);
					}
					await engine.removeDocument(filePath);
					return Response.json({ success: true });
				} catch (err) {
					return Response.json({ error: String(err) }, { status: 500 });
				}
			}

			return new Response("Not Found", { status: 404 });
		},
	});
	logger.info(`server is running in ${server.hostname}:${server.port}`);
}
