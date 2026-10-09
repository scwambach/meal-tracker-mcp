# meal-tracker-mcp

A self-hosted MCP server that lets Claude log meals to [meal-tracker](https://github.com/scwambach/meal-tracker).

Send Claude a photo of what you ate. Claude identifies the foods, estimates portions, calories and macros from its own knowledge (no food database), and asks clarifying questions when something is ambiguous, like the cooking oil, a sauce, the portion size, or what's in a drink. Then it logs the meal. The photo stays in your Claude conversation and is never sent to this server.

## Tools

| Tool | Purpose |
| --- | --- |
| `log_meal` | Save a meal (per-item calories/protein/carbs/fat/fiber, confidence, assumptions) and report calories left today and this week |
| `get_progress` | Calories and macros eaten vs. goals for a day and its week |
| `list_meals` | Meals and daily totals for a date range (default: last 7 days) |
| `get_meal` | Full detail for one meal |
| `update_meal` | Correct a meal ("it was actually two tortillas") |
| `delete_meal` | Remove a meal |

There's also a `log_meal_from_photo` prompt. The server's instructions tell Claude to ask before logging whenever it's unsure about something that would change the estimate.

## Configure

```bash
cp .env.example .env
```

| Variable | |
| --- | --- |
| `MEAL_API_URL` | Your Netlify site URL |
| `MEAL_API_TOKEN` | Same value as the site's `MEAL_API_TOKEN` env var |
| `MCP_AUTH_TOKEN` | Optional. If set, clients must send `Authorization: Bearer <token>` |
| `TIMEZONE` | IANA zone used for the default date and time, e.g. `America/New_York` |
| `PORT` | Default `3030` |

## Run

With Docker (recommended for a home server):

```bash
docker compose up -d --build
```

Or with Node 22.18+ directly (TypeScript runs natively, so there's no build step):

```bash
npm install
node --env-file=.env src/http.ts
```

The MCP endpoint is `http://<host>:3030/mcp`, and the health check is `/health`.

## Connect Claude

**Claude Desktop / Claude Code on your network.** Add it as a remote HTTP server:

```bash
claude mcp add --transport http meal-tracker http://<host>:3030/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**Claude Desktop over stdio** (runs locally, so no server is needed). Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meal-tracker": {
      "command": "node",
      "args": ["--env-file=/path/to/meal-tracker-mcp/.env", "/path/to/meal-tracker-mcp/src/stdio.ts"]
    }
  }
}
```

**Claude on your phone or claude.ai.** Custom connectors are reached from Anthropic's servers, so the endpoint must be reachable over public HTTPS, e.g. through a Cloudflare Tunnel or Tailscale Funnel to port 3030. Add it under Settings → Connectors → Add custom connector. Custom connectors there can't send a static bearer header, so leave `MCP_AUTH_TOKEN` unset and protect the tunnel instead (e.g. Cloudflare Access). Otherwise anyone who finds the URL can write to your log.
