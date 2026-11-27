# Amazing Marvin connector for Claude: deploy guide

This folder holds a small MCP server that runs on Cloudflare Workers (free plan) and gives Claude access to your Amazing Marvin account. Your Marvin token lives only in Cloudflare's secret store. The server answers only at a URL that contains a long random secret you create, so nobody can use it without that URL.

**What's here**
- `worker.js`: the whole server, one file, no dependencies.
- `wrangler.toml`: settings for the command-line deploy (path B).
- `test/test.mjs`: tests against a fake Marvin API (`npm install && npm test`).

**Tools it gives Claude:** `get_today_items`, `get_due_items` (flags overdue), `get_inbox` (your Inbox rules: unfiled, unscheduled, not backburnered, no future start date, recurring leftovers hidden), `get_active_tasks`, `get_children`, `get_categories`, `get_labels`, `create_task`, `mark_done`, `reschedule_task`.

Takes about 15 minutes. Pick path A (browser only) or path B (terminal).

---

## 1. Get your Marvin tokens

1. Open https://app.amazingmarvin.com/pre?api and copy **API_TOKEN**.
2. Optional: also copy **FULL_ACCESS_TOKEN**. Only `reschedule_task` needs it. Skip it if you'd rather Claude couldn't move tasks between days.

## 2. Make the connector secret

In Terminal:

```
openssl rand -hex 32
```

Copy the 64-character result. This is `CONNECTOR_SECRET`. Treat it like a password: anyone with the final URL can read and change your Marvin tasks.

## 3A. Deploy from the browser (no Node needed)

1. Sign in or sign up at https://dash.cloudflare.com (free plan is enough).
2. Go to **Workers & Pages**, choose **Create**, then start from the **Hello World** worker. Name it `amazing-marvin-mcp` and deploy it.
3. Open the new worker, choose **Edit code**, replace everything in the editor with the contents of `worker.js`, and click **Deploy**.
4. Go to the worker's **Settings**, then **Variables and Secrets**, and add these. Choose type **Secret** for the first three:
   - `CONNECTOR_SECRET`: the value from step 2
   - `MARVIN_API_TOKEN`: your API_TOKEN
   - `MARVIN_FULL_ACCESS_TOKEN`: your FULL_ACCESS_TOKEN (optional)
   - `TIMEZONE` (type Text): your IANA time zone, such as `America/Los_Angeles` or `Europe/London`
5. Save and deploy. Note the worker's address, like `https://amazing-marvin-mcp.<your-subdomain>.workers.dev`.

Cloudflare's menu names shift now and then; if a label differs, look for the closest match.

## 3B. Deploy from the terminal (Node 18+)

First set `TIMEZONE` in `wrangler.toml` to your IANA time zone (it defaults to `America/Los_Angeles`).

```
cd amazing-marvin-mcp-worker
npm install
npm test                      # optional: 23 tests against a fake Marvin
npx wrangler login            # opens Cloudflare in your browser
npx wrangler secret put CONNECTOR_SECRET
npx wrangler secret put MARVIN_API_TOKEN
npx wrangler secret put MARVIN_FULL_ACCESS_TOKEN   # optional
npx wrangler deploy
```

Each `secret put` asks you to paste the value at a hidden prompt. `deploy` prints the worker's address.

(`wrangler secret put` before the first deploy may offer to create the worker; say yes.)

## 4. Check it's alive

Replace the two placeholders and run:

```
curl -s -X POST "https://amazing-marvin-mcp.<your-subdomain>.workers.dev/mcp/<CONNECTOR_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_inbox","arguments":{}}}'
```

You should see your Inbox items as JSON. `Not found` means the secret in the URL doesn't match. An error mentioning 401 or 403 means the Marvin token is wrong.

## 5. Add it to Claude

1. In Claude, open **Settings**, then **Connectors**.
2. If you already have another Amazing Marvin connector, remove or disconnect it.
3. Choose **Add custom connector**. Name: `Amazing Marvin`. URL:
   `https://amazing-marvin-mcp.<your-subdomain>.workers.dev/mcp/<CONNECTOR_SECRET>`
   Leave the OAuth fields empty.
4. Ask Claude "What's in my Marvin inbox?" to confirm.

---

## Options

- **Read-only:** add a Text variable `READ_ONLY` = `true`. Claude then sees only the seven read tools.
- **Active tasks exclusions:** `EXCLUDED_CATEGORIES` (default `Lists,Inbox`) lists category titles that `get_active_tasks` skips along with their sub-projects.
- **Change the secret:** set a new `CONNECTOR_SECRET`, then update the connector URL in Claude. The old URL stops working at once.
- **Token hygiene:** if your Marvin token has been stored with another service before, consider rotating both tokens in Marvin's API settings and saving the new ones as the same secrets in Cloudflare.

## Limits worth knowing

- Cloudflare's free plan allows 100,000 requests a day and 50 outbound calls per request. `get_active_tasks` makes one call per category, so it reads at most 38 categories and says which it skipped. The other tools use two or three calls each.
- Marvin's API doesn't expose Smart Lists, and recurring tasks marked done here may only spawn their next copy when the Marvin app syncs.
- The server keeps no data and no logs of its own. Cloudflare's dashboard logs may show request URLs, including the secret, to you only.
