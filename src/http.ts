import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./mcp.ts";

const PORT = Number(process.env.PORT ?? 3030);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

function matches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// With MCP_AUTH_TOKEN set, a client proves itself either with an "Authorization: Bearer" header
// on /mcp, or by putting the token in the path (/mcp/<token>) for clients like the Claude apps
// whose custom connectors can only be given a URL.
function authorized(req: IncomingMessage, path: string): boolean {
  if (!AUTH_TOKEN) return path === "/mcp";
  if (path === "/mcp") return matches(req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");
  return path.startsWith("/mcp/") && matches(path.slice("/mcp/".length));
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
  if (path !== "/mcp" && !path.startsWith("/mcp/")) {
    res.writeHead(404).end();
    return;
  }
  if (!authorized(req, path)) {
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
  console.log(`meal-tracker MCP listening on port ${PORT}`);
  if (AUTH_TOKEN) console.log("Auth on: use /mcp with a Bearer token, or /mcp/<MCP_AUTH_TOKEN>");
  else console.warn("MCP_AUTH_TOKEN is not set: anyone who can reach /mcp can change your meal log");
});
