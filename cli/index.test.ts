import { beforeEach, describe, expect, type Mock, mock, test } from "bun:test";
import { compareAndUpload, discoverFiles } from "./index";

// Mocking fs and fetch
mock.module("node:fs", () => ({
	readdirSync: mock(),
	statSync: mock(),
	existsSync: mock(),
	readFileSync: mock(() => Buffer.from("dummy content")),
}));

describe("raglike-cli", () => {
	beforeEach(() => {
		// Reset mocks if needed
	});

	test("discoverFiles should find .md and .pdf files recursively", async () => {
		const { readdirSync, statSync } = await import("node:fs");

		(readdirSync as Mock).mockImplementation((path: string) => {
			if (path === "test-dir") return ["file1.md", "subdir"];
			if (path === "test-dir/subdir") return ["file2.pdf", "other.txt"];
			return [];
		});

		(statSync as Mock).mockImplementation((path: string) => ({
			isDirectory: () => path.endsWith("subdir"),
			isFile: () => !path.endsWith("subdir"),
			size: 100,
		}));

		const files = await discoverFiles("test-dir");
		expect(files).toHaveLength(2);
		expect(files.map((f) => f.path)).toContain("test-dir/file1.md");
		expect(files.map((f) => f.path)).toContain("test-dir/subdir/file2.pdf");
	});

	test("compareAndUpload should upload only new or changed files", async () => {
		const serverUrl = "http://localhost:4321";
		const token = "test-token";
		const localFiles = [
			{ path: "test-dir/file1.md", name: "file1.md", size: 100 },
			{ path: "test-dir/file2.md", name: "file2.md", size: 200 },
		];

		// Mock server response for /list-docs
		const mockListDocs = {
			success: true,
			docs: [
				{ name: "file1.md", size: 100 }, // Unchanged
				// file2.md is missing (new)
			],
		};

		global.fetch = mock((url) => {
			if (url.toString().endsWith("/list-docs")) {
				return Promise.resolve(new Response(JSON.stringify(mockListDocs)));
			}
			if (url.toString().endsWith("/upload")) {
				return Promise.resolve(new Response(JSON.stringify({ success: true })));
			}
			return Promise.resolve(new Response(null, { status: 404 }));
		}) as unknown as typeof fetch;

		const results = await compareAndUpload(serverUrl, token, localFiles);

		expect(results.uploaded).toContain("file2.md");
		expect(results.skipped).toContain("file1.md");

		// Check that fetch was called for upload
		const fetchCalls = (global.fetch as Mock).mock.calls;
		const uploadCalls = fetchCalls.filter((call) =>
			call[0].toString().endsWith("/upload"),
		);
		expect(uploadCalls).toHaveLength(1);
		expect(uploadCalls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
	});
});
