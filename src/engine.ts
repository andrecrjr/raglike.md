import * as fs from "node:fs";
import * as path from "node:path";
import { toMarkdown } from "mdast-util-to-markdown";
import { Chunker } from "./chunking";
import { DatabaseManager } from "./db";
import { logger } from "./logger";
import { ModelManager, type ModelMocks } from "./models";

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
	language?: string;
}

export interface EngineMocks extends ModelMocks {}

export class VectorEngine {
	private db: DatabaseManager;
	private models: ModelManager;
	private chunker: Chunker;
	private initialized = false;
	private initializing: Promise<void> | null = null;
	private embeddingDimension = 768;

	constructor(dbPath?: string, mocks: EngineMocks = {}) {
		this.db = new DatabaseManager(dbPath);
		this.models = new ModelManager(mocks);
		this.chunker = new Chunker();
	}

	getEngineInfo() {
		const info = this.models.modelInfo;
		return {
			...info,
			dimension: this.embeddingDimension,
		};
	}

	async initialize() {
		if (this.initialized) return;
		if (this.initializing) return this.initializing;

		this.initializing = (async () => {
			await this.models.initialize();

			// Detect embedding dimension
			const testEmbed = await this.models.getEmbedding("test");
			this.embeddingDimension = testEmbed.length;
			logger.info(`Embedding dimension detected: ${this.embeddingDimension}`);

			await this.db.initialize(this.embeddingDimension);

			this.initialized = true;
			this.initializing = null;
		})();

		return this.initializing;
	}

	async exec(query: string): Promise<void> {
		await this.db.exec(query);
	}

	async query<T extends Record<string, unknown>>(
		query: string,
		params: unknown[],
	): Promise<{ rows: T[] }> {
		return this.db.query<T>(query, params);
	}

	async destroy() {
		await this.db.destroy();
		this.initialized = false;
	}

