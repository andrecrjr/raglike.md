import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pipeline } from "@xenova/transformers";
import postgres from "postgres";
import { logger } from "./logger";
import * as fs from "fs";
import * as path from "path";

export class VectorEngine {
  private pglite?: PGlite;
  private sql?: postgres.Sql<{}>;
  private extractor: any;

  async initialize() {
    this.extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    
    let dbUrl = process.env.POSTGRES_URL;
    const isDocker = fs.existsSync("/.dockerenv");

    if (!dbUrl && isDocker) {
      // Default connection string for our Docker Compose stack
      dbUrl = "postgres://user:pass@db:5432/raglike";
      logger.info("Docker environment detected. Defaulting to containerized Postgres service.");
    }

    if (dbUrl) {
      this.sql = postgres(dbUrl);
      logger.info("External Postgres connection initialized.");
    } else {
      const dbPath = path.join(process.cwd(), "raglike_db");
      this.pglite = await PGlite.create(dbPath, { extensions: { vector } });
      logger.info({ path: dbPath }, "Local PGlite Vector Engine persistent storage initialized.");
    }
    
    await this.exec("CREATE EXTENSION IF NOT EXISTS vector;");
    await this.exec(`
      CREATE TABLE IF NOT EXISTS markdown_chunks (
        id BIGSERIAL PRIMARY KEY,
        file_path TEXT,
        heading TEXT,
        content TEXT,
        embedding vector(384),
        last_modified TIMESTAMP,
        word_count INTEGER,
        search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', heading || ' ' || content)) STORED
      );
    `);
    
    // Step 4: Add HNSW index for high-performance vector search with tuned parameters
    // We drop and recreate to ensure parameters like m and ef_construction are applied
    await this.exec("DROP INDEX IF EXISTS idx_markdown_chunks_embedding;");
    await this.exec("CREATE INDEX idx_markdown_chunks_embedding ON markdown_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);");
    
    // Ensure new columns exist for existing databases
    try {
      await this.exec("ALTER TABLE markdown_chunks ADD COLUMN IF NOT EXISTS last_modified TIMESTAMP;");
      await this.exec("ALTER TABLE markdown_chunks ADD COLUMN IF NOT EXISTS word_count INTEGER;");
      await this.exec("ALTER TABLE markdown_chunks ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', heading || ' ' || content)) STORED;");
    } catch (e) {
      // In some older postgres versions ADD COLUMN IF NOT EXISTS with GENERATED might be finicky
      logger.warn("Could not update schema columns, they might already exist or the syntax is unsupported by this version.");
    }

    // Add GIN index for full-text search (replacing GIST if it existed for better performance)
    await this.exec("DROP INDEX IF EXISTS idx_markdown_chunks_search_vector;");
    await this.exec("CREATE INDEX idx_markdown_chunks_search_vector ON markdown_chunks USING GIN (search_vector);");
    
    logger.info("Database subsystem fully ready and schema verified.");
  }

  private async exec(query: string) {
    if (this.sql) {
      await this.sql.unsafe(query);
    } else {
      await this.pglite!.exec(query);
    }
  }

  private async query<T>(query: string, params: any[]): Promise<{ rows: T[] }> {
    if (this.sql) {
      const results = await this.sql.unsafe(query, params);
      return { rows: results as unknown as T[] };
    } else {
      return await this.pglite!.query<T>(query, params);
    }
  }

  async removeDocument(relativePath: string) {
    await this.query("DELETE FROM markdown_chunks WHERE file_path = $1", [relativePath]);
    logger.info({ file: relativePath }, "Document chunks removed from database.");
  }

  async hasData(): Promise<boolean> {
    const res = await this.query<{ count: string }>("SELECT count(*) as count FROM markdown_chunks", []);
    return parseInt(res.rows[0].count) > 0;
  }

  private async generateEmbeddingString(text: string): Promise<string> {
    const output = await this.extractor(text, { pooling: "mean", normalize: true });
    const array = Array.from(output.data as Float32Array);
    return `[${array.join(",")}]`; // Native Postgres representation
  }

  private getFilesRecursively(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries.map(entry => {
      const res = path.resolve(dir, entry.name);
      return entry.isDirectory() ? this.getFilesRecursively(res) : res;
    });
    return files.flat().filter(f => f.endsWith(".md"));
  }

