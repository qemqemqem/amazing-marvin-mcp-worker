# Amazing Marvin MCP server for Cloudflare Workers

A small remote [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) read and update your [Amazing Marvin](https://amazingmarvin.com) tasks. It is one file (`worker.js`) with no runtime dependencies, and it runs on Cloudflare Workers' free plan.

You host your own copy. Your Marvin token stays in your own Cloudflare account's secret store, and nobody else's server sees it.

## Tools

| Tool | What it does |
| --- | --- |
| `get_today_items` | Tasks scheduled for a day (default today), including rollovers |
| `get_due_items` | Open items due on or before a date; flags overdue ones |
| `get_inbox` | The Inbox as the app shows it: unfiled, unscheduled, not backburnered, no future start date |
| `get_active_tasks` | Open tasks across all categories, skipping `Lists`, `Inbox` and backburnered ones |
| `get_children` | Items directly inside one category or project |
| `get_categories`, `get_labels` | Ids and names, for the other tools |
| `create_task` | New task; the title accepts Marvin shortcuts like `+today` and `#Category` |
| `mark_done` | Mark a task done |
| `reschedule_task` | Move a task to another day (needs the full-access token) |

Set `READ_ONLY = "true"` to expose only the seven read tools.

## How access is controlled

The server answers only at `/mcp/<CONNECTOR_SECRET>`, a random 64-character secret you create. Any other request gets `404 Not found`. The URL is the credential, so treat it like a password. `Authorization: Bearer <CONNECTOR_SECRET>` on `/mcp` also works, for clients that send headers.

The server is stateless and stores nothing. It talks only to `serv.amazingmarvin.com`.

## Deploy

See [DEPLOY.md](DEPLOY.md): about 15 minutes, from either the Cloudflare dashboard or the terminal. Then add it in Claude under **Settings > Connectors > Add custom connector**, with the OAuth fields left empty.

## Test

```
npm install
npm test
```

The 23 tests run the worker against a fake Marvin API and use the official MCP SDK client for the handshake.

## Limits

- Cloudflare's free plan allows 50 outbound requests per invocation, so `get_active_tasks` reads at most 38 categories and lists any it skipped.
- Marvin's API does not expose Smart Lists.
- Recurring tasks marked done here may spawn their next copy only when the Marvin app syncs.

## License

MIT. See [LICENSE](LICENSE).
