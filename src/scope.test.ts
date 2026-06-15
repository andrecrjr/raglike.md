import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { VectorEngine } from "./engine";
import { getTestEngine, truncateTables } from "./test-utils";

describe("Search Scoping", () => {
	let engine: VectorEngine;
	const mockDocsDir = path.join(process.cwd(), "test-scope-sandbox");

	beforeAll(async () => {
		if (!fs.existsSync(mockDocsDir))
			fs.mkdirSync(mockDocsDir, { recursive: true });

		engine = getTestEngine();
		await engine.initialize();
	}, 60000);

	afterAll(async () => {
		await engine.destroy();
		if (fs.existsSync(mockDocsDir)) {
			fs.rmSync(mockDocsDir, { recursive: true, force: true });
		}
	});

	afterEach(async () => {
		await truncateTables(engine);
	});

	test("Should filter results by repository_id", async () => {
		const fileA = path.join(mockDocsDir, "repoA.md");
		const fileB = path.join(mockDocsDir, "repoB.md");

		fs.writeFileSync(fileA, "# Repo A\nThis is content from Repo A.");
		fs.writeFileSync(fileB, "# Repo B\nThis is content from Repo B.");

		await engine.indexSingleFile(fileA, "repo-a");
		await engine.indexSingleFile(fileB, "repo-b");

		const query = "content";

		// Search globally
		const globalResults = await engine.search(query, 10);
		expect(globalResults.length).toBe(2);

		// Search scoped to repo-a
		const scopedResultsA = await engine.search(query, 10, false, "repo-a");
		expect(scopedResultsA.length).toBe(1);
		expect(scopedResultsA[0].repository_id).toBe("repo-a");
		expect(scopedResultsA[0].content).toContain("Repo A");

		// Search scoped to repo-b
		const scopedResultsB = await engine.search(query, 10, false, "repo-b");
		expect(scopedResultsB.length).toBe(1);
		expect(scopedResultsB[0].repository_id).toBe("repo-b");
		expect(scopedResultsB[0].content).toContain("Repo B");
	}, 30000);
});
