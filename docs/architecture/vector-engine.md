# Vector Engine Details

The `VectorEngine` class manages the lifecycle of document indexing and retrieval.

## Embedding Model
We use the **Xenova/all-MiniLM-L6-v2** model.
- **Dimensions**: 384
- **Runtime**: Local execution via `@xenova/transformers`. No external API calls are made for embedding generation.
- **Pooling/Normalization**: Uses mean pooling and normalization for optimal cosine similarity results.

## Database (PGlite)
[PGlite](https://pglite.dev/) is used as the local database.
- **WASM-powered**: Runs entirely in-process.
- **Vector Extension**: Enables efficient vector storage and search.
- **Schema**:
  ```sql
  CREATE TABLE markdown_chunks (
    id BIGSERIAL PRIMARY KEY,
    file_path TEXT,
    heading TEXT,
    content TEXT,
    embedding vector(384)
  );
  ```

## Indexing Strategy
1. **File Discovery**: Recursively finds all `.md` files in the target directory.
2. **Chunking**: Splits files into sections using header boundaries (`##+`).
3. **Storage**: Each section's heading and content are combined, embedded, and stored in the database.
4. **Persistence**: Currently, the database is in-memory for the duration of the process.

## Search Mechanism
Search is performed using the cosine distance operator `<=>` provided by the `pgvector` extension in PGlite. Results are ordered by distance (ascending) and limited to the requested count.
