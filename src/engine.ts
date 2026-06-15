import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import {
	AutoModelForSequenceClassification,
	AutoTokenizer,
	pipeline,
} from "@huggingface/transformers";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Content } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { toString as mdastToString } from "mdast-util-to-string";
import pdf2md from "pdf2md-ts";
import postgres from "postgres";
import { logger } from "./logger";

interface TransformerOutput {
	data: Float32Array;
}

type Extractor = (
	text: string | string[],
	options?: { pooling?: string; normalize?: boolean; dtype?: string },
) => Promise<TransformerOutput | TransformerOutput[]>;

type RerankerModel = (
	inputs: Record<string, unknown>,
) => Promise<{ logits: { data: number[] } }>;
type RerankerTokenizer = (
	queries: string[],
	options: {
		text_pair: string[];
		padding: boolean;
		truncation: boolean;
	},
) => Promise<Record<string, unknown>>;

export interface MarkdownChunk {
	id: string;
	file_path: string;
	heading: string;
	content: string;
	distance?: number;
	rrf_score?: number;
	rerank_score?: number;
	last_modified?: Date;
	word_count?: number;
	repository_id?: string;
	is_code?: boolean;
}

// Global cache for models to avoid redundant loading
const modelCache: {
	extractor?: Extractor;
	splitterExtractor?: Extractor;
	rerankerModel?: RerankerModel;
	rerankerTokenizer?: RerankerTokenizer;
} = {};

export interface EngineMocks {
	extractor?: Extractor;
	splitterExtractor?: Extractor;
	rerankerModel?: RerankerModel;
	rerankerTokenizer?: RerankerTokenizer;
}

export class VectorEngine {
	private pglite?: PGlite;
	private sql?: postgres.Sql<Record<string, never>>;
	private extractor?: Extractor;
	private splitterExtractor?: Extractor;
	private rerankerModel?: RerankerModel;
	private rerankerTokenizer?: RerankerTokenizer;
	private dbPathOverride?: string;
	private initialized = false;
	private initializing: Promise<void> | null = null;
	private mocks: EngineMocks = {};

	constructor(dbPath?: string, mocks: EngineMocks = {}) {
		this.dbPathOverride = dbPath;
		this.mocks = mocks;
	}

