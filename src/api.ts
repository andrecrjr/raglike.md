import { VectorEngine } from "./engine";
import { logger } from "./logger";

export function startHttpServer(engine: VectorEngine) {
  Bun.serve({
    port: 4321,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);
      
      // Serve index.html on the root path
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(Bun.file("index.html"));
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
      return new Response("Not Found", { status: 404 });
    }
  });
  logger.info("HTTP Server online running on 0.0.0.0:4321.");
}
