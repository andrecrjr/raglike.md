import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pipeline, AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import postgres from "postgres";
import { logger } from "./logger";
import * as fs from "fs";
import * as path from "path";

export class VectorEngine {
  private pglite?: PGlite;
  private sql?: postgres.Sql<{}>;
  private extractor: any;
  private rerankerModel: any;
  private rerankerTokenizer: any;
  private dbPathOverride?: string;

  constructor(dbPath?: string) {
    this.dbPathOverride = dbPath;
  }

  async initialize() {
    this.extractor = await pipeline("feature-extraction", "Xenova/all-mpnet-base-v2");
    this.rerankerModel = await AutoModelForSequenceClassification.from_pretrained("Xenova/bge-reranker-base");
    this.rerankerTokenizer = await AutoTokenizer.from_pretrained("Xenova/bge-reranker-base");
    logger.info("Models loaded: all-mpnet-base-v2 (Embedding) & bge-reranker-base (Reranker)");
    
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
      const dbPath = this.dbPathOverride || path.join(process.cwd(), "raglike_db");
      this.pglite = await PGlite.create(dbPath, { extensions: { vector } });
      logger.info({ path: dbPath }, "Local PGlite Vector Engine persistent storage initialized.");
    }
    
    await this.exec("CREATE EXTENSION IF NOT EXISTS vector;");