	async initialize() {
		if (this.initialized) return;
		if (this.initializing) return this.initializing;

		this.initializing = (async () => {
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
					"Xenova/all-mpnet-base-v2",
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
					"Models loaded: all-mpnet-base-v2 (Embedding) & bge-reranker-base (Reranker)",
				);
			}

			const dbUrl = process.env.POSTGRES_URL;
			const _isDocker = fs.existsSync("/.dockerenv");

			if (dbUrl) {
				this.sql = postgres(dbUrl);
				logger.info("External Postgres connection initialized.");
			} else {
				const dbPath =
					this.dbPathOverride || path.join(process.cwd(), "raglike_db");

				// Patch vector extension to handle Bun's file:// URL stringification in tests
				const patchedVector = {
					...vector,
					setup: async (pg: PGlite, emscriptenOpts: unknown) => {
						const result = await vector.setup(
							pg,
							emscriptenOpts as Parameters<typeof vector.setup>[1],
						);
						if (
							result.bundlePath instanceof URL &&
							result.bundlePath.protocol === "file:"
						) {
							// Use realpathSync to resolve any potential symlink issues and ensure plain path
							const plainPath = fs.realpathSync(
								fileURLToPath(result.bundlePath),
							);
							logger.debug(
								{ path: plainPath },
								"PGlite vector bundle resolved",
							);
							result.bundlePath = plainPath;
						}
						return result;
					},
				};

				this.pglite = await PGlite.create(dbPath, {
					extensions: { vector: patchedVector },
				});
				logger.info(
					{ path: dbPath },
					"Local PGlite Vector Engine persistent storage initialized.",
				);
			}

			await this.ensureSchema();
			this.initialized = true;
			this.initializing = null;
		})();

		return this.initializing;
	}

	/**
	 * Clean up resources (database connections, etc.)
	 */
	async destroy() {
		if (this.pglite) {
			await this.pglite.close();
			this.pglite = undefined;
		}
		if (this.sql) {
			await this.sql.end();
			this.sql = undefined;
		}
		this.initialized = false;
	}

	/**
	 * Support for 'using' keyword (Explicit Resource Management)
	 */
	async [Symbol.asyncDispose]() {
		await this.destroy();
	}

	private async ensureSchema() {
		await this.exec("CREATE EXTENSION IF NOT EXISTS vector;");
		try {
			await this.exec("SET hnsw.ef_search = 100;");
		} catch (e) {
			logger.warn(
				e,
				"Failed to set hnsw.ef_search. It might not be supported yet or the index is not loaded.",
			);
		}

		// Check if the table exists and if the embedding dimension matches
		const tableExists = await this.query<{ exists: boolean }>(
			"SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'markdown_chunks')",
			[],
		);

		if (tableExists.rows[0].exists) {
			const dimRes = await this.query<{ atttypmod: number }>(
				"SELECT atttypmod FROM pg_attribute WHERE attrelid = 'markdown_chunks'::regclass AND attname = 'embedding'",
				[],
			);
			if (dimRes.rows.length > 0 && dimRes.rows[0].atttypmod !== 768) {
				logger.warn(
					{ oldDim: dimRes.rows[0].atttypmod, newDim: 768 },
					"Vector dimension mismatch detected. Dropping table for re-ingestion.",
				);
				await this.exec("DROP TABLE markdown_chunks;");
			}
		}

		await this.exec(VectorEngine.SCHEMA);

		// Step 4: Add HNSW index for high-performance vector search with tuned parameters
		// We drop and recreate to ensure parameters like m and ef_construction are applied
		await this.exec("DROP INDEX IF EXISTS idx_markdown_chunks_embedding;");
		await this.exec(
			"CREATE INDEX idx_markdown_chunks_embedding ON markdown_chunks USING hnsw (embedding vector_ip_ops) WITH (m = 24, ef_construction = 100);",
		);

		// Ensure new columns exist for existing databases and update search_vector if needed
		try {
			await this.exec(
				"ALTER TABLE markdown_chunks ADD COLUMN IF NOT EXISTS last_modified TIMESTAMP;",
			);
			await this.exec(
				"ALTER TABLE markdown_chunks ADD COLUMN IF NOT EXISTS word_count INTEGER;",
			);
			await this.exec(
				"ALTER TABLE markdown_chunks ADD COLUMN IF NOT EXISTS repository_id TEXT;",
			);
			await this.exec(
				"ALTER TABLE markdown_chunks ADD COLUMN IF NOT EXISTS is_code BOOLEAN DEFAULT FALSE;",
			);

			// Check if we need to upgrade search_vector to weighted version
			// In PostgreSQL we can't easily ALTER a GENERATED column's expression,
			// so we drop and recreate if it's already there to ensure the new weights apply.
			try {
				await this.exec(
					"ALTER TABLE markdown_chunks DROP COLUMN IF EXISTS search_vector;",
				);
				await this.exec(
					"ALTER TABLE markdown_chunks DROP COLUMN IF EXISTS search_vector_simple;",
				);
			} catch (_e) {
				logger.debug(
					"search_vector columns did not exist or could not be dropped.",
				);
			}

			await this.exec(`
		ALTER TABLE markdown_chunks ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
		setweight(to_tsvector('english', coalesce(heading, '')), 'A') || 
		setweight(to_tsvector('english', coalesce(content, '')), 'B')
		) STORED;
		`);

			await this.exec(`
		ALTER TABLE markdown_chunks ADD COLUMN search_vector_simple tsvector GENERATED ALWAYS AS (
		setweight(to_tsvector('simple', coalesce(heading, '')), 'A') || 
		setweight(to_tsvector('simple', coalesce(content, '')), 'B')
		) STORED;
		`);
		} catch (_e) {
			logger.warn(
				"Could not update schema columns, they might already exist or the syntax is unsupported by this version.",
			);
		}

		// Add GIN index for full-text search (replacing GIST if it existed for better performance)
		await this.exec("DROP INDEX IF EXISTS idx_markdown_chunks_search_vector;");
		await this.exec(
			"CREATE INDEX idx_markdown_chunks_search_vector ON markdown_chunks USING GIN (search_vector);",
		);

		await this.exec(
			"DROP INDEX IF EXISTS idx_markdown_chunks_search_vector_simple;",
		);
		await this.exec(
			"CREATE INDEX idx_markdown_chunks_search_vector_simple ON markdown_chunks USING GIN (search_vector_simple);",
		);
		logger.info("Database subsystem fully ready and schema verified.");
	}

	static SCHEMA = `
    CREATE TABLE IF NOT EXISTS markdown_chunks (
      id BIGSERIAL PRIMARY KEY,
      file_path TEXT,
      heading TEXT,
      content TEXT,
      embedding vector(768),
      last_modified TIMESTAMP,
      word_count INTEGER,
      repository_id TEXT,
      is_code BOOLEAN DEFAULT FALSE,
      search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(heading, '')), 'A') || 
        setweight(to_tsvector('english', coalesce(content, '')), 'B')
      ) STORED,
      search_vector_simple tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(heading, '')), 'A') || 
        setweight(to_tsvector('simple', coalesce(content, '')), 'B')
      ) STORED
    );
  `;

	async exec(query: string): Promise<void> {
		if (this.pglite) {
			await this.pglite.exec(query);
		} else if (this.sql) {
			await this.sql.unsafe(query);
		} else {
			throw new Error("Engine not initialized.");
		}
	}

	async query<T extends Record<string, unknown>>(
		query: string,
		params: unknown[],
	): Promise<{ rows: T[] }> {
		if (this.pglite) {
			const res = await this.pglite.query<T>(query, params);
			return { rows: res.rows };
		}
		if (this.sql) {
			const rows = await this.sql.unsafe<T[]>(query, params);
			return { rows };
		}
		throw new Error("Engine not initialized.");
	}

	async indexDirectory(dirPath: string, repositoryId?: string) {
		const files = await this.discoverFiles(dirPath);
		for (const file of files) {
			await this.indexSingleFile(file, repositoryId);
		}
		logger.info(
			{ totalFiles: files.length },
			"Recursive workspace folder ingestion complete.",
		);
	}

	private async discoverFiles(dirPath: string): Promise<string[]> {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		const files: string[] = [];

		for (const entry of entries) {
			const res = path.resolve(dirPath, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || entry.name === "node_modules")
					continue;
				files.push(...(await this.discoverFiles(res)));
			} else if (entry.name.endsWith(".md") || entry.name.endsWith(".pdf")) {
				files.push(res);
			}
		}
		return files;
	}

	async indexSingleFile(
		filePath: string,
		repositoryId?: string,
	): Promise<string | undefined> {
		let content = "";
		let finalFilePath = filePath;

		if (filePath.endsWith(".pdf")) {
			logger.info({ file: filePath }, "Converting PDF to markdown...");
			try {
				const pdfBuffer = fs.readFileSync(filePath);
				const pdfData = await pdf2md(pdfBuffer);
				content = Array.isArray(pdfData) ? pdfData.join("\n") : pdfData;
				logger.info(
					{ file: filePath, contentLength: content.length },
					"PDF conversion successful.",
				);

				// Save converted markdown and remove original PDF
				finalFilePath = filePath.replace(/\.pdf$/i, ".md");
				fs.writeFileSync(finalFilePath, content);
				fs.unlinkSync(filePath);
				logger.info(
					{ pdf: filePath, md: finalFilePath },
					"PDF replaced with markdown on disk.",
				);
			} catch (error) {
				logger.error(
					{ file: filePath, error },
					"Failed to convert PDF to markdown.",
				);
				return;
			}
		} else {
			content = fs.readFileSync(filePath, "utf-8");
		}

		// Clean data: strip base64 images, markdown images, HTML images, and image links
		const cleanedContent = content
			.replace(/data:[^;]+;base64,[^)\s"']*/g, "[base64 image removed]")
			.replace(/!\[.*?\]\(.*?\)/g, "") // Remove Markdown images
			.replace(/<img.*?>/g, "") // Remove HTML image tags
			.replace(
				/\[.*?\]\(.*?\.(?:png|jpg|jpeg|gif|webp|svg|pdf)(?:\?.*?)?\)/gi,
				"",
			) // Remove links to images/pdfs
			.replace(/\n{3,}/g, "\n\n"); // Collapse multiple newlines

		if (cleanedContent.trim().length === 0) {
			logger.warn(
				{ file: filePath },
				"File is empty or conversion yielded no text. Skipping.",
			);
			return;
		}

		const relativePath = path.relative(process.cwd(), finalFilePath);
		const stats = fs.statSync(finalFilePath);

		// Remove old chunks for this file
		await this.query("DELETE FROM markdown_chunks WHERE file_path = $1", [
			relativePath,
		]);
		logger.info(
			{ file: relativePath },
			"Document chunks removed from database.",
		);

		// Step 1: Structural AST Split
		const sections = this.structuralSplit(cleanedContent);

		const allChunksToEmbed: { heading: string; text: string }[] = [];

		for (let i = 0; i < sections.length; i++) {
			const section = sections[i];
			const prevSection = i > 0 ? sections[i - 1] : null;
			const nextSection = i < sections.length - 1 ? sections[i + 1] : null;

			// Step 2: Semantic Sub-Split within each section
			const subChunks = await this.semanticSubSplit(section.content);

			// Step 3: Implement Context Slop (Boundary Enrichment)
			if (subChunks.length > 0) {
				// Prepend last sentence of previous section to first chunk
				if (prevSection) {
					const lastSentence = this.getLastSentence(prevSection.content);
					if (lastSentence && lastSentence.length > 5) {
						subChunks[0] = `...${lastSentence}\n\n${subChunks[0]}`;
					}
				}
				// Append first sentence of following section to last chunk
				if (nextSection) {
					const firstSentence = this.getFirstSentence(nextSection.content);
					if (firstSentence && firstSentence.length > 5) {
						subChunks[subChunks.length - 1] = `${
							subChunks[subChunks.length - 1]
						}\n\n${firstSentence}...`;
					}
				}
			}

			for (const chunkText of subChunks) {
				const trimmed = chunkText.trim();
				if (trimmed.length < 20) continue; // Skip very short noise chunks

				allChunksToEmbed.push({
					heading: section.breadcrumbs.join(" > "),
					text: trimmed,
				});
			}
		}

		// Step 4: Batch process embeddings
		if (allChunksToEmbed.length > 0) {
			const textsToEmbed = allChunksToEmbed.map(
				(c) => `${c.heading}\n${c.text}`,
			);
			const embeddings = await this.getEmbeddingsBatch(textsToEmbed);

			for (let i = 0; i < allChunksToEmbed.length; i++) {
				const chunk = allChunksToEmbed[i];
				const embedding = embeddings[i];
				const embeddingStr = `[${embedding.join(",")}]`;
				const hasCode = chunk.text.includes("```");
				if (hasCode) {
					logger.debug(
						{ file: relativePath, heading: chunk.heading },
						"Detected code block in chunk",
					);
				}

				await this.query(
					`INSERT INTO markdown_chunks (file_path, heading, content, embedding, last_modified, word_count, repository_id, is_code) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
					[
						relativePath,
						chunk.heading,
						chunk.text,
						embeddingStr,
						stats.mtime,
						chunk.text.split(/\s+/).length,
						repositoryId || null,
						hasCode,
					],
				);
			}
		}

		logger.info(
			{ file: relativePath, chunks: allChunksToEmbed.length },
			"File indexed successfully with batch processing.",
		);

		return relativePath;
	}

	private getFirstSentence(text: string): string {
		const cleaned = text.replace(/#+\s+.*?\n/g, "").trim(); // Remove headings
		const match = cleaned.match(/^.*?[.!?](?:\s+|$)/s);
		return match ? match[0].trim() : cleaned.slice(0, 100);
	}

	private getLastSentence(text: string): string {
		const cleaned = text.trim();
		// Find the last sentence (text ending with a sentence terminator)
		const match = cleaned.match(/(?:^|[\n.!?])\s*([^.!?\n]+[.!?])\s*$/s);
		return match ? match[1].trim() : cleaned.slice(-100);
	}

	async getPublicEmbeddings(texts: string[]): Promise<number[][]> {
		return this.getEmbeddingsBatch(texts);
	}

	private async getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
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

	private structuralSplit(
		content: string,
	): { breadcrumbs: string[]; content: string }[] {
		const tree = fromMarkdown(content);
		const sections: { breadcrumbs: string[]; content: string }[] = [];

		const processNodes = (nodes: Content[], breadcrumbs: string[]) => {
			let currentSectionContent: Content[] = [];

			for (const node of nodes) {
				if (node.type === "heading") {
					// Flush current content to previous section
					if (currentSectionContent.length > 0) {
						sections.push({
							breadcrumbs: [...breadcrumbs],
							content: toMarkdown({
								type: "root",
								children: currentSectionContent,
							}),
						});
						currentSectionContent = [];
					}
					// Update breadcrumbs based on heading level
					const level = node.depth;
					const headingText = mdastToString(node);
					breadcrumbs = breadcrumbs.slice(0, level - 1);
					breadcrumbs[level - 1] = headingText;
				} else {
					currentSectionContent.push(node);
				}
			}

			// Final flush
			if (currentSectionContent.length > 0) {
				sections.push({
					breadcrumbs: [...breadcrumbs],
					content: toMarkdown({
						type: "root",
						children: currentSectionContent,
					}),
				});
			}
		};

		processNodes(tree.children, []);
		return sections;
	}

	private async semanticSubSplit(text: string): Promise<string[]> {
		const apiUrl = process.env.API_EMBEDDING_URL;
		if (!this.splitterExtractor && !apiUrl) return [text];

		// Split by blocks (double newlines) to preserve Markdown structure
		const blocks = text
			.split(/\n\n+/)
			.map((b) => b.trim())
			.filter((b) => b.length > 0);
		if (blocks.length <= 1) return [text];

		// Batch embedding for all blocks
		let vectors: Float32Array[] = [];

		if (apiUrl) {
			const embeddings = await this.fetchExternalEmbeddings(blocks, apiUrl);
			vectors = embeddings.map((v) => new Float32Array(v));
		} else if (this.splitterExtractor) {
			const output = await this.splitterExtractor(blocks, {
				pooling: "mean",
				normalize: true,
			});

			// Use dynamic dimension detection based on data length and batch size
			const data = (output as TransformerOutput).data;
			const dimension = data.length / blocks.length;
			for (let i = 0; i < blocks.length; i++) {
				vectors.push(data.slice(i * dimension, (i + 1) * dimension));
			}
		} else {
			return [text];
		}

		const chunks: string[] = [];
		let currentChunkBlocks: string[] = [blocks[0]];

		for (let i = 0; i < vectors.length - 1; i++) {
			const similarity = this.cosineSimilarity(vectors[i], vectors[i + 1]);

			// Lower threshold (0.35) and ensure we don't split chunks that are too small (< 200 chars)
			// This prevents fragmented results for lists or short paragraphs while allowing
			// distinct topics in a section to be separated.
			if (similarity < 0.35 && currentChunkBlocks.join("\n\n").length > 200) {
				chunks.push(currentChunkBlocks.join("\n\n"));
				currentChunkBlocks = [blocks[i + 1]];
			} else {
				currentChunkBlocks.push(blocks[i + 1]);
			}
		}
		chunks.push(currentChunkBlocks.join("\n\n"));

		// Post-process: ensure no chunk is TOO large (fallback to recursive)
		const finalChunks: string[] = [];
		for (const chunk of chunks) {
			if (chunk.length > 1200) {
				const recursiveSplitter = new RecursiveCharacterTextSplitter({
					chunkSize: 1000,
					chunkOverlap: 250,
				});
				const subParts = await recursiveSplitter.splitText(chunk);
				finalChunks.push(...subParts);
			} else {
				finalChunks.push(chunk);
			}
		}

		return finalChunks;
	}

	private cosineSimilarity(v1: Float32Array, v2: Float32Array): number {
		let dot = 0;
		for (let i = 0; i < v1.length; i++) {
			dot += v1[i] * v2[i];
		}
		return dot; // Assumes normalized vectors
	}

	private async getEmbedding(text: string): Promise<number[]> {
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

	async search(
		query: string,
		limit = 5,
		rerank = false,
		repositoryId?: string,
		hybrid = true,
	): Promise<MarkdownChunk[]> {
		logger.info(
			{ query, limit, rerank, repositoryId, hybrid },
			"Performing search",
		);
		const queryVector = await this.getEmbedding(query);
		const queryVectorStr = `[${queryVector.join(",")}]`;
		const queryText = query.trim();

		const VECTOR_WEIGHT = 1.2;
		const TEXT_WEIGHT = 1.5;
		const KEYWORD_WEIGHT = 1.5;
		const HEADING_WEIGHT = 2.0; // Reduced from 5.0 to balance content search
		const K = 60;
		// RECALL_LIMIT ensures we consider enough candidates for RRF fusion
		const RECALL_LIMIT = Math.max(200, rerank ? limit * 10 : limit * 5);

		let results: MarkdownChunk[];

		if (hybrid) {
			// Split query into words for heading match fallback
			const queryWords = queryText
				.split(/\s+/)
				.filter((w) => w.length > 0)
				.map((w) => `%${w}%`);

			// Technical boost: check if query mentions common technical terms
			const isTechnicalQuery =
				/mermaid|flow|code|const|function|interface|type|class|graph|sequence|diagram/i.test(
					queryText,
				);
			const TECH_BOOST = isTechnicalQuery ? 1.2 : 1.0;

			const queryParams: unknown[] = [
				queryVectorStr, // $1
				queryText, // $2
				limit, // $3
				RECALL_LIMIT, // $4
			];

			let repoFilter = "";
			let headingMatchQuery = "";

			if (repositoryId) {
				repoFilter = "AND repository_id = $5";
				queryParams.push(repositoryId); // $5
				queryParams.push(queryWords); // $6
				headingMatchQuery = `
          SELECT id, row_number() OVER (
            ORDER BY 
              (heading ILIKE $2) DESC, 
              (heading ILIKE '%' || $2 || '%') DESC,
              (SELECT count(*) FROM unnest($6::text[]) w WHERE heading ILIKE w) DESC,
              length(heading) ASC
          ) as rank
          FROM markdown_chunks
          WHERE (heading ILIKE '%' || $2 || '%') OR (
            EXISTS (SELECT 1 FROM unnest($6::text[]) w WHERE heading ILIKE w)
          )
          ${repoFilter}
          LIMIT $4
        `;
			} else {
				queryParams.push(queryWords); // $5
				headingMatchQuery = `
          SELECT id, row_number() OVER (
            ORDER BY 
              (heading ILIKE $2) DESC, 
              (heading ILIKE '%' || $2 || '%') DESC,
              (SELECT count(*) FROM unnest($5::text[]) w WHERE heading ILIKE w) DESC,
              length(heading) ASC
          ) as rank
          FROM markdown_chunks
          WHERE (heading ILIKE '%' || $2 || '%') OR (
            EXISTS (SELECT 1 FROM unnest($5::text[]) w WHERE heading ILIKE w)
          )
          LIMIT $4
        `;
			}

			const res = await this.query<
				MarkdownChunk & { distance: number; rrf_score: number }
			>(
				`
      WITH vector_search AS (
        SELECT id, row_number() OVER (ORDER BY embedding <#> $1 ASC) as rank
        FROM markdown_chunks
        WHERE 1=1 ${repoFilter}
        LIMIT $4
      ),
      text_search AS (
        SELECT id, row_number() OVER (ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', $2)) DESC) as rank
        FROM markdown_chunks
        WHERE search_vector @@ websearch_to_tsquery('english', $2) ${repoFilter}
        LIMIT $4
      ),
      keyword_search AS (
        SELECT id, row_number() OVER (ORDER BY ts_rank_cd(search_vector_simple, websearch_to_tsquery('simple', $2)) DESC) as rank
        FROM markdown_chunks
        WHERE search_vector_simple @@ websearch_to_tsquery('simple', $2) ${repoFilter}
        LIMIT $4
      ),
      heading_search AS (
        ${headingMatchQuery}
      )
      SELECT 
        m.id,
        m.file_path, 
        m.heading, 
        m.content, 
        m.last_modified,
        m.word_count,
        m.repository_id,
        m.is_code,
        COALESCE((m.embedding <#> $1) * -1, 0.0) as distance,
        (
          COALESCE(${VECTOR_WEIGHT.toFixed(1)} / (${K}.0 + v.rank), 0.0) + 
          COALESCE(${TEXT_WEIGHT.toFixed(1)} / (${K}.0 + t.rank), 0.0) +
          COALESCE(${KEYWORD_WEIGHT.toFixed(1)} / (${K}.0 + k.rank), 0.0) +
          COALESCE(${HEADING_WEIGHT.toFixed(1)} / (${K}.0 + h.rank), 0.0)
        ) * (CASE WHEN m.is_code AND ${isTechnicalQuery} THEN ${TECH_BOOST} ELSE 1.0 END)::float as rrf_score
      FROM markdown_chunks m
      LEFT JOIN vector_search v ON m.id = v.id
      LEFT JOIN text_search t ON m.id = t.id
      LEFT JOIN keyword_search k ON m.id = k.id
      LEFT JOIN heading_search h ON m.id = h.id
      WHERE v.id IS NOT NULL OR t.id IS NOT NULL OR k.id IS NOT NULL OR h.id IS NOT NULL
      ORDER BY rrf_score DESC
      LIMIT $3;
    `,
				queryParams,
			);
			results = res.rows;
		} else {
			const repoFilter = repositoryId ? "AND repository_id = $3" : "";
			const res = await this.query<
				MarkdownChunk & { distance: number; rrf_score: number }
			>(
				`
      SELECT 
        id,
        file_path, 
        heading, 
        content, 
        last_modified,
        word_count,
        repository_id,
        COALESCE((embedding <#> $1) * -1, 0.0) as distance,
        COALESCE((embedding <#> $1) * -1, 0.0) as rrf_score
      FROM markdown_chunks
      WHERE 1=1 ${repoFilter}
      ORDER BY embedding <#> $1 ASC
      LIMIT $2;
    `,
				repositoryId
					? [queryVectorStr, limit, repositoryId]
					: [queryVectorStr, limit],
			);
			results = res.rows;
		}

		logger.debug({ count: results.length }, "Initial search results found");

		if (rerank && this.rerankerModel && this.rerankerTokenizer) {
			logger.info(
				{ count: results.length },
				"Reranking search results via cross-encoder...",
			);
			const passages = results.map(
				(item) => `${item.heading}\n${item.content}`,
			);
			const queries = new Array(passages.length).fill(queryText);

			const inputs = await this.rerankerTokenizer(queries, {
				text_pair: passages,
				padding: true,
				truncation: true,
			});

			const { logits } = await this.rerankerModel(inputs);

			const reranked = results.map((item, i) => ({
				...item,
				rerank_score: logits.data[i] as number,
			}));

			results = reranked
				.sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0))
				.slice(0, limit);
		}

		return results;
	}

	async hasData(): Promise<boolean> {
		const res = await this.query("SELECT id FROM markdown_chunks LIMIT 1", []);
		return res.rows.length > 0;
	}

	async getChunkNeighbors(id: number) {
		const chunkRes = await this.query<{ file_path: string }>(
			"SELECT file_path FROM markdown_chunks WHERE id = $1",
			[id],
		);
		if (chunkRes.rows.length === 0 || !chunkRes.rows[0]) return null;
		const filePath = chunkRes.rows[0].file_path;

		const prevRes = await this.query<{
			id: string;
			heading: string;
			content: string;
		}>(
			"SELECT id, heading, content FROM markdown_chunks WHERE file_path = $1 AND id < $2 ORDER BY id DESC LIMIT 1",
			[filePath, id],
		);

		const nextRes = await this.query<{
			id: string;
			heading: string;
			content: string;
		}>(
			"SELECT id, heading, content FROM markdown_chunks WHERE file_path = $1 AND id > $2 ORDER BY id ASC LIMIT 1",
			[filePath, id],
		);

		return {
			previous: prevRes.rows[0] || null,
			next: nextRes.rows[0] || null,
		};
	}

	async readDocument(filePath: string): Promise<string | null> {
		const fullPath = path.resolve(process.cwd(), filePath);
		if (!fullPath.startsWith(process.cwd())) {
			logger.warn(
				{ filePath },
				"Security violation: Attempted to read file outside of workspace.",
			);
			return null;
		}
		if (!fs.existsSync(fullPath)) return null;
		return fs.readFileSync(fullPath, "utf-8");
	}

	async removeDocument(filePath: string) {
		await this.query("DELETE FROM markdown_chunks WHERE file_path = $1", [
			filePath,
		]);
		logger.info({ file: filePath }, "Document removed from database.");
	}
}
