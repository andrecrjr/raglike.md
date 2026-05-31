# Search Protocol

This document defines the semantic search protocol used between the server components and the engine.

## Query Protocol
All search requests must provide a conceptual query string.

### MCP Tool: `semantic_markdown_search`
- **Arguments**:
  - `query` (string): The natural language query.
  - `limit` (number, optional): Max results to return (default: 3).

### HTTP API: `/search`
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`
- **Body**:
  ```json
  {
    "query": "string",
    "limit": number
  }
  ```

## Response Protocol
The response is a collection of markdown chunks that most closely match the query.

### Data Format
Each match includes:
- `file_path`: Path to the source markdown file.
- `heading`: The nearest header for the chunk.
- `content`: The actual text content.
- `distance`: The cosine distance score (lower is more similar).

### MCP Output
Matches are formatted as a single markdown string containing the file path, heading, score, and content for each result.

### HTTP JSON Response
```json
{
  "success": true,
  "results": [
    {
      "file_path": "...",
      "heading": "...",
      "content": "...",
      "distance": 0.1234
    }
  ]
}
```
