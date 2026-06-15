import * as fs from "node:fs";
import * as path from "node:path";
import { startHttpServer } from "./api";
import { VectorEngine } from "./engine";
import { logger } from "./logger";
import { startMcpServer } from "./mcp";

const engine = new VectorEngine();
await engine.initialize();

// Ensure ingested docs directory exists
const ingestedDirectoryPath = path.join(process.cwd(), ".docs-ingested");
if (!fs.existsSync(ingestedDirectoryPath)) {
	fs.mkdirSync(ingestedDirectoryPath, { recursive: true });
	logger.info("Created .docs-ingested directory for uploaded documents.");
}

// Only ingest if the database is currently empty
if (!(await engine.hasData())) {
	logger.info(
		"Database is empty. Starting initial ingestion of workspace documents...",
	);
	const docsDirectoryPath = path.join(process.cwd(), "docs");

	// Index both standard docs and the ingested folder
	await engine.indexDirectory(docsDirectoryPath);
	await engine.indexDirectory(ingestedDirectoryPath);

	// Also index key root files
	const rootFiles = ["README.md", "todo.md"];
	for (const file of rootFiles) {
		const filePath = path.join(process.cwd(), file);
		if (fs.existsSync(filePath)) {
			await engine.indexSingleFile(filePath);
		}
	}
} else {
	logger.info(
		"Persistent database already contains data. Skipping auto-ingestion.",
	);
}

const includeApi =
	process.env.ENABLE_API === "true" || Bun.argv.includes("--api");
const includeMcp =
	process.env.ENABLE_MCP === "true" ||
	Bun.argv.includes("--mcp") ||
	(!includeApi && !process.env.ENABLE_API);

if (includeApi) {
	// HTTP server can now host both REST and MCP (via SSE)
	await startHttpServer(engine);
}

// Always start Stdio MCP if enabled, even if API is also running.
// This ensures compatibility with hosts like Claude Desktop.
if (includeMcp) {
	await startMcpServer(engine);
}

const shutdown = async (signal: string) => {
	logger.info(
		{ signal },
		"Received shutdown signal. Disposing engine connections...",
	);
	try {
		await engine.destroy();
		logger.info("Database engine connections closed gracefully.");
		process.exit(0);
	} catch (err) {
		logger.error(
			err,
			"Failed to close database engine connections during shutdown",
		);
		process.exit(1);
	}
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

logger.info("Application context fully stabilized and active.");
