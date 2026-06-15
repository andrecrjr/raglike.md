import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { VectorEngine } from "./engine";
import { getTestEngine, truncateTables } from "./test-utils";

describe("Semantic Chunking", () => {
	let engine: VectorEngine;
	let mockDocsDir: string;

	beforeAll(async () => {
		mockDocsDir = path.join(os.tmpdir(), `raglike-semantic-test-${Date.now()}`);
		fs.mkdirSync(mockDocsDir, { recursive: true });

		engine = getTestEngine();
		await engine.initialize();
	}, 60000);

	afterAll(async () => {
		await engine.destroy();
		fs.rmSync(mockDocsDir, { recursive: true, force: true });
	});

	afterEach(async () => {
		await truncateTables(engine);
	});

	test("Should detect topic shifts within a single header section", async () => {
		const content = `
# Engineering Guide

## Systems Overview
Rust is a systems programming language that runs blazingly fast, prevents segfaults, and guarantees thread safety. 
It accomplishes these goals by being memory safe without using a garbage collector.
The ownership system is the core of Rust's unique approach to memory management.

On a different note, the recipe for a perfect chocolate cake involves high-quality cocoa powder and room temperature butter.
First, cream the butter and sugar until fluffy. Then, add the eggs one by one while whisking.
The secret to moisture is adding a splash of boiling water at the very end of the batter preparation.
`;
		const filePath = path.join(mockDocsDir, "topics.md");
		fs.writeFileSync(filePath, content);

		await engine.indexSingleFile(filePath);

		const relativePath = path.relative(process.cwd(), filePath);
		// We expect at least two chunks for "Systems Overview": one about Rust, one about Cake.
		const res = await engine.query<{ heading: string; content: string }>(
			"SELECT heading, content FROM markdown_chunks WHERE file_path = $1 AND heading = $2",
			[relativePath, "Engineering Guide > Systems Overview"],
		);

		console.log(`Found ${res.rows.length} chunks for Systems Overview`);

		// If semantic splitting works, it should split the Rust part from the Cake part.
		expect(res.rows.length).toBeGreaterThanOrEqual(2);

		const rustChunk = res.rows.find((r) =>
			r.content.toLowerCase().includes("rust"),
		);
		const cakeChunk = res.rows.find((r) =>
			r.content.toLowerCase().includes("cake"),
		);

		expect(rustChunk).toBeDefined();
		expect(cakeChunk).toBeDefined();

		// Ensure they are separate chunks
		expect(rustChunk?.content).not.toContain("chocolate cake");
		expect(cakeChunk?.content).not.toContain("programming language");
	}, 30000);

	test("Should handle very large documents with high speed", async () => {
		const longContent = Array(100)
			.fill(`
## Repeated Section
This is a sentence about RAG systems. It should be kept together.
However, this sentence about tropical fish represents a minor topic shift.
`)
			.join("\n");

		const filePath = path.join(mockDocsDir, "long.md");
		fs.writeFileSync(filePath, longContent);

		const start = Date.now();
		await engine.indexSingleFile(filePath);
		const end = Date.now();

		console.log(`Ingested long document in ${end - start}ms`);
		expect(end - start).toBeLessThan(30000); // 100 sections with semantic splitting should be fast
	}, 60000);
});
