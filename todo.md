# Project Roadmap & Improvements

This document tracks planned features and enhancements for the `search-docs-api` project, prioritized by implementation complexity.

## 🟢 Phase 1: High Impact / Low Complexity (Easiest)

- [ ] **Hierarchical Context Enrichment**
    - [ ] Implement recursive breadcrumb headers (e.g., `H1 > H2 > H3`) for all chunks to improve semantic signal.
    - [ ] Add "Context Slop": Include the last sentence of the previous section and the first sentence of the next section in each chunk to prevent context loss at boundaries.
- [ ] **Enhanced Document Metadata**
    - [ ] Store file modification times in the database to allow "sort by recent" queries.
    - [ ] Add a `word_count` property to chunks to help the search engine prioritize more substantial content.
- [ ] **Improved Logging & Debugging**
    - [ ] Add a `--verbose` flag to see the exact text being embedded during indexing.
    - [ ] Log the similarity score (distance) to the console during MCP tool calls.

## 🟡 Phase 2: Medium Complexity

- [ ] **Persistent Vector Store**
    - [ ] Configure PGlite to store the database on disk instead of in-memory.
    - [ ] Implement a startup check to skip indexing if the documentation hasn't changed.
- [ ] **Hybrid Search (Vector + Keyword)**
    - [ ] Add a `tsvector` column to the `markdown_chunks` table.
    - [ ] Implement a weighted search that combines `pgvector` distance with Postgres Full-Text Search scores.
- [ ] **Incremental Indexing (File Watching)**
    - [ ] Use `chokidar` to monitor the `docs/` folder.
    - [ ] Automatically update/delete specific chunks in the database when a markdown file is changed or removed.

## 🔴 Phase 3: High Complexity / Long-Term

- [ ] **Contextual Reranking**
    - [ ] Integrate a Cross-Encoder model (e.g., `BGE-Reranker`) to re-score top search results for better precision.
    - [ ] Implement "Query Expansion" where an LLM rephrases the user query into multiple variations before searching.
- [ ] **Remote Source Syncing**
    - [ ] Add connectors for Notion or GitHub Wiki to pull and index remote documentation.
- [ ] **Search Analytics Dashboard**
    - [ ] Create a small web-based UI to visualize search accuracy and identify documentation gaps.
