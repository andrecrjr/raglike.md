import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type Mock,
	mock,
	test,
} from "bun:test";
import { getTestEngine } from "./test-utils";

describe("External Embedding API", () => {
	let originalEnv: typeof process.env;

	beforeEach(() => {
		originalEnv = { ...process.env };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	test("Should use external API when API_EMBEDDING_URL is set", async () => {
		process.env.API_EMBEDDING_URL = "http://mock-api.local/embeddings";
		process.env.API_EMBEDDING_TOKEN = "test-token";

		const mockEmbeddings = [new Array(768).fill(0.1)];

		global.fetch = mock(() => {
			return Promise.resolve(
				new Response(JSON.stringify({ embeddings: mockEmbeddings })),
			);
		}) as unknown as typeof fetch;

		const engine = getTestEngine();
		await engine.initialize();

		const results = await engine.getPublicEmbeddings(["test"]);
		expect(results).toEqual(mockEmbeddings);

		const fetchMock = global.fetch as Mock;
		expect(fetchMock.mock.calls[0][0]).toBe("http://mock-api.local/embeddings");

		const options = fetchMock.mock.calls[0][1] as RequestInit;
		expect(JSON.parse(options.body as string)).toEqual({ texts: ["test"] });
		const headers = options.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-token");
	});

	test("Should fallback to local when API_EMBEDDING_URL is NOT set", async () => {
		delete process.env.API_EMBEDDING_URL;

		const engine = getTestEngine();
		await engine.initialize();

		const results = await engine.getPublicEmbeddings(["test"]);
		expect(results).toHaveLength(1);
		expect(results[0]).toHaveLength(768);
	});
});
