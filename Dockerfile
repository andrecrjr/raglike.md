# Stage 1: Build and Cache Model Assets
FROM oven/bun:latest AS builder
WORKDIR /app

COPY package.json ./
RUN bun install

COPY . .

# Pre-cache the embedding and reranker models during build time into a specific directory
RUN mkdir -p /app/.cache && \
    HF_HOME=/app/.cache bun -e "import { pipeline } from '@huggingface/transformers'; await pipeline('feature-extraction', 'Xenova/all-mpnet-base-v2'); await pipeline('text-classification', 'Xenova/bge-reranker-base');"

# Stage 2: Runtime Minimal Environment
FROM oven/bun:latest AS runner
WORKDIR /app

# Create necessary directories
RUN mkdir -p .logs docs

# Pull cached assets and files into the execution stage
# Copy the HF cache to the expected location for the runner
COPY --from=builder /app/.cache /root/.cache
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/index.html ./index.html

# Ensure HF_HOME is set so it finds the cached models
ENV HF_HOME=/root/.cache
# Expose API layer port
EXPOSE 4321

# Run the system
ENTRYPOINT ["bun", "run", "src/index.ts"]
