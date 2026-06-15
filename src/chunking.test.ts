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

describe("Markdown AST Chunking", () => {
	let engine: VectorEngine;
	const mockDocsDir = path.join(process.cwd(), "test-chunking-sandbox");

	beforeAll(async () => {
		engine = getTestEngine();
		await engine.initialize();
	}, 60000);

	afterAll(async () => {
		await engine.destroy();
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

	test("Should bundle code blocks with preceding paragraphs", async () => {
		const content = `
# API Guide

To use the API, initialize the client:

\`\`\`ts
const client = new API();
await client.connect();
\`\`\`

Then you can fetch data.
`;
		fs.writeFileSync(path.join(mockDocsDir, "code-bundle.md"), content);

		await engine.indexDirectory(mockDocsDir);

		// With structural chunking, these should be in the same chunk
		const results = await engine.search("initialize the client", 5);

		expect(results.length).toBeGreaterThan(0);
		const mainChunk = results.find((r) =>
			r.content.includes("initialize the client"),
		);
		expect(mainChunk).toBeDefined();
		expect(mainChunk?.content).toContain("const client = new API()");
	}, 30000);

	test("Should respect structural header boundaries", async () => {
		const content = `
# Main Header

## Section A
Content for section A.

## Section B
Content for section B.
`;
		fs.writeFileSync(path.join(mockDocsDir, "headers.md"), content);

		await engine.indexDirectory(mockDocsDir);

		const resultsA = await engine.search(
			"Content for section A",
			5,
			false,
			undefined,
			true,
		);
		const resultsB = await engine.search(
			"Content for section B",
			5,
			false,
			undefined,
			true,
		);

		expect(resultsA[0].heading).toBe("Main Header > Section A");
		expect(resultsB[0].heading).toBe("Main Header > Section B");

		// Ensure they are separate chunks
		expect(resultsA[0].id).not.toBe(resultsB[0].id);
	}, 30000);

	test("Should handle very large paragraphs without splitting code blocks", async () => {
		const longPara = "A ".repeat(1000);
		const codeBlock = `\`\`\`ts\n${"console.log('hello');\n".repeat(50)}\`\`\``;
		const content = `# Large Test\n\n${longPara}\n\n${codeBlock}`;

		fs.writeFileSync(path.join(mockDocsDir, "large.md"), content);
		await engine.indexDirectory(mockDocsDir);

		const results = await engine.search("Large Test", 10);

		// The code block should be preserved whole
		const codeChunk = results.find((r) =>
			r.content.includes("console.log('hello')"),
		);
		expect(codeChunk).toBeDefined();
		expect(codeChunk?.content).toContain("console.log('hello');");
		// Verify it wasn't truncated (at least checked by one of the repetitions)
		expect(codeChunk?.content.split("\n").length).toBeGreaterThan(50);
	}, 30000);

	test("Should preserve code blocks containing double newlines without breaking them in half", async () => {
		const content = `# Code Double Newline Test\n\nBefore code block.\n\n\`\`\`ts\nconst x = 5;\n\nconst y = 10;\n\`\`\`\n\nAfter code block.`;
		fs.writeFileSync(path.join(mockDocsDir, "double-newline-code.md"), content);

		await engine.indexDirectory(mockDocsDir);

		const results = await engine.search("const y = 10", 5);
		expect(results.length).toBeGreaterThan(0);

		const codeChunk = results.find((r) => r.content.includes("const x = 5"));
		expect(codeChunk).toBeDefined();
		expect(codeChunk?.content).toContain("const x = 5;\n\nconst y = 10;");
	}, 30000);
});
