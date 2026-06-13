import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { VectorEngine } from "./engine";
import { getTestEngine, truncateTables } from "./test-utils";

describe("PGlite Vector Search Engine Core", () => {
	let engine: VectorEngine;
	const mockDocsDir = path.join(process.cwd(), "test-docs-sandbox");

	beforeAll(async () => {
		engine = getTestEngine();
		await engine.initialize();
	}, 60000);

	afterAll(async () => {
		if (engine) await engine.destroy();
	}, 10000);

	beforeEach(async () => {
		if (!fs.existsSync(mockDocsDir))
			fs.mkdirSync(mockDocsDir, { recursive: true });
	});

	afterEach(async () => {
		if (engine) {
			await truncateTables(engine);
		}
		if (fs.existsSync(mockDocsDir)) {
			fs.rmSync(mockDocsDir, { recursive: true, force: true });
		}
	});


	test("Should recursively ingest nested folder layers and retrieve items semantically", async () => {
		const nestedDir = path.join(mockDocsDir, "a", "b", "c");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(
			path.join(nestedDir, "deep.md"),
			"# Deep Content\nThis is a very deep document about specialized quantum computing topics.",
		);

		await engine.indexDirectory(mockDocsDir);

		const matches = await engine.search("quantum computing", 1);
		expect(matches.length).toBe(1);
		expect(matches[0].heading).toBe("Deep Content");
		expect(matches[0].file_path).toContain("deep.md");
	}, 30000);

	test("Should split sections into multiple granular chunks with context awareness", async () => {
		const longSection = `# Section One\n\n${"This is a paragraph about quantum physics and entanglement. ".repeat(
			20,
		)}\n\n${"On the other hand, the history of medieval architecture in France is quite fascinating. ".repeat(20)}`;
		fs.writeFileSync(path.join(mockDocsDir, "long.md"), longSection);

		await engine.indexDirectory(mockDocsDir);

		// We expect at least 2 chunks due to length and topic shift
		const matches = await engine.search("quantum physics", 5);
		expect(matches.length).toBeGreaterThanOrEqual(1);

		const allChunks = await engine.query("SELECT * FROM markdown_chunks", []);
		expect(allChunks.rows.length).toBeGreaterThanOrEqual(2);
	}, 30000);

	test("Should retrieve chunk neighbors correctly", async () => {
		fs.writeFileSync(
			path.join(mockDocsDir, "neighbors.md"),
			"# Root\n\n## Section A\nThis is part A content.\n\n## Section B\nThis is part B content.\n\n## Section C\nThis is part C content.",
		);

		await engine.indexDirectory(mockDocsDir);

		// Get all chunks to be sure we have them
		const all = await engine.query<{id: any, heading: string}>("SELECT id, heading FROM markdown_chunks ORDER BY id ASC", []);
		console.log("Indexed chunks:", all.rows.map(r => `${r.id}: ${r.heading}`));
		
		const sectionB = all.rows.find(r => r.heading.includes("Section B"));
		expect(sectionB).toBeDefined();
		const chunkId = Number(sectionB!.id);

		const neighbors = await engine.getChunkNeighbors(chunkId);

		expect(neighbors).not.toBeNull();
		expect(neighbors?.previous).not.toBeNull();
		expect(neighbors?.next).not.toBeNull();
		
		expect(neighbors?.previous?.heading).toContain("Section A");
		expect(neighbors?.next?.heading).toContain("Section C");
	}, 30000);


	test("Should filter out base64 image data during ingestion", async () => {
		const base64Content =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
		fs.writeFileSync(
			path.join(mockDocsDir, "base64.md"),
			`# Image Test\n\n![Alt text](data:image/png;base64,${base64Content})\n\n<img src="data:image/png;base64,${base64Content}" />\n\nThis text should be indexed.`,
		);

		await engine.indexDirectory(mockDocsDir);

		const matches = await engine.search("indexed", 1);
		expect(matches.length).toBeGreaterThanOrEqual(1);
		expect(matches[0].content).not.toContain(base64Content);
		expect(matches[0].content).not.toContain("data:image/png;base64");
		expect(matches[0].content).toContain("This text should be indexed.");
	}, 30000);

	test("Should prioritize keyword matches in headings (Weighted Search)", async () => {
		fs.writeFileSync(
			path.join(mockDocsDir, "weighted1.md"),
			"# UniqueTitleKeyword\nThis is some filler content.",
		);
		fs.writeFileSync(
			path.join(mockDocsDir, "weighted2.md"),
			"# Other Section\nThis section contains the UniqueTitleKeyword in its content but not its heading.",
		);

		await engine.indexDirectory(mockDocsDir);

		// Keyword in heading (Weight A) should rank higher than content (Weight B)
		const matches = await engine.search("UniqueTitleKeyword", 2);
		expect(matches.length).toBe(2);
		expect(matches[0].heading).toBe("UniqueTitleKeyword");
	}, 30000);


	test("Should apply cross-encoder reranking and return rerank_score", async () => {
		fs.writeFileSync(
			path.join(mockDocsDir, "rerank.md"),
			"# Protocol\nHandle SSE connection with heartbeats.\n\n# Other\nRandom content about cats.",
		);

		await engine.indexDirectory(mockDocsDir);

		const results = await engine.search(
			"How to handle SSE connections?",
			2,
			true,
		);
		expect(results[0].rerank_score).toBeDefined();
		expect(results[0].rerank_score).toBeGreaterThan(
			results[1].rerank_score || 0,
		);
	}, 60000);
});
