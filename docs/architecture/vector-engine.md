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
We use the **Xenova/all-mpnet-base-v2** model.
- **Dimensions**: 768
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

## Stage 2: Cross-Encoder Reranking
For high-precision requirements, the engine supports an optional second stage of retrieval using a **Cross-Encoder** (`Xenova/bge-reranker-base`).

### How it Works
While Stage 1 (Bi-Encoders) is fast because it compares pre-computed vectors, it can sometimes miss nuances in how a query relates to a specific document. The Cross-Encoder solves this by processing the **query and the candidate document together** in a single transformer pass. This allows the model to attend to the specific interactions between every word in the query and every word in the document.

### Performance & Latency Trade-offs
Users will notice that enabling `rerank: true` is significantly slower (often 5x-10x) than standard search. This is due to several architectural factors:

1. **Computational Complexity**: Unlike vector search which is a simple mathematical dot product, a Cross-Encoder requires a full forward pass of a transformer model for **every single candidate**.
2. **Candidate Expansion**: To ensure the reranker has a high-quality pool to work with, the engine automatically expands the initial retrieval limit to **50 candidates** (or `limit * 5`). Each of these 50 pairs must be processed by the model.
3. **CPU-Bound Inference**: In most local environments, these models run on the CPU. While the embedding model (Stage 1) only runs once per query, the reranker runs $N$ times per query.
4. **Batch Overhead**: Even with batching, processing 50 text-pairs through a BERT-scale model is a heavy operation compared to the sub-millisecond lookups of an HNSW index.

**Recommendation**: Use reranking when precision is critical (e.g., answering complex technical questions) and standard hybrid search when speed is the priority.


