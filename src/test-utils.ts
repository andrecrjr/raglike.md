import { VectorEngine, type EngineMocks } from "./engine";

/**
 * Creates a mock embedding extractor that returns deterministic vectors based on text content.
 * This ensures that different texts have different embeddings, allowing semantic splitting to work.
 */
export const createMockExtractor = () => {
    return async (text: string | string[]) => {
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
            return text.map(getVector);
        }
        return getVector(text);
    };
};



/**
 * Creates a mock reranker model.
 */
export const createMockReranker = () => {
    return async () => ({
        logits: { data: [1.0] }
    });
};

/**
 * Creates a mock reranker tokenizer.
 */
export const createMockRerankerTokenizer = () => {
    return async () => ({});
};

/**
 * Returns a VectorEngine instance with mocked components for fast testing.
 */
export const getTestEngine = (dbPath = `memory://test-${process.pid}-${Math.random().toString(36).substring(7)}`) => {
    const mocks: EngineMocks = {
        extractor: createMockExtractor() as any,
        splitterExtractor: createMockExtractor() as any,
        rerankerModel: createMockReranker() as any,
        rerankerTokenizer: createMockRerankerTokenizer() as any,
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
