import {
	AutoModelForSequenceClassification,
	AutoTokenizer,
	pipeline,
} from "@huggingface/transformers";
import { logger } from "./logger";

export interface TransformerOutput {
	data: Float32Array;
}

export type Extractor = (
	text: string | string[],
	options?: { pooling?: string; normalize?: boolean; dtype?: string },
) => Promise<TransformerOutput | TransformerOutput[]>;

export type RerankerModel = (
	inputs: Record<string, unknown>,
) => Promise<{ logits: { data: number[] } }>;

export type RerankerTokenizer = (
	queries: string[],
	options: {
		text_pair: string[];
		padding: boolean;
		truncation: boolean;
	},
) => Promise<Record<string, unknown>>;

export interface ModelMocks {
	extractor?: Extractor;
	splitterExtractor?: Extractor;
	rerankerModel?: RerankerModel;
	rerankerTokenizer?: RerankerTokenizer;
}

// Global cache for models to avoid redundant loading
const modelCache: {
	extractor?: Extractor;
	splitterExtractor?: Extractor;
	rerankerModel?: RerankerModel;
	rerankerTokenizer?: RerankerTokenizer;
} = {};

export class ModelManager {
	private extractor?: Extractor;
	private splitterExtractor?: Extractor;
	private rerankerModel?: RerankerModel;
	private rerankerTokenizer?: RerankerTokenizer;
	private modelName = "Xenova/all-mpnet-base-v2";

	constructor(private mocks: ModelMocks = {}) {}

	async initialize() {
		this.modelName = process.env.EMBEDDING_MODEL || "Xenova/all-mpnet-base-v2";

		// Use mocks if provided, otherwise load from cache or pipeline
		if (this.mocks.extractor) {
			this.extractor = this.mocks.extractor;
			logger.debug("Using mock extractor");
		} else if (modelCache.extractor) {
			this.extractor = modelCache.extractor;
			logger.debug("Using cached extractor");
		} else {
			logger.debug("Loading extractor from pipeline...");
			this.extractor = (await pipeline(
				"feature-extraction",
				this.modelName,
			)) as Extractor;
			modelCache.extractor = this.extractor;
		}

		if (this.mocks.splitterExtractor) {
			this.splitterExtractor = this.mocks.splitterExtractor;
			logger.debug("Using mock splitterExtractor");
		} else if (modelCache.splitterExtractor) {
			this.splitterExtractor = modelCache.splitterExtractor;
			logger.debug("Using cached splitterExtractor");
		} else {
			logger.debug("Loading splitterExtractor from pipeline...");
			this.splitterExtractor = (await pipeline(
				"feature-extraction",
				"Xenova/all-MiniLM-L6-v2",
				{ dtype: "q4" },
			)) as Extractor;
			modelCache.splitterExtractor = this.splitterExtractor;
		}

		if (this.mocks.rerankerModel) {
			this.rerankerModel = this.mocks.rerankerModel;
			logger.debug("Using mock rerankerModel");
		} else if (modelCache.rerankerModel) {
			this.rerankerModel = modelCache.rerankerModel;
			logger.debug("Using cached rerankerModel");
		} else {
			logger.debug("Loading rerankerModel from pretrained...");
			this.rerankerModel =
				(await AutoModelForSequenceClassification.from_pretrained(
					"Xenova/bge-reranker-base",
				)) as RerankerModel;
			modelCache.rerankerModel = this.rerankerModel;
		}

		if (this.mocks.rerankerTokenizer) {
			this.rerankerTokenizer = this.mocks.rerankerTokenizer;
			logger.debug("Using mock rerankerTokenizer");
		} else if (modelCache.rerankerTokenizer) {
			this.rerankerTokenizer = modelCache.rerankerTokenizer;
			logger.debug("Using cached rerankerTokenizer");
		} else {
			logger.debug("Loading rerankerTokenizer from pretrained...");
			this.rerankerTokenizer = (await AutoTokenizer.from_pretrained(
				"Xenova/bge-reranker-base",
			)) as RerankerTokenizer;
			modelCache.rerankerTokenizer = this.rerankerTokenizer;
		}

		if (!this.mocks.extractor) {
			logger.info(
				`Models loaded: ${this.modelName} (Embedding) & bge-reranker-base (Reranker)`,
			);
		}
	}

