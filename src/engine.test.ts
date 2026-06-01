import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { VectorEngine } from "./engine";
import * as fs from "fs";
import * as path from "path";

describe("PGlite Vector Search Engine Core", () => {
  let engine: VectorEngine;
  const mockDocsDir = path.join(process.cwd(), "test-docs-sandbox");

  beforeEach(async () => {
    // In-memory persistent testing instance
    engine = new VectorEngine();
    await engine.initialize();

    // Generate nested directories
    fs.mkdirSync(path.join(mockDocsDir, "nested/layer"), { recursive: true });
    fs.writeFileSync(
      path.join(mockDocsDir, "nested/layer/doc.md"),
      "## Deep Module\nThis is highly isolated custom metadata documentation details."
    );
  });

  afterEach(async () => {
    await engine.destroy();
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
    expect(contents[0]).toContain("This is the first long paragraph");
    expect(contents[0]).toContain("This is the second long paragraph");
    expect(matches[0].heading).toBe("Project Title > Section One");
  });

  test("Should retrieve chunk neighbors correctly", async () => {
    fs.writeFileSync(
      path.join(mockDocsDir, "neighbors.md"),
      "# Root\n\n## Section A\nThis is part A.\n\n## Section B\nThis is part B.\n\n## Section C\nThis is part C."
    );

    await engine.indexDirectory(mockDocsDir);

    const searchRes = await engine.search("Section B", 1);
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
    
    expect(matches.length).toBe(1);
    expect(matches[0].content).not.toContain(base64Content);
    expect(matches[0].content).not.toContain("data:image/png;base64");
    expect(matches[0].content).toContain("This text should be indexed.");
  });
});