    // Check if the table exists and if the embedding dimension matches
    const tableExists = await this.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'markdown_chunks')",
      []
    );

    if (tableExists.rows[0].exists) {
      const dimRes = await this.query<{ atttypmod: number }>(
        "SELECT atttypmod FROM pg_attribute WHERE attrelid = 'markdown_chunks'::regclass AND attname = 'embedding'",
        []
      );
      if (dimRes.rows.length > 0 && dimRes.rows[0].atttypmod !== 768) {
        logger.warn({ oldDim: dimRes.rows[0].atttypmod, newDim: 768 }, "Vector dimension mismatch detected. Dropping table for re-ingestion.");
        await this.exec("DROP TABLE markdown_chunks;");
      }
    }

    await this.exec(`
      CREATE TABLE IF NOT EXISTS markdown_chunks (
        id BIGSERIAL PRIMARY KEY,
        file_path TEXT,
        heading TEXT,
        content TEXT,
        embedding vector(768),
        last_modified TIMESTAMP,
        word_count INTEGER,
        search_vector tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(heading, '')), 'A') || 
          setweight(to_tsvector('english', coalesce(content, '')), 'B')
        ) STORED
      );
    `);
    
    // Step 4: Add HNSW index for high-performance vector search with tuned parameters
    // We drop and recreate to ensure parameters like m and ef_construction are applied
    await this.exec("DROP INDEX IF EXISTS idx_markdown_chunks_embedding;");
    await this.exec("CREATE INDEX idx_markdown_chunks_embedding ON markdown_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 24, ef_construction = 100);");
    
    // Ensure new columns exist for existing databases and update search_vector if needed
    try {
      await this.exec("ALTER TABLE markdown_chunks ADD COLUMN IF NOT EXISTS last_modified TIMESTAMP;");
      await this.exec("ALTER TABLE markdown_chunks ADD COLUMN IF NOT EXISTS word_count INTEGER;");
      
      // Check if we need to upgrade search_vector to weighted version
      // In PostgreSQL we can't easily ALTER a GENERATED column's expression, 
      // so we drop and recreate if it's already there to ensure the new weights apply.
      try {
        await this.exec("ALTER TABLE markdown_chunks DROP COLUMN IF EXISTS search_vector;");
      } catch (e) {
        logger.debug("search_vector column did not exist or could not be dropped.");
      }
      
      await this.exec(`
        ALTER TABLE markdown_chunks ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(heading, '')), 'A') || 
          setweight(to_tsvector('english', coalesce(content, '')), 'B')
        ) STORED;
      `);
    } catch (e) {
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
    return res.rows[0] ? parseInt(res.rows[0].count) > 0 : false;
  }

  private async generateEmbeddingString(text: string): Promise<string> {
    const output = await this.extractor(text, { pooling: "mean", normalize: true });
    const array = Array.from(output.data as Float32Array);
    if (array.length !== 768) {
      throw new Error(`Unexpected embedding dimension: expected 768, got ${array.length}`);
    }
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
    
    // Strip raw HTML tags to prevent them from polluting embeddings and full-text search
    rawContent = rawContent.replace(/<[^>]*>?/g, "");
    // Clean markdown links: [text](url) -> text
    // This reduces noise from long URLs that don't have semantic meaning for search
    rawContent = rawContent.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

    // Clear old chunks first to ensure clean updates
    await this.removeDocument(relativePath);

    const lines = rawContent.split("\n");
    const breadcrumbs: string[] = [];
    const sections: { breadcrumb: string; content: string }[] = [];
    let currentSectionContent: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^(#+) (.*)$/);
      if (headerMatch && headerMatch[1] && headerMatch[2]) {
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

    // Use native Intl.Segmenter for high-quality sentence boundary detection
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    const getSentences = (text: string) => {
      return Array.from(segmenter.segment(text)).map(s => s.segment);
    };

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (!section || !section.content) continue;
      const { breadcrumb, content } = section;

      const CHUNK_SIZE = 600;
      const CHUNK_OVERLAP_CHARS = 120;
      
      const sentences = getSentences(content);
      const sectionChunks: string[] = [];
      let currentChunkSentences: string[] = [];
      let currentChunkLength = 0;

      for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
        const sentence = sentences[sIdx];
        if (!sentence) continue;
        currentChunkSentences.push(sentence);
        currentChunkLength += sentence.length;

        if (currentChunkLength >= CHUNK_SIZE || sIdx === sentences.length - 1) {
          sectionChunks.push(currentChunkSentences.join("").trim());
          
          // To implement overlap semantically, we backtrack a few sentences 
          // until we reach approximately CHUNK_OVERLAP_CHARS
          const lastSentences: string[] = [];
          let overlapLength = 0;
          for (let k = currentChunkSentences.length - 1; k >= 0; k--) {
            const sent = currentChunkSentences[k];
            if (!sent) continue;
            if (overlapLength + sent.length > CHUNK_OVERLAP_CHARS && lastSentences.length > 0) break;
            lastSentences.unshift(sent);
            overlapLength += sent.length;
          }
          
          currentChunkSentences = lastSentences;
          currentChunkLength = overlapLength;
        }
      }

      // Apply Context Slop within section and between sections
      for (let j = 0; j < sectionChunks.length; j++) {
        let finalChunkContent = sectionChunks[j];
        if (!finalChunkContent) continue;

        // Prepend slop from previous section if first chunk
        if (j === 0 && i > 0) {
          const prevSection = sections[i - 1];
          if (prevSection) {
            const prevSentences = getSentences(prevSection.content);
            const lastSentence = prevSentences[prevSentences.length - 1];
            if (lastSentence) {
              finalChunkContent = `[Context from ${prevSection.breadcrumb}]: ...${lastSentence}\n\n${finalChunkContent}`;
            }
          }
        }

        // Append slop from next section if last chunk
        if (j === sectionChunks.length - 1 && i < sections.length - 1) {
          const nextSection = sections[i + 1];
          if (nextSection) {
            const nextSentences = getSentences(nextSection.content);
            const firstSentence = nextSentences[0];
            if (firstSentence) {
              finalChunkContent = `${finalChunkContent}\n\n[Context continues in ${nextSection.breadcrumb}]: ${firstSentence}...`;
            }
          }
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
          VALUES ${this.sql(chunksToInsert as any)}
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

  async search(queryText: string, limit: number, rerank: boolean = false) {
    const queryVectorStr = await this.generateEmbeddingString(queryText);
    
    // Hybrid Search: Reciprocal Rank Fusion (RRF)
    // RRF combines the rankings from different search methods to provide a more robust result set.
    // The formula is: score = sum(weight / (k + rank)) where k is a constant (usually 60).
    // We define weights as variables for easy future tuning (currently 1:1 balance).
    const VECTOR_WEIGHT = 1.0;
    const TEXT_WEIGHT = 1.0;
    const K = 60;

    // If reranking, we fetch more results initially to have a better candidate pool
    const initialLimit = rerank ? Math.max(limit * 5, 50) : limit;

    const res = await this.query<{ id: string; file_path: string; heading: string; content: string; distance: number; rrf_score: number }>(`
      WITH vector_search AS (
        SELECT id, row_number() OVER (ORDER BY embedding <=> $1 ASC) as rank
        FROM markdown_chunks
        LIMIT $3 * 2
      ),
      text_search AS (
        SELECT id, row_number() OVER (ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', $2)) DESC) as rank
        FROM markdown_chunks
        WHERE search_vector @@ websearch_to_tsquery('english', $2)
        LIMIT $3 * 2
      )
      SELECT 
        m.id,
        m.file_path, 
        m.heading, 
        m.content, 
        m.last_modified,
        m.word_count,
        COALESCE((m.embedding <=> $1), 1.0) as distance,
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
    `, [queryVectorStr, queryText, initialLimit]);

    let results = res.rows;

    if (rerank && this.rerankerModel && this.rerankerTokenizer) {
      logger.info({ count: results.length }, "Reranking search results via cross-encoder...");
      const passages = results.map(item => `${item.heading}\n${item.content}`);
      const queries = new Array(passages.length).fill(queryText);
      
      const inputs = await this.rerankerTokenizer(queries, {
        text_pair: passages,
        padding: true,
        truncation: true
      });
      
      const { logits } = await this.rerankerModel(inputs);
      
      const reranked = results.map((item, i) => ({
        ...item,
        rerank_score: logits.data[i]
      }));

      results = reranked
        .sort((a, b) => (b as any).rerank_score - (a as any).rerank_score)
        .slice(0, limit);
    }

    return results;
  }

  async getChunkNeighbors(id: number) {
    const chunkRes = await this.query<{ file_path: string }>("SELECT file_path FROM markdown_chunks WHERE id = $1", [id]);
    if (chunkRes.rows.length === 0 || !chunkRes.rows[0]) return null;
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