	get modelInfo() {
		return {
			model: this.modelName,
			isExternal: !!process.env.API_EMBEDDING_URL,
		};
	}

	async getEmbedding(text: string): Promise<number[]> {
		const apiUrl = process.env.API_EMBEDDING_URL;
		if (apiUrl) {
			const results = await this.fetchExternalEmbeddings([text], apiUrl);
			return results[0];
		}

		if (!this.extractor) throw new Error("Extractor not initialized.");
		const output = (await this.extractor(text, {
			pooling: "mean",
			normalize: true,
		})) as TransformerOutput;
		return Array.from(output.data);
	}

	async getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
		const apiUrl = process.env.API_EMBEDDING_URL;
		if (apiUrl) {
			return this.fetchExternalEmbeddings(texts, apiUrl);
		}

		if (!this.extractor) throw new Error("Extractor not initialized.");

		// Handle empty case
		if (texts.length === 0) return [];

		const output = await this.extractor(texts, {
			pooling: "mean",
			normalize: true,
		});

		return this.sliceBatchOutput(output as TransformerOutput, texts.length);
	}

	private async fetchExternalEmbeddings(
		texts: string[],
		url: string,
	): Promise<number[][]> {
		if (texts.length === 0) return [];

		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: process.env.API_EMBEDDING_TOKEN
						? `Bearer ${process.env.API_EMBEDDING_TOKEN}`
						: "",
				},
				body: JSON.stringify({ texts }),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`External embedding API failed: ${response.status} ${errorText}`,
				);
			}

			const result = (await response.json()) as { embeddings: number[][] };
			if (!result.embeddings || !Array.isArray(result.embeddings)) {
				throw new Error("Invalid response format from external embedding API");
			}

			return result.embeddings;
		} catch (error) {
			logger.error(
				{ error, url },
				"Failed to fetch embeddings from external API",
			);
			throw error;
		}
	}

	private sliceBatchOutput(
		output: TransformerOutput,
		batchSize: number,
	): number[][] {
		const data = output.data;
		if (batchSize === 0) return [];
		const dimension = data.length / batchSize;
		if (data.length % batchSize !== 0) {
			logger.error(
				{ dataLength: data.length, batchSize },
				"Embedding data length is not a multiple of batch size",
			);
		}
		const results: number[][] = [];

		for (let i = 0; i < batchSize; i++) {
			const start = i * dimension;
			const end = start + dimension;
			results.push(Array.from(data.slice(start, end)));
		}

		return results;
	}

	async getSplitterVectors(blocks: string[]): Promise<Float32Array[]> {
		const apiUrl = process.env.API_EMBEDDING_URL;
		const vectors: Float32Array[] = [];

		if (apiUrl) {
			const embeddings = await this.fetchExternalEmbeddings(blocks, apiUrl);
			return embeddings.map((v) => new Float32Array(v));
		}

		if (!this.splitterExtractor) {
			throw new Error("Splitter extractor not initialized.");
		}

		const output = await this.splitterExtractor(blocks, {
			pooling: "mean",
			normalize: true,
		});

		const data = (output as TransformerOutput).data;
		const dimension = data.length / blocks.length;
		for (let i = 0; i < blocks.length; i++) {
			vectors.push(data.slice(i * dimension, (i + 1) * dimension));
		}
		return vectors;
	}

	async rerank(
		query: string,
		passages: string[],
	): Promise<{ logits: { data: number[] } }> {
		if (!this.rerankerModel || !this.rerankerTokenizer) {
			throw new Error("Reranker not initialized.");
		}

		const queries = new Array(passages.length).fill(query);
		const inputs = await this.rerankerTokenizer(queries, {
			text_pair: passages,
			padding: true,
			truncation: true,
		});

		return await this.rerankerModel(inputs);
	}

	get hasReranker() {
		return !!this.rerankerModel && !!this.rerankerTokenizer;
	}
}
