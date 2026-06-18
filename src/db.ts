import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import postgres from "postgres";
import { logger } from "./logger";

export class DatabaseManager {
	private pglite?: PGlite;
	private sql?: postgres.Sql<Record<string, never>>;

	constructor(private dbPathOverride?: string) {}

	async initialize(embeddingDimension: number) {
		const dbUrl = process.env.POSTGRES_URL;

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

		await this.ensureSchema(embeddingDimension);
		this.initialized = true;
	}

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

	async [Symbol.asyncDispose]() {
		await this.destroy();
	}

	async exec(query: string): Promise<void> {
		if (this.pglite) {
			await this.pglite.exec(query);
		} else if (this.sql) {
			await this.sql.unsafe(query);
		} else {
			throw new Error("Database not initialized.");
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
		throw new Error("Database not initialized.");
	}

	private async ensureSchema(embeddingDimension: number) {
		await this.exec("CREATE EXTENSION IF NOT EXISTS vector;");
		try {
			await this.exec("SET hnsw.ef_search = 100;");
		} catch (e) {
			logger.warn(
				e,
				"Failed to set hnsw.ef_search. It might not be supported yet or the index is not loaded.",
			);
		}

		const tableExists = await this.query<{ exists: boolean }>(
			"SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'markdown_chunks')",
			[],
		);

		if (tableExists.rows[0].exists) {
			const dimRes = await this.query<{ atttypmod: number }>(
				"SELECT atttypmod FROM pg_attribute WHERE attrelid = 'markdown_chunks'::regclass AND attname = 'embedding'",
				[],
			);
			if (
				dimRes.rows.length > 0 &&
				dimRes.rows[0].atttypmod !== embeddingDimension
			) {
				logger.warn(
					{
						oldDim: dimRes.rows[0].atttypmod,
						newDim: embeddingDimension,
					},
					"Vector dimension mismatch detected. Dropping table for re-ingestion.",
				);
				await this.exec("DROP TABLE markdown_chunks;");
			}
		}

		const schema = DatabaseManager.SCHEMA.replace(
			"vector(768)",
			`vector(${embeddingDimension})`,
		);
		await this.exec(schema);

		await this.exec("DROP INDEX IF EXISTS idx_markdown_chunks_embedding;");
		await this.exec(
			`CREATE INDEX idx_markdown_chunks_embedding ON markdown_chunks USING hnsw (embedding vector_ip_ops) WITH (m = 24, ef_construction = 100);`,
		);

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

			const hasSearchVector = await this.query<{ exists: boolean }>(
				`SELECT EXISTS (
					SELECT FROM information_schema.columns 
					WHERE table_name = 'markdown_chunks' AND column_name = 'search_vector'
				)`,
				[],
			);

			if (!hasSearchVector.rows[0].exists) {
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
			}
		} catch (_e) {
			logger.warn(
				"Could not update schema columns, they might already exist or the syntax is unsupported by this version.",
			);
		}

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
}
