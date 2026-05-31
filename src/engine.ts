import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pipeline } from "@xenova/transformers";
import { logger } from "./logger";
import * as fs from "fs";
import * as path from "path";

export class VectorEngine {
  private pg!: PGlite;
  private extractor: any;

  async initialize() {
    this.extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    this.pg = await PGlite.create({ extensions: { vector } });
    
    await this.pg.exec("CREATE EXTENSION IF NOT EXISTS vector;");
    await this.pg.exec(`
      CREATE TABLE IF NOT EXISTS markdown_chunks (
        id BIGSERIAL PRIMARY KEY,
        file_path TEXT,
        heading TEXT,
        content TEXT,
        embedding vector(384)
      );
    `);
    logger.info("PGlite Vector Engine database subsystem fully ready.");
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

    for (const filePath of targetFiles) {
      const relativePath = path.relative(process.cwd(), filePath);
      const rawContent = fs.readFileSync(filePath, "utf-8");
      
      // Extract H1 title if present
      const h1Match = rawContent.match(/^# (.*)$/m);
      const h1Title = h1Match ? h1Match[1].trim() : "";

      const sections = rawContent.split(/(?=^##+ )/m);

      for (const section of sections) {
        const lines = section.split("\n");
        const heading = lines[0].startsWith("#") ? lines[0].trim() : "General";
        const content = lines.slice(1).join("\n").trim();

        if (content.length > 5) {
          // Prepend H1 context to improve semantic search relevancy
          const contextPrefix = h1Title && !heading.includes(h1Title) ? `${h1Title} > ` : "";
          const vectorString = await this.generateEmbeddingString(`${contextPrefix}${heading}\n${content}`);
          await this.pg.query(
            "INSERT INTO markdown_chunks (file_path, heading, content, embedding) VALUES ($1, $2, $3, $4)",
            [relativePath, heading, content, vectorString]
          );
        }
      }
    }
    logger.info({ totalFiles: targetFiles.length }, "Recursive workspace folder ingestion complete.");
  }

  async search(queryText: string, limit: number) {
    const queryVectorStr = await this.generateEmbeddingString(queryText);
    
    // Uses the dedicated <=> operator for cosine distance metrics execution
    const res = await this.pg.query<{ file_path: string; heading: string; content: string; distance: number }>(`
      SELECT file_path, heading, content, (embedding <=> $1) as distance
      FROM markdown_chunks
      ORDER BY distance ASC
      LIMIT $2;
    `, [queryVectorStr, limit]);

    return res.rows;
  }

  async destroy() {
    await this.pg.close();
  }
}