  async indexDirectory(rootDocsDir: string) {
    if (!fs.existsSync(rootDocsDir)) return;
    const targetFiles = this.getFilesRecursively(rootDocsDir);
    
    const CONCURRENCY_LIMIT = 5; // Process 5 files at a time to manage CPU/Memory
    for (let i = 0; i < targetFiles.length; i += CONCURRENCY_LIMIT) {
      const batch = targetFiles.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(batch.map(file => this.indexSingleFile(file)));
    }
    
    logger.info({ totalFiles: targetFiles.length }, "Recursive workspace folder ingestion complete.");
  }

  public async indexSingleFile(filePath: string) {
    const relativePath = path.relative(process.cwd(), filePath);
    const stats = fs.statSync(filePath);
    const lastModified = stats.mtime;
    let rawContent = fs.readFileSync(filePath, "utf-8");
    
    // Clean base64 image data from markdown to prevent bloating the vector database
    // This handles both standard markdown ![alt](data:...) and <img> tags
    rawContent = rawContent.replace(/!\[.*?\]\(data:image\/[^;]+;base64,[^)]*\)/g, "");
    rawContent = rawContent.replace(/<img\s+[^>]*src="data:image\/[^;]+;base64,[^"]*"[^>]*>/g, "");
    // Fallback for any orphaned base64 data URI strings
    rawContent = rawContent.replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/g, "");

    // Clear old chunks first to ensure clean updates
    await this.removeDocument(relativePath);

    const lines = rawContent.split("\n");
    const breadcrumbs: string[] = [];
    const sections: { breadcrumb: string; content: string }[] = [];
    let currentSectionContent: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^(#+) (.*)$/);
      if (headerMatch) {
        // Save previous section if it has content
        if (currentSectionContent.length > 0) {
          sections.push({
            breadcrumb: breadcrumbs.join(" > "),
            content: currentSectionContent.join("\n").trim()
          });
          currentSectionContent = [];
        }

        const level = headerMatch[1].length;
        const title = headerMatch[2].trim();

        // Update breadcrumbs based on level
        while (breadcrumbs.length >= level) {
          breadcrumbs.pop();
        }
        breadcrumbs.push(title);
      } else {
        currentSectionContent.push(line);
      }
    }

    // Add last section
    if (currentSectionContent.length > 0) {
      sections.push({
        breadcrumb: breadcrumbs.join(" > ") || "General",
        content: currentSectionContent.join("\n").trim()
      });
    }

    const chunksToInsert: [string, string, string, string, Date, number][] = [];

    // Helper to extract first and last sentences
    const getSentences = (text: string) => {
      return text.match(/[^.!?]+[.!?]+/g) || [text];
    };

    for (let i = 0; i < sections.length; i++) {
      const { breadcrumb, content } = sections[i];
      if (!content) continue;

      const CHUNK_SIZE = 600;
      const CHUNK_OVERLAP = 120; // Increased overlap for better slop coverage
      
      let startIndex = 0;
      const sectionChunks: string[] = [];

      while (startIndex < content.length) {
        let endIndex = startIndex + CHUNK_SIZE;
        let chunk = content.substring(startIndex, endIndex);
        
        if (endIndex < content.length) {
          const lastBreak = Math.max(chunk.lastIndexOf("\n"), chunk.lastIndexOf(". "));
          if (lastBreak > CHUNK_SIZE * 0.7) {
            endIndex = startIndex + lastBreak + 1;
            chunk = content.substring(startIndex, endIndex);
          }
        }

        if (chunk.trim().length > 5) {
          sectionChunks.push(chunk.trim());
        }
        
        startIndex = endIndex - CHUNK_OVERLAP;
        if (startIndex >= content.length || chunk.length < CHUNK_OVERLAP) break;
      }

      // Apply Context Slop within section and between sections
      for (let j = 0; j < sectionChunks.length; j++) {
        let finalChunkContent = sectionChunks[j];

        // Prepend slop from previous section if first chunk
        if (j === 0 && i > 0) {
          const prevSection = sections[i - 1].content;
          const prevSentences = getSentences(prevSection);
          const lastSentence = prevSentences[prevSentences.length - 1];
          finalChunkContent = `[Context from ${sections[i-1].breadcrumb}]: ...${lastSentence}\n\n${finalChunkContent}`;
        }

        // Append slop from next section if last chunk
        if (j === sectionChunks.length - 1 && i < sections.length - 1) {
          const nextSection = sections[i + 1].content;
          const nextSentences = getSentences(nextSection);
          const firstSentence = nextSentences[0];
          finalChunkContent = `${finalChunkContent}\n\n[Context continues in ${sections[i+1].breadcrumb}]: ${firstSentence}...`;
        }

        const wordCount = finalChunkContent.split(/\s+/).length;
        const vectorString = await this.generateEmbeddingString(`${breadcrumb}\n${finalChunkContent}`);
        chunksToInsert.push([relativePath, breadcrumb, finalChunkContent, vectorString, lastModified, wordCount]);
      }
    }

    // Batch insert for this file
    if (chunksToInsert.length > 0) {
      if (this.sql) {
        await this.sql`
          INSERT INTO markdown_chunks (file_path, heading, content, embedding, last_modified, word_count)
          VALUES ${this.sql(chunksToInsert)}
        `;
      } else {
        for (const [path, head, cont, emb, mod, word] of chunksToInsert) {
          await this.query(
            "INSERT INTO markdown_chunks (file_path, heading, content, embedding, last_modified, word_count) VALUES ($1, $2, $3, $4, $5, $6)",
            [path, head, cont, emb, mod, word]
          );
        }
      }
    }
    logger.info({ file: relativePath, chunks: chunksToInsert.length }, "File indexed with hierarchical context and slop.");
  }

  async search(queryText: string, limit: number) {
    const queryVectorStr = await this.generateEmbeddingString(queryText);
    
    // Hybrid Search: Reciprocal Rank Fusion (RRF)
    // RRF combines the rankings from different search methods to provide a more robust result set.
    // The formula is: score = sum(1 / (k + rank)) where k is a constant (usually 60).
    const res = await this.query<{ id: string; file_path: string; heading: string; content: string; distance: number; rrf_score: number }>(`
      WITH vector_search AS (
        SELECT id, row_number() OVER (ORDER BY embedding <=> $1 ASC) as rank
        FROM markdown_chunks
        LIMIT $2 * 2
      ),
      text_search AS (
        SELECT id, row_number() OVER (ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', $3)) DESC) as rank
        FROM markdown_chunks
        WHERE search_vector @@ websearch_to_tsquery('english', $3)
        LIMIT $2 * 2
      )
      SELECT 
        m.id,
        m.file_path, 
        m.heading, 
        m.content, 
        m.last_modified,
        m.word_count,
        COALESCE((m.embedding <=> $1), 1.0) as distance,
        (COALESCE(1.0 / (60 + v.rank), 0.0) + COALESCE(1.0 / (60 + t.rank), 0.0))::float as rrf_score
      FROM markdown_chunks m
      LEFT JOIN vector_search v ON m.id = v.id
      LEFT JOIN text_search t ON m.id = t.id
      WHERE v.id IS NOT NULL OR t.id IS NOT NULL
      ORDER BY rrf_score DESC
      LIMIT $2;
    `, [queryVectorStr, limit, queryText]);

    return res.rows;
  }

  async getChunkNeighbors(id: number) {
    const chunkRes = await this.query<{ file_path: string }>("SELECT file_path FROM markdown_chunks WHERE id = $1", [id]);
    if (chunkRes.rows.length === 0) return null;
    const filePath = chunkRes.rows[0].file_path;

    const prevRes = await this.query<{ id: string; heading: string; content: string }>(
      "SELECT id, heading, content FROM markdown_chunks WHERE file_path = $1 AND id < $2 ORDER BY id DESC LIMIT 1",
      [filePath, id]
    );
    const nextRes = await this.query<{ id: string; heading: string; content: string }>(
      "SELECT id, heading, content FROM markdown_chunks WHERE file_path = $1 AND id > $2 ORDER BY id ASC LIMIT 1",
      [filePath, id]
    );

    return {
      previous: prevRes.rows[0] || null,
      next: nextRes.rows[0] || null
    };
  }

  async readDocument(relativePath: string): Promise<string | null> {
    const fullPath = path.resolve(process.cwd(), relativePath);
    if (!fullPath.startsWith(process.cwd())) {
      throw new Error("Security violation: Attempted path traversal outside workspace.");
    }
    
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fs.readFileSync(fullPath, "utf-8");
    }
    return null;
  }

  async destroy() {
    if (this.pglite) await this.pglite.close();
    if (this.sql) await this.sql.end();
  }
}
