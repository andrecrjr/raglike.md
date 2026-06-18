import type { EngineMocks } from "./engine";
import { VectorEngine } from "./engine";
import type { Extractor, RerankerModel, RerankerTokenizer } from "./models";

/**
 * Creates a mock embedding extractor that returns deterministic vectors based on text content.
 * This ensures that different texts have different embeddings, allowing semantic splitting to work.
 */
export const createMockExtractor = (): Extractor => {
	return (async (text: string | string[]) => {
		const getVector = (t: string) => {
			const vec = new Float32Array(768).fill(0);
			// Simple hash to differentiate vectors
			let hash = 0;
			for (let i = 0; i < t.length; i++) {
				hash = (hash << 5) - hash + t.charCodeAt(i);
				hash |= 0;
			}

			// Fill vector with hash-based values
			for (let i = 0; i < 768; i++) {
				vec[i] = ((hash + i) % 100) / 1000;
			}

			// Normalize vector
			let norm = 0;
			for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
			norm = Math.sqrt(norm);
			for (let i = 0; i < 768; i++) vec[i] /= norm;

			return { data: vec };
		};

		if (Array.isArray(text)) {
			const vectors = text.map(getVector);
			const combinedData = new Float32Array(vectors.length * 768);
			for (let i = 0; i < vectors.length; i++) {
				combinedData.set(vectors[i].data, i * 768);
			}
			return { data: combinedData };
		}
		return getVector(text);
	}) as Extractor;
};

/**
 * Creates a mock reranker model.
 */
export const createMockReranker = (): RerankerModel => {
	return (async () => ({
		logits: { data: [1.0] },
	})) as RerankerModel;
};

/**
 * Creates a mock reranker tokenizer.
 */
export const createMockRerankerTokenizer = (): RerankerTokenizer => {
	return (async () => ({})) as unknown as RerankerTokenizer;
};

/**
 * Returns a VectorEngine instance with mocked components for fast testing.
 */
export const getTestEngine = (
	dbPath = `memory://test-${process.pid}-${Math.random().toString(36).substring(7)}`,
) => {
	const mocks: EngineMocks = {
		extractor: createMockExtractor(),
		splitterExtractor: createMockExtractor(),
		rerankerModel: createMockReranker(),
		rerankerTokenizer: createMockRerankerTokenizer(),
	};
	return new VectorEngine(dbPath, mocks);
};

/**
 * Truncates all tables in the database to provide a clean slate between tests.
 * Optimized with session_replication_role for speed and to avoid FK issues.
 */
export const truncateTables = async (engine: VectorEngine) => {
	await engine.exec("SET session_replication_role = replica;");
	await engine.exec("TRUNCATE TABLE markdown_chunks RESTART IDENTITY CASCADE;");
	await engine.exec("SET session_replication_role = origin;");
};