	async [Symbol.asyncDispose]() {
		await this.destroy();
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
		const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
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
			try {
				content = await this.chunker.convertPdfToMarkdown(filePath);
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

		const cleanedContent = content
			.replace(/data:[^;]+;base64,[^)\s"']*/g, "[base64 image removed]")
			.replace(/!\[.*?\]\(.*?\)/g, "")
			.replace(/<img.*?>/g, "")
			.replace(
				/\[.*?\]\(.*?\.(?:png|jpg|jpeg|gif|webp|svg|pdf)(?:\?.*?)?\)/gi,
				"",
			)
			.replace(/\n{3,}/g, "\n\n");

		if (cleanedContent.trim().length === 0) {
			logger.warn({ file: filePath }, "File is empty. Skipping.");
			return;
		}

		const relativePath = path.relative(process.cwd(), finalFilePath);
		const stats = fs.statSync(finalFilePath);

		await this.db.query("DELETE FROM markdown_chunks WHERE file_path = $1", [
			relativePath,
		]);

		const sections = this.chunker.structuralSplit(cleanedContent);
		const allChunksToEmbed: { heading: string; text: string }[] = [];

		for (let i = 0; i < sections.length; i++) {
			const section = sections[i];
			const prevSection = i > 0 ? sections[i - 1] : null;
			const nextSection = i < sections.length - 1 ? sections[i + 1] : null;

			const subChunks = await this.chunker.semanticSubSplit(
				section.nodes,
				(blocks) => this.models.getSplitterVectors(blocks),
			);

			if (subChunks.length > 0) {
				if (prevSection) {
					const prevText = toMarkdown({
						type: "root",
						children: prevSection.nodes,
					});
					const lastSentence = this.chunker.getLastSentence(prevText);
					if (lastSentence && lastSentence.length > 5) {
						subChunks[0] = `...${lastSentence}\n\n${subChunks[0]}`;
					}
				}
				if (nextSection) {
					const nextText = toMarkdown({
						type: "root",
						children: nextSection.nodes,
					});
					const firstSentence = this.chunker.getFirstSentence(nextText);
					if (firstSentence && firstSentence.length > 5) {
						subChunks[subChunks.length - 1] = `${
							subChunks[subChunks.length - 1]
						}\n\n${firstSentence}...`;
					}
				}
			}

			for (const chunkText of subChunks) {
				const trimmed = chunkText.trim();
				if (trimmed.length < 20) continue;

				allChunksToEmbed.push({
					heading: section.breadcrumbs.join(" > "),
					text: trimmed,
				});
			}
		}

		if (allChunksToEmbed.length > 0) {
			const textsToEmbed = allChunksToEmbed.map(
				(c) => `${c.heading}\n${c.text}`,
			);
			const embeddings = await this.models.getEmbeddingsBatch(textsToEmbed);

			for (let i = 0; i < allChunksToEmbed.length; i++) {
				const chunk = allChunksToEmbed[i];
				const embedding = embeddings[i];
				const embeddingStr = `[${embedding.join(",")}]`;
				const hasCode = chunk.text.includes("```");

				await this.db.query(
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
			"File indexed successfully.",
		);
		return relativePath;
	}

	async getPublicEmbeddings(texts: string[]): Promise<number[][]> {
		return this.models.getEmbeddingsBatch(texts);
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
		const queryVector = await this.models.getEmbedding(query);
		const queryVectorStr = `[${queryVector.join(",")}]`;
		const queryText = query.trim();

		const VECTOR_WEIGHT = 1.8;
		const TEXT_WEIGHT = 1.8;
		const KEYWORD_WEIGHT = 1.8;
		const HEADING_WEIGHT = 0.8;
		const K = 60;
		const RECALL_LIMIT = Math.max(200, rerank ? limit * 10 : limit * 5);

		let results: MarkdownChunk[];

		if (hybrid) {
			const queryWords = queryText
				.split(/\s+/)
				.filter((w) => w.length > 0)
				.map((w) => `%${w}%`);

			const isTechnicalQuery =
				/mermaid|flow|code|const|function|interface|type|class|graph|sequence|diagram|\b[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*\b|\b[a-zA-Z_][a-zA-Z0-9_]*\(\)|\b\.[a-zA-Z0-9]+\b/i.test(
					queryText,
				);
			const TECH_BOOST = isTechnicalQuery ? 1.2 : 1.0;

			const queryParams: unknown[] = [
				queryVectorStr,
				queryText,
				limit,
				RECALL_LIMIT,
			];

			let repoFilter = "";
			let headingMatchQuery = "";

			if (repositoryId) {
				repoFilter = "AND repository_id = $5";
				queryParams.push(repositoryId);
				queryParams.push(queryWords);
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
				queryParams.push(queryWords);
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

			const res = await this.db.query<
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
        SELECT id, row_number() OVER (ORDER BY ts_rank_cd('{0.1, 0.2, 1.0, 0.6}', search_vector, websearch_to_tsquery('english', $2)) DESC) as rank
        FROM markdown_chunks
        WHERE search_vector @@ websearch_to_tsquery('english', $2) ${repoFilter}
        LIMIT $4
      ),
      keyword_search AS (
        SELECT id, row_number() OVER (ORDER BY ts_rank_cd('{0.1, 0.2, 1.0, 0.6}', search_vector_simple, websearch_to_tsquery('simple', $2)) DESC) as rank
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
			const res = await this.db.query<
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

		if (rerank && this.models.hasReranker) {
			const passages = results.map(
				(item) => `${item.heading}\n${item.content}`,
			);
			const { logits } = await this.models.rerank(queryText, passages);

			results = results
				.map((item, i) => ({
					...item,
					rerank_score: logits.data[i] as number,
				}))
				.sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0))
				.slice(0, limit);
		}

		return results;
	}

	async hasData(): Promise<boolean> {
		const res = await this.db.query(
			"SELECT id FROM markdown_chunks LIMIT 1",
			[],
		);
		return res.rows.length > 0;
	}

	async getChunkNeighbors(id: number) {
		const chunkRes = await this.db.query<{ file_path: string }>(
			"SELECT file_path FROM markdown_chunks WHERE id = $1",
			[id],
		);
		if (chunkRes.rows.length === 0 || !chunkRes.rows[0]) return null;
		const filePath = chunkRes.rows[0].file_path;

		const prevRes = await this.db.query<{
			id: string;
			heading: string;
			content: string;
		}>(
			"SELECT id, heading, content FROM markdown_chunks WHERE file_path = $1 AND id < $2 ORDER BY id DESC LIMIT 1",
			[filePath, id],
		);

		const nextRes = await this.db.query<{
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
			logger.warn({ filePath }, "Security violation.");
			return null;
		}
		if (!fs.existsSync(fullPath)) return null;
		return fs.readFileSync(fullPath, "utf-8");
	}

	async removeDocument(filePath: string) {
		await this.db.query("DELETE FROM markdown_chunks WHERE file_path = $1", [
			filePath,
		]);
		logger.info({ file: filePath }, "Document removed.");
	}
}
