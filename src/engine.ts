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
import type { Content, Root } from "mdast";
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

type RerankerModel = (inputs: any) => Promise<{ logits: { data: number[] } }>;
type RerankerTokenizer = (
	queries: string[],
	options: {
		text_pair: string[];
		padding: boolean;
		truncation: boolean;
	},
) => Promise<any>;

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

			let dbUrl = process.env.POSTGRES_URL;
			const isDocker = fs.existsSync("/.dockerenv");

			if (!dbUrl && isDocker) {
				// Default connection string for our Docker Compose stack
				dbUrl = "postgres://user:pass@db:5432/raglike";
				logger.info(
					"Docker environment detected. Defaulting to containerized Postgres service.",
				);
			}

			if (dbUrl) {
				this.sql = postgres(dbUrl);
				logger.info("External Postgres connection initialized.");
			} else {
				const dbPath =
					this.dbPathOverride || path.join(process.cwd(), "raglike_db");

				// Patch vector extension to handle Bun's file:// URL stringification in tests
				const patchedVector = {
					...vector,
					setup: async (pg: any, emscriptenOpts: any) => {
						const result = await vector.setup(pg, emscriptenOpts);
						if (
							result.bundlePath instanceof URL &&
							result.bundlePath.protocol === "file:"
						) {
							// Use realpathSync to resolve any potential symlink issues and ensure plain path
							const plainPath = fs.realpathSync(fileURLToPath(result.bundlePath));
							logger.debug({ path: plainPath }, "PGlite vector bundle resolved");
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

			// Check if we need to upgrade search_vector to weighted version
			// In PostgreSQL we can't easily ALTER a GENERATED column's expression,
			// so we drop and recreate if it's already there to ensure the new weights apply.
			try {
				await this.exec(
					"ALTER TABLE markdown_chunks DROP COLUMN IF EXISTS search_vector;",
				);
			} catch (_e) {
				logger.debug(
					"search_vector column did not exist or could not be dropped.",
				);
			}

			await this.exec(`
        ALTER TABLE markdown_chunks ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(heading, '')), 'A') || 
          setweight(to_tsvector('english', coalesce(content, '')), 'B')
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
      search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(heading, '')), 'A') || 
        setweight(to_tsvector('english', coalesce(content, '')), 'B')
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

	async query<T extends Record<string, any>>(
		query: string,
		params: any[],
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

	async indexSingleFile(filePath: string, repositoryId?: string) {
		let content = "";
		if (filePath.endsWith(".pdf")) {
			const pdfBuffer = fs.readFileSync(filePath);
			const pdfData = await pdf2md(pdfBuffer);
			content = pdfData;
		} else {
			content = fs.readFileSync(filePath, "utf-8");
		}

		// Clean data: strip base64 images and large blobs to save embedding tokens and DB space
		const cleanedContent = content.replace(
			/data:image\/[a-zA-Z]*;base64,[^)\s]*/g,
			"[base64 image removed]",
		);

		const relativePath = path.relative(process.cwd(), filePath);
		const stats = fs.statSync(filePath);

		// Remove old chunks for this file
		await this.query("DELETE FROM markdown_chunks WHERE file_path = $1", [
			relativePath,
		]);
		logger.info({ file: relativePath }, "Document chunks removed from database.");

		// Step 1: Structural AST Split
		const sections = this.structuralSplit(cleanedContent);

		const allChunksToEmbed: { heading: string; text: string }[] = [];

		for (const section of sections) {
			// Step 2: Semantic Sub-Split within each section
			const subChunks = await this.semanticSubSplit(section.content);
			for (const chunkText of subChunks) {
				allChunksToEmbed.push({
					heading: section.breadcrumbs.join(" > "),
					text: chunkText,
				});
			}
		}

		// Step 3: Batch process embeddings
		if (allChunksToEmbed.length > 0) {
			const textsToEmbed = allChunksToEmbed.map(
				(c) => `${c.heading}\n${c.text}`,
			);
			const embeddings = await this.getEmbeddingsBatch(textsToEmbed);

			for (let i = 0; i < allChunksToEmbed.length; i++) {
				const chunk = allChunksToEmbed[i];
				const embedding = embeddings[i];
				const embeddingStr = `[${embedding.join(",")}]`;

				await this.query(
					`INSERT INTO markdown_chunks (file_path, heading, content, embedding, last_modified, word_count, repository_id) 
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					[
						relativePath,
						chunk.heading,
						chunk.text,
						embeddingStr,
						stats.mtime,
						chunk.text.split(/\s+/).length,
						repositoryId || null,
					],
				);
			}
		}

		logger.info(
			{ file: relativePath, chunks: allChunksToEmbed.length },
			"File indexed successfully with batch processing.",
		);
	}

	private async getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
		if (!this.extractor) throw new Error("Extractor not initialized.");

		// Handle empty case
		if (texts.length === 0) return [];

		const output = await this.extractor(texts, {
			pooling: "mean",
			normalize: true,
		});

		// Transformers pipeline returns a single Tensor for batch processing
		// We need to slice it back into individual vectors
		const data = (output as TransformerOutput).data;
		const dimension = 768;
		const results: number[][] = [];

		for (let i = 0; i < texts.length; i++) {
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
		let currentBreadcrumbs: string[] = [];

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
		if (!this.splitterExtractor) return [text];

		// Split by blocks (double newlines) to preserve Markdown structure
		const blocks = text
			.split(/\n\n+/)
			.map((b) => b.trim())
			.filter((b) => b.length > 0);
		if (blocks.length <= 1) return [text];

		// Batch embedding for all blocks
		const blockOutputs = (await this.splitterExtractor(blocks, {
			pooling: "mean",
			normalize: true,
		})) as TransformerOutput[];

		const vectors = blockOutputs.map((out) => out.data);
		const chunks: string[] = [];
		let currentChunkBlocks: string[] = [blocks[0]];

		for (let i = 0; i < vectors.length - 1; i++) {
			const similarity = this.cosineSimilarity(vectors[i], vectors[i + 1]);

			// Threshold for topic shift (tuned for all-MiniLM-L6-v2)
			if (similarity < 0.45) {
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
			if (chunk.length > 1500) {
				const recursiveSplitter = new RecursiveCharacterTextSplitter({
					chunkSize: 600,
					chunkOverlap: 120,
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
	): Promise<MarkdownChunk[]> {
		const queryVector = await this.getEmbedding(query);
		const queryVectorStr = `[${queryVector.join(",")}]`;
		const queryText = query.trim();

		const VECTOR_WEIGHT = 1.0;
		const TEXT_WEIGHT = 1.0;
		const K = 60;
		const initialLimit = rerank ? Math.max(50, limit * 2) : limit;

		const repoFilter = repositoryId ? "AND repository_id = $4" : "";

		const res = await this.query<
			MarkdownChunk & { distance: number; rrf_score: number }
		>(
			`
      WITH vector_search AS (
        SELECT id, row_number() OVER (ORDER BY embedding <#> $1 ASC) as rank
        FROM markdown_chunks
        WHERE 1=1 ${repoFilter}
        LIMIT $3 * 2
      ),
      text_search AS (
        SELECT id, row_number() OVER (ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', $2)) DESC) as rank
        FROM markdown_chunks
        WHERE search_vector @@ websearch_to_tsquery('english', $2) ${repoFilter}
        LIMIT $3 * 2
      )
      SELECT 
        m.id,
        m.file_path, 
        m.heading, 
        m.content, 
        m.last_modified,
        m.word_count,
        m.repository_id,
        COALESCE((m.embedding <#> $1) * -1, 0.0) as distance,
        (
          COALESCE(${VECTOR_WEIGHT.toFixed(1)} / (${K}.0 + v.rank), 0.0) + 
          COALESCE(${TEXT_WEIGHT.toFixed(1)} / (${K}.0 + t.rank), 0.0)
        )::float as rrf_score
      FROM markdown_chunks m
      LEFT JOIN vector_search v ON m.id = v.id
      LEFT JOIN text_search t ON m.id = t.id
      WHERE v.id IS NOT NULL OR t.id IS NOT NULL
      ORDER BY rrf_score DESC
      LIMIT $3;
    `,
			repositoryId
				? [queryVectorStr, queryText, initialLimit, repositoryId]
				: [queryVectorStr, queryText, initialLimit],
		);

		let results: MarkdownChunk[] = res.rows;

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

	async destroy() {
		this.initialized = false;
		if (this.pglite) {
			const db = this.pglite;
			this.pglite = undefined;
			await db.close();
		}
		if (this.sql) {
			const sql = this.sql;
			this.sql = undefined;
			await sql.end();
		}
	}
}
