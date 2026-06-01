import { VectorEngine } from "./engine";
import { logger } from "./logger";
import * as path from "path";
import pdf2md from "pdf2md-ts";
import { readdir } from "node:fs/promises";
import * as fs from "node:fs";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./mcp";
import { randomUUID } from "node:crypto";

export async function startHttpServer(engine: VectorEngine) {
  const includeMcp = process.env.ENABLE_MCP === "true" || Bun.argv.includes("--mcp");
  let mcpTransport: WebStandardStreamableHTTPServerTransport | undefined;

  if (includeMcp) {
    // Initialize stateful transport with session support
    mcpTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });
    const mcpServer = createMcpServer(engine);
    await mcpServer.connect(mcpTransport);
    logger.info("MCP Layer integrated into HTTP server via /mcp endpoint (Stateful SSE).");
  }

  const server = Bun.serve({
    port: 4321,
    hostname: process.env.HOST || "0.0.0.0",
    idleTimeout: 0, // Disable timeout to support long-lived MCP SSE connections
    async fetch(req) {
      const url = new URL(req.url);
      
      // MCP HTTP Transport endpoint
      if (includeMcp && mcpTransport && url.pathname === "/mcp") {
        return await mcpTransport.handleRequest(req);
      }

      // Serve index.html on the root path
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const indexPath = path.join(process.cwd(), "index.html");
        return new Response(Bun.file(indexPath));
      }

      if (req.method === "GET" && url.pathname === "/list-docs") {
        try {
          const docsDir = path.join(process.cwd(), "docs");
          const entries = await readdir(docsDir, { recursive: true, withFileTypes: true });
          
          const docs = await Promise.all(entries
            .filter(e => e.isFile() && e.name.endsWith(".md"))
            .map(async (e) => {
              const relativePath = path.join(path.relative(docsDir, e.parentPath), e.name).replace(/^\.\//, "");
              const fullPath = path.join(e.parentPath, e.name);
              const stats = fs.statSync(fullPath);
              return {
                name: e.name,
                path: "docs/" + relativePath,
                lastModified: stats.mtime,
                size: stats.size
              };
            })
          );
          
          return Response.json({ success: true, docs });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      if (req.method === "GET" && url.pathname === "/read") {
        const filePath = url.searchParams.get("path");
        if (!filePath) return Response.json({ error: "Missing path parameter" }, { status: 400 });
        
        try {
          const content = await engine.readDocument(filePath);
          if (content === null) return Response.json({ error: "File not found" }, { status: 404 });
          return Response.json({ success: true, content });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 403 });
        }
      }

      if (req.method === "DELETE" && url.pathname === "/doc") {
        const filePath = url.searchParams.get("path");
        if (!filePath) return Response.json({ error: "Missing path parameter" }, { status: 400 });

        try {
          const fullPath = path.resolve(process.cwd(), filePath);
          if (!fullPath.startsWith(process.cwd())) throw new Error("Security violation");

          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
          await engine.removeDocument(filePath);
          return Response.json({ success: true });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      if (req.method === "POST" && url.pathname === "/search") {
        try {
          const body = await req.json() as { query: string; limit?: number };
          const results = await engine.search(body.query, body.limit || 3);
          return Response.json({ success: true, results });
        } catch (err: any) {
          logger.error(err, "HTTP Endpoint request error encountered");
          return Response.json({ error: "Invalid Request Payload Data" }, { status: 400 });
        }
      }

      if (req.method === "POST" && url.pathname === "/upload") {
        try {
          const formData = await req.formData();
          const file = formData.get("file") as File;
          if (!file) return Response.json({ error: "No file uploaded" }, { status: 400 });

          const buffer = await file.arrayBuffer();
          let targetPath: string;
          
          if (file.name.endsWith(".pdf")) {
            const markdown = await pdf2md(new Uint8Array(buffer));
            const filename = file.name.replace(".pdf", ".md");
            targetPath = path.join("docs", filename);
            await Bun.write(targetPath, markdown);
          } else if (file.name.endsWith(".md")) {
            targetPath = path.join("docs", file.name);
            await Bun.write(targetPath, buffer);
          } else {
            return Response.json({ error: "Unsupported file type. Please upload .md or .pdf" }, { status: 400 });
          }
          
          // Re-index the document immediately (idempotent due to internal removeDocument call)
          await engine.indexSingleFile(path.resolve(process.cwd(), targetPath));
          
          return Response.json({ success: true, path: targetPath });
        } catch (err: any) {
          logger.error(err, "File upload error");
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      return new Response("Not Found", { status: 404 });
    }
  });
  logger.info(`server is running in ${server.hostname}:${server.port}`);
}
