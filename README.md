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
| `MEAL_API_URL` | Your Netlify site URL, e.g. `https://scw-meal-tracker.netlify.app` |
| `MEAL_API_TOKEN` | Same value as the site's `MEAL_API_TOKEN` env var |
| `MCP_AUTH_TOKEN` | Secret protecting this server, from `openssl rand -hex 32`. Strongly recommended, and required if the server is reachable from the internet |
| `TIMEZONE` | IANA zone used for the default date and time, e.g. `America/New_York` |
| `PORT` | Default `3030` |
| `TUNNEL_TOKEN` | Only for the Cloudflare Tunnel setup below |

With `MCP_AUTH_TOKEN` set, clients connect in one of two ways:
- `/mcp/<MCP_AUTH_TOKEN>`: the token goes in the URL. Use this for the Claude apps, whose custom connectors only take a URL.
- `/mcp` with an `Authorization: Bearer <MCP_AUTH_TOKEN>` header.

## Deploy on a home server with Cloudflare Tunnel

This gives you a public HTTPS URL without opening router ports, so Claude on your phone and claude.ai can reach the server.

1. **Get the code and configure it** on the server:
   ```bash
   git clone https://github.com/scwambach/meal-tracker-mcp.git && cd meal-tracker-mcp && cp .env.example .env
   ```
   Fill in `MEAL_API_URL`, `MEAL_API_TOKEN`, `MCP_AUTH_TOKEN` and `TIMEZONE`.

2. **Create the tunnel** in the Cloudflare dashboard. You need a domain on Cloudflare.
   - Go to Zero Trust → Networks → Tunnels → Create a tunnel → **Cloudflared**, and name it e.g. `meal-tracker`.
   - On the install step, copy the token from the shown command (the long string after `--token`) into `TUNNEL_TOKEN` in `.env`. You don't need to run the command.
   - Add a public hostname, e.g. `meals-mcp.yourdomain.com`, with service type **HTTP** and URL **`meal-tracker-mcp:3030`**.

3. **Start it:**
   ```bash
   docker compose --profile tunnel up -d
   ```
   Check it with `curl https://meals-mcp.yourdomain.com/health`, which should print `ok`.

4. **Connect Claude:** on claude.ai, go to Settings → Connectors → **Add custom connector** and enter:
   ```
   https://meals-mcp.yourdomain.com/mcp/<MCP_AUTH_TOKEN>
   ```
   Connectors added on claude.ai are also available in the Claude mobile apps.

**Updating:** every push to `main` publishes a new image to `ghcr.io/scwambach/meal-tracker-mcp:latest` (amd64 and arm64). To update, run `docker compose --profile tunnel pull && docker compose --profile tunnel up -d`. On a NAS Docker app, use its pull/redeploy button.

**Logs:** `docker compose logs -f meal-tracker-mcp`

## Other ways to run

Without the tunnel (home network only):

```bash
docker compose up -d --build
```

Or with Node 22.18+ directly (TypeScript runs natively, so there's no build step):

```bash
npm install
node --env-file=.env src/http.ts
```

**Claude Code / Claude Desktop on your network:**

```bash
claude mcp add --transport http meal-tracker http://<host>:3030/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**Claude Desktop over stdio** (runs locally, no server needed). Add to `claude_desktop_config.json`:

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
