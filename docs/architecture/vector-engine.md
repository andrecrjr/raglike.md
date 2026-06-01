# Vector Engine Details

The `VectorEngine` class manages the lifecycle of document indexing and retrieval, supporting both local and distributed database backends.

## Dual Database Architecture
The engine dynamically selects its storage backend based on the environment:
1. **External Postgres**: If `POSTGRES_URL` is set, the engine uses the `postgres.js` client to connect to an external database.
2. **Local PGlite**: If running locally without a URL, it uses an embedded PGlite instance.
3. **Docker Auto-Discovery**: When running in Docker, it defaults to the `db:5432` service if no `POSTGRES_URL` is provided.

## Smart Chunking Strategy
To provide precise context to AI models while maintaining continuity, the engine uses an advanced **Hierarchical Sliding Window with Context Slop** strategy:

1. **Hierarchical Breadcrumbs**: Unlike simple title-prepending, the engine now parses the full document structure iteratively. Every chunk is prefixed with its complete breadcrumb path (e.g., `H1 > H2 > H3 > H4`). This ensures that even deeply nested content retains its full semantic context when retrieved in isolation.
2. **Context Slop (Boundary Enrichment)**: To prevent semantic fragmentation at chunk and section boundaries, we implement "Context Slop."
   - The **last sentence** of the previous section is prepended to the first chunk of the current section.
   - The **first sentence** of the following section is appended to the last chunk of the current section.
   - This "semantic glue" allows the LLM to understand what preceded and what follows a specific retrieval, improving coherence.
3. **Sliding Window**: Each section is divided into chunks of ~600 characters with a 120-character overlap.
4. **Natural Breaks**: The engine attempts to find natural breaks (periods or newlines) at the end of each window to keep chunks readable.
5. **Metadata Tagging**: Each chunk is indexed with its `word_count` and `last_modified` timestamp, allowing for more advanced filtering and "sort by recent" query capabilities.
6. **Filtering**: Chunks shorter than 5 characters (previously 50) are now indexed to ensure short but critical technical data is searchable.

## Embedding Model
We use the **Xenova/all-MiniLM-L6-v2** model.
- **Dimensions**: 384
- **Runtime**: Local execution via `@xenova/transformers`.
- **Normalization**: Vectors are normalized to ensure accurate cosine similarity measurements.

## Performance: Parallelism & Indexing
- **Parallel Processing**: Ingestion uses a concurrency-limited parallel strategy to embed and index multiple files/chunks simultaneously, maximizing CPU utilization.
- **Batch Inserts**: Chunks are collected and inserted into the database in bulk, minimizing transaction overhead.
- **HNSW Acceleration**: A Hierarchical Navigable Small World (HNSW) index is automatically applied to the `embedding` column, enabling sub-second search performance even as the document count grows into the tens of thousands.
- **Fast Restart**: On initialization, the engine checks for existing data. If found, auto-indexing is skipped.

## Hybrid Search Mechanism
Search is performed using a multi-signal ranking system:
1. **Semantic Search**: Uses the cosine distance operator `<=>` (provided by `pgvector`) to find conceptual matches.
2. **Full-Text Search**: Uses Postgres `tsvector` and `ts_rank_cd` with a GIN index to find exact keyword matches (e.g., function names, error codes).
3. **Reciprocal Rank Fusion (RRF)**: Results from both vector and keyword searches are combined using the RRF algorithm. This provides a more robust and precise ranking by rewarding documents that appear in both result sets, ensuring that technical specificity and semantic meaning are perfectly balanced.


