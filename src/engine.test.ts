import { expect, test, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { VectorEngine } from "./engine";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("PGlite Vector Search Engine Core", () => {
  let engine: VectorEngine;
  const mockDocsDir = path.join(process.cwd(), "test-docs-sandbox");
  const testDbDir = path.join(os.tmpdir(), `raglike-test-${Math.random().toString(36).slice(2)}`);

  beforeAll(async () => {
    if (!fs.existsSync(testDbDir)) fs.mkdirSync(testDbDir, { recursive: true });
    engine = new VectorEngine(testDbDir);
    await engine.initialize();
  });

  afterAll(async () => {
    await engine.destroy();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    // Generate nested directories
    fs.mkdirSync(path.join(mockDocsDir, "nested/layer"), { recursive: true });
    fs.writeFileSync(
      path.join(mockDocsDir, "nested/layer/doc.md"),
      "## Deep Module\nThis is highly isolated custom metadata documentation details."
    );
  });

  afterEach(async () => {
    // Clear data between tests instead of destroying engine
    if (engine) {
      // @ts-ignore - accessing private for testing
      await engine.exec("DELETE FROM markdown_chunks;");
    }
    if (fs.existsSync(mockDocsDir)) {
      fs.rmSync(mockDocsDir, { recursive: true, force: true });
    }
  });

  test("Should recursively ingest nested folder layers and retrieve items semantically", async () => {
    await engine.indexDirectory(mockDocsDir);

    // Validate structural storage execution matching semantic vectors
    const query = "isolated custom metadata";
    const matches = await engine.search(query, 1);

    expect(matches.length).toBe(1);
    expect(matches[0].heading).toBe("Deep Module");
    expect(matches[0].content).toContain("highly isolated");
  });

  test("Should split sections into multiple granular chunks with context awareness", async () => {
    fs.writeFileSync(
      path.join(mockDocsDir, "granular.md"),
      "# Project Title\n\n## Section One\nThis is the first long paragraph that should be indexed as its own chunk because it is over fifty characters long.\n\nThis is the second long paragraph that should also be indexed separately to provide granular results."
    );

    await engine.indexDirectory(mockDocsDir);

    const matches = await engine.search("first long paragraph", 5);
    
    expect(matches.length).toBeGreaterThanOrEqual(1);
    
    const contents = matches.map(m => m.content);
    expect(contents.some(c => typeof c === 'string' && c.includes("This is the first long paragraph"))).toBe(true);
    expect(contents.some(c => typeof c === 'string' && c.includes("This is the second long paragraph"))).toBe(true);
    expect(matches[0].heading).toContain("Section One");
  });

  test("Should retrieve chunk neighbors correctly", async () => {
    fs.writeFileSync(
      path.join(mockDocsDir, "neighbors.md"),
      "# Root\n\n## Section A\nThis is part A.\n\n## Section B\nThis is part B.\n\n## Section C\nThis is part C."
    );

    await engine.indexDirectory(mockDocsDir);

    const searchRes = await engine.search("Section B", 1);
    expect(searchRes.length).toBe(1);
    const chunkId = parseInt(searchRes[0].id);
    
    const neighbors = await engine.getChunkNeighbors(chunkId);
    
    expect(neighbors).not.toBeNull();
    // Section B should have both A and C as neighbors in this 3-section file
    expect(neighbors?.previous?.content).toContain("This is part A");
    expect(neighbors?.next?.content).toContain("This is part C");
  });

  test("Should filter out base64 image data during ingestion", async () => {
    const base64Content = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
    fs.writeFileSync(
      path.join(mockDocsDir, "base64.md"),
      `# Image Test\n\n![Alt text](data:image/png;base64,${base64Content})\n\n<img src="data:image/png;base64,${base64Content}" />\n\nThis text should be indexed.`
    );

    await engine.indexDirectory(mockDocsDir);

    const matches = await engine.search("Image Test", 1);
    
    // Debug search results if failing
    if (matches[0]?.content.includes("isolated custom metadata")) {
        console.log("DEBUG: Search for 'Image Test' matched wrong chunk!");
        console.log("Matches:", JSON.stringify(matches, null, 2));
    }

    expect(matches.length).toBe(1);
    expect(matches[0].content).not.toContain(base64Content);
    expect(matches[0].content).not.toContain("data:image/png;base64");
    expect(matches[0].content).toContain("This text should be indexed.");
  });

  test("Should prioritize keyword matches in headings (Weighted Search)", async () => {
    fs.writeFileSync(
      path.join(mockDocsDir, "weighted.md"),
      "# UniqueTitleKeyword\nThis is some filler content.\n\n## Other Section\nThis section contains the UniqueTitleKeyword in its content but not its heading."
    );

    await engine.indexDirectory(mockDocsDir);

    const matches = await engine.search("UniqueTitleKeyword", 2);
    
    expect(matches.length).toBe(2);
    // The chunk with the keyword in the heading should be ranked first
    expect(matches[0].heading).toBe("UniqueTitleKeyword");
  });

  test("Should apply cross-encoder reranking and return rerank_score", async () => {
    fs.writeFileSync(path.join(mockDocsDir, "c1.md"), "# Postgres\nPostgres is a great database for vectors.");
    fs.writeFileSync(path.join(mockDocsDir, "c2.md"), "# Search\nVectors are used for semantic search.");
    fs.writeFileSync(path.join(mockDocsDir, "c3.md"), "# Data\nRelational databases store tables.");
  
    await engine.indexDirectory(mockDocsDir);
  
    const query = "semantic search with vectors";
    
    // Test without reranking
    const noRerank = await engine.search(query, 3, false);
    expect(noRerank.length).toBeGreaterThan(0);
    expect((noRerank[0] as any).rerank_score).toBeUndefined();

    // Test with reranking
    const withRerank = await engine.search(query, 3, true);
    expect(withRerank.length).toBe(3);
    expect((withRerank[0] as any).rerank_score).toBeDefined();
    
    // Sorting verification
    expect((withRerank[0] as any).rerank_score).toBeGreaterThanOrEqual((withRerank[1] as any).rerank_score);
    expect((withRerank[1] as any).rerank_score).toBeGreaterThanOrEqual((withRerank[2] as any).rerank_score);
    
    // Semantic match verification
    expect(withRerank[0].heading).toBe("Search");
  });
});
