import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./mcp.ts";

const PORT = Number(process.env.PORT ?? 3030);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

function authorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;
  const given = Buffer.from(req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(AUTH_TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const http = createHttpServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (path !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (req.method !== "POST") {
    // Stateless server: no SSE stream or session to GET/DELETE.
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }

  try {
    const body = await readJson(req);
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }),
      );
    }
  }
});

http.listen(PORT, () => {
  console.log(`meal-tracker MCP listening on http://0.0.0.0:${PORT}/mcp${AUTH_TOKEN ? " (bearer auth on)" : ""}`);
});
