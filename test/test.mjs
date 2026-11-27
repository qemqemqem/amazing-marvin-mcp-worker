// Tests for worker.js against a mocked Amazing Marvin API.
// Run: npm install && npm test
// The worker is served through a small Node HTTP adapter, and the official
// MCP SDK client talks to it, so the handshake is checked by a real client.

import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker, { _internal } from "../worker.js";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const BASE_ENV = {
  CONNECTOR_SECRET: SECRET,
  MARVIN_API_TOKEN: "limited-token-XYZ",
  TIMEZONE: "America/Los_Angeles",
};

// ------------------------------------------------------------ mock Marvin

const cats = [
  { _id: "work", title: "Work", parentId: "root", type: "category" },
  { _id: "proj1", title: "Launch", parentId: "work", type: "project" },
  { _id: "lists", title: "Lists", parentId: "root", type: "category" },
  { _id: "books", title: "Books", parentId: "lists", type: "project" },
  { _id: "bb", title: "Someday", parentId: "root", type: "category", backburner: true },
  { _id: "bbchild", title: "Someday child", parentId: "bb", type: "project" },
  { _id: "inboxcat", title: "Inbox", parentId: "root", type: "category" },
];
const labels = [{ _id: "l1", title: "quick" }];
const children = {
  unassigned: [
    { _id: "in1", title: "Captured idea", parentId: "unassigned", day: "unassigned" },
    { _id: "in2", title: "No day field", parentId: "unassigned" },
    { _id: "in3", title: "Scheduled", parentId: "unassigned", day: "2026-11-19" },
    { _id: "in4", title: "Backburnered", parentId: "unassigned", backburner: true },
    { _id: "in5", title: "Future start", parentId: "unassigned", startDate: "2099-01-01" },
    { _id: "in6", title: "Recurring copy", parentId: "unassigned", recurringTaskId: "r1" },
    { _id: "in7", title: "Done", parentId: "unassigned", done: true },
  ],
  work: [
    { _id: "w1", title: "Write report", parentId: "work", labelIds: ["l1"], timeEstimate: 1800000 },
    { _id: "proj1", title: "Launch", parentId: "work", type: "project" },
    { _id: "w2", title: "Parked", parentId: "work", backburner: true },
  ],
  proj1: [{ _id: "p1", title: "Ship it", parentId: "proj1", dueDate: "2026-11-01" }],
  lists: [{ _id: "x1", title: "Reference list", parentId: "lists" }],
  books: [{ _id: "x2", title: "A book", parentId: "books" }],
  bb: [{ _id: "x3", title: "Someday thing", parentId: "bb" }],
  bbchild: [{ _id: "x4", title: "Deep someday", parentId: "bbchild" }],
  inboxcat: [{ _id: "x5", title: "Inbox category item", parentId: "inboxcat" }],
};

let requests = [];
let failWith = null;

function marvinMock(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  requests.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers: init.headers, body, method: init.method });
  if (failWith) return new Response("Unauthorized", { status: failWith });
  const ok = (x) => new Response(JSON.stringify(x), { status: 200 });
  switch (u.pathname) {
    case "/api/categories": return ok(cats);
    case "/api/labels": return ok(labels);
    case "/api/children": return ok(children[u.searchParams.get("parentId")] || []);
    case "/api/todayItems": return ok([
      { _id: "t1", title: "Today open", day: u.searchParams.get("date"), parentId: "work", isStarred: 1 },
      { _id: "t2", title: "Today done", day: u.searchParams.get("date"), done: true },
    ]);
    case "/api/dueItems": return ok([
      { _id: "d1", title: "Late", dueDate: "2026-11-01", parentId: "proj1" },
      { _id: "d2", title: "Due today", dueDate: u.searchParams.get("by") },
    ]);
    case "/api/addTask": return ok({ _id: "new1", title: body.title, day: body.day, parentId: body.parentId || "unassigned" });
    case "/api/markDone": return ok([{ _id: body.itemId, title: "Marked", done: true }]);
    case "/api/doc/update": return ok({ _id: body.itemId });
    default: return new Response("not found", { status: 404 });
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).hostname === "serv.amazingmarvin.com") return Promise.resolve(marvinMock(url, init));
  return realFetch(input, init);
};

// ------------------------------------------------------------ Node adapter

function serve(env) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(["ok", name]); }
  catch (e) { results.push(["FAIL", name, e]); }
}

async function connect(base, env) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${env.CONNECTOR_SECRET}`)));
  return client;
}
const parse = (r) => JSON.parse(r.content[0].text);

// ------------------------------------------------------------ tests

const server = await serve(BASE_ENV);
const base = `http://127.0.0.1:${server.address().port}`;
const client = await connect(base, BASE_ENV);

await test("handshake with the official SDK client", async () => {
  const v = client.getServerVersion();
  assert.equal(v.name, "amazing-marvin");
  assert.ok(client.getServerCapabilities().tools);
});

await test("tools/list returns all ten tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "create_task", "get_active_tasks", "get_categories", "get_children", "get_due_items",
    "get_inbox", "get_labels", "get_today_items", "mark_done", "reschedule_task",
  ]);
  for (const t of tools) assert.equal(t.handler, undefined);
});

await test("get_today_items: today in Pacific time, open only, names resolved", async () => {
  requests = [];
  const r = parse(await client.callTool({ name: "get_today_items", arguments: {} }));
  assert.equal(r.date, _internal.todayIn(BASE_ENV));
  assert.equal(r.count, 1);
  assert.equal(r.items[0].parent, "Work");
  const call = requests.find((q) => q.path === "/api/todayItems");
  assert.equal(call.params.date, r.date);
  assert.equal(call.headers["X-API-Token"], "limited-token-XYZ");
  assert.equal(call.headers["X-Full-Access-Token"], undefined);
});

await test("get_today_items include_done and explicit date", async () => {
  const r = parse(await client.callTool({ name: "get_today_items", arguments: { date: "2026-12-01", include_done: true } }));
  assert.equal(r.date, "2026-12-01");
  assert.equal(r.count, 2);
});

await test("bad date is a tool error, not a crash", async () => {
  const r = await client.callTool({ name: "get_today_items", arguments: { date: "tomorrow" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /YYYY-MM-DD/);
});

await test("get_due_items flags overdue", async () => {
  const r = parse(await client.callTool({ name: "get_due_items", arguments: {} }));
  assert.equal(r.items.find((i) => i.id === "d1").overdue, true);
  assert.equal(r.items.find((i) => i.id === "d2").overdue, undefined);
});

await test("get_inbox follows the Inbox rules", async () => {
  const r = parse(await client.callTool({ name: "get_inbox", arguments: {} }));
  assert.deepEqual(r.items.map((i) => i.id).sort(), ["in1", "in2"]);
  assert.equal(r.items[0].day, undefined); // "unassigned" is not shown as a day
});

await test("get_active_tasks excludes Lists, Inbox, backburner and projects", async () => {
  const r = parse(await client.callTool({ name: "get_active_tasks", arguments: {} }));
  assert.deepEqual(r.items.map((i) => i.id).sort(), ["p1", "w1"]);
  assert.equal(r.warning, undefined);
  const w1 = r.items.find((i) => i.id === "w1");
  assert.deepEqual(w1.labels, ["quick"]);
  assert.equal(w1.timeEstimateMinutes, 30);
});

await test("get_categories and get_labels", async () => {
  const c = parse(await client.callTool({ name: "get_categories", arguments: {} }));
  assert.equal(c.count, cats.length);
  assert.equal(c.items.find((i) => i.id === "books").parent, "Lists");
  const l = parse(await client.callTool({ name: "get_labels", arguments: {} }));
  assert.deepEqual(l.items, [{ id: "l1", title: "quick" }]);
});

await test("get_children", async () => {
  const r = parse(await client.callTool({ name: "get_children", arguments: { parent_id: "work" } }));
  assert.equal(r.count, 3);
});

await test("create_task sends the Pacific UTC offset and fields", async () => {
  requests = [];
  const r = parse(await client.callTool({ name: "create_task", arguments: {
    title: "Call dentist", day: "2026-11-20", due_date: "2026-11-21", time_estimate_minutes: 15,
    parent_id: "work", label_ids: ["l1"], starred: 1, auto_complete: false,
  } }));
  assert.equal(r.created.id, "new1");
  const call = requests.find((q) => q.path === "/api/addTask");
  assert.equal(call.body.timeZoneOffset, _internal.utcOffsetMinutes(BASE_ENV));
  assert.equal(call.body.timeEstimate, 900000);
  assert.equal(call.body.dueDate, "2026-11-21");
  assert.equal(call.headers["X-Auto-Complete"], "false");
});

await test("mark_done", async () => {
  requests = [];
  const r = parse(await client.callTool({ name: "mark_done", arguments: { item_id: "w1" } }));
  assert.equal(r.ok, true);
  assert.equal(requests[0].body.itemId, "w1");
});

await test("reschedule_task without full-access token is a clear tool error", async () => {
  const r = await client.callTool({ name: "reschedule_task", arguments: { item_id: "w1", day: "2026-11-22" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /MARVIN_FULL_ACCESS_TOKEN/);
});

await test("Marvin auth failure is reported without leaking the token", async () => {
  failWith = 401;
  const r = await client.callTool({ name: "get_inbox", arguments: {} });
  failWith = null;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /401.*check the Marvin token/);
  assert.doesNotMatch(r.content[0].text, /limited-token-XYZ/);
});

await client.close();
server.close();

// Full-access token, read-only mode, and many categories.
await test("reschedule_task with full-access token uses doc/update", async () => {
  const env = { ...BASE_ENV, MARVIN_API_TOKEN: undefined, MARVIN_FULL_ACCESS_TOKEN: "full-ABC" };
  const s = await serve(env);
  const c = await connect(`http://127.0.0.1:${s.address().port}`, env);
  requests = [];
  const r = parse(await c.callTool({ name: "reschedule_task", arguments: { item_id: "w1", day: "2026-11-22" } }));
  assert.equal(r.day, "2026-11-22");
  const call = requests.find((q) => q.path === "/api/doc/update");
  assert.equal(call.headers["X-Full-Access-Token"], "full-ABC");
  assert.deepEqual(call.body.setters.map((x) => x.key), ["day", "fieldUpdates.day", "updatedAt"]);
  // Read tools fall back to the full-access token when no limited token is set.
  requests = [];
  await c.callTool({ name: "get_inbox", arguments: {} });
  assert.equal(requests[0].headers["X-Full-Access-Token"], "full-ABC");
  await c.close(); s.close();
});

await test("READ_ONLY hides the write tools", async () => {
  const env = { ...BASE_ENV, READ_ONLY: "true" };
  const s = await serve(env);
  const c = await connect(`http://127.0.0.1:${s.address().port}`, env);
  const { tools } = await c.listTools();
  assert.equal(tools.length, 7);
  assert.ok(!tools.some((t) => ["create_task", "mark_done", "reschedule_task"].includes(t.name)));
  const r = await c.callTool({ name: "mark_done", arguments: { item_id: "w1" } }).catch((e) => e);
  assert.ok(r instanceof Error || r.isError);
  await c.close(); s.close();
});

await test("get_active_tasks caps category reads and says so", async () => {
  const saved = cats.length;
  for (let i = 0; i < 60; i++) cats.push({ _id: `c${i}`, title: `Cat ${i}`, parentId: "root" });
  const env = BASE_ENV;
  const s = await serve(env);
  const c = await connect(`http://127.0.0.1:${s.address().port}`, env);
  requests = [];
  const r = parse(await c.callTool({ name: "get_active_tasks", arguments: {} }));
  assert.match(r.warning, /skipped/);
  assert.ok(requests.length <= 45, `made ${requests.length} Marvin requests`);
  cats.length = saved;
  await c.close(); s.close();
});

// ------------------------------------------------------------ raw HTTP checks

const call = (path, init) => worker.fetch(new Request(`https://x.workers.dev${path}`, init), BASE_ENV);
const rpc = (obj) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify(obj),
});

await test("no secret, wrong secret and bare path are 404", async () => {
  const init = { jsonrpc: "2.0", id: 1, method: "ping" };
  assert.equal((await call("/", rpc(init))).status, 404);
  assert.equal((await call("/mcp", rpc(init))).status, 404);
  assert.equal((await call("/mcp/wrong", rpc(init))).status, 404);
  assert.equal((await call(`/mcp/${SECRET}x`, rpc(init))).status, 404);
  assert.equal((await call("/mcp/%E0%A4%A", rpc(init))).status, 404);
  assert.equal((await call("/.well-known/oauth-protected-resource", { method: "GET" })).status, 404);
});

await test("bearer header works as an alternative to the URL secret", async () => {
  const init = rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
  init.headers.Authorization = `Bearer ${SECRET}`;
  const res = await call("/mcp", init);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).result, {});
});

await test("server refuses to run with a missing or short secret", async () => {
  const res = await worker.fetch(new Request("https://x.workers.dev/mcp/abc", rpc({})), { CONNECTOR_SECRET: "abc" });
  assert.equal(res.status, 500);
});

await test("GET is 405, notifications are 202, unknown method is -32601, bad JSON is -32700", async () => {
  assert.equal((await call(`/mcp/${SECRET}`, { method: "GET" })).status, 405);
  assert.equal((await call(`/mcp/${SECRET}`, rpc({ jsonrpc: "2.0", method: "notifications/initialized" }))).status, 202);
  const r = await (await call(`/mcp/${SECRET}`, rpc({ jsonrpc: "2.0", id: 7, method: "resources/list" }))).json();
  assert.equal(r.error.code, -32601);
  const bad = await call(`/mcp/${SECRET}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
});

await test("initialize echoes a supported protocol version, else offers the latest", async () => {
  const a = await (await call(`/mcp/${SECRET}`, rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } }))).json();
  assert.equal(a.result.protocolVersion, "2025-03-26");
  const b = await (await call(`/mcp/${SECRET}`, rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }))).json();
  assert.equal(b.result.protocolVersion, "2025-11-25");
});

await test("dates: Pacific day boundary and daylight saving offsets", async () => {
  // 05:00 UTC on Nov 20 is still Nov 19 in Pacific time.
  assert.equal(_internal.todayIn(BASE_ENV, new Date("2026-11-20T05:00:00Z")), "2026-11-19");
  assert.equal(_internal.utcOffsetMinutes(BASE_ENV, new Date("2026-11-19T12:00:00Z")), -480);
  assert.equal(_internal.utcOffsetMinutes(BASE_ENV, new Date("2026-07-01T12:00:00Z")), -420);
  assert.equal(_internal.utcOffsetMinutes({ TIMEZONE: "UTC" }), 0);
  assert.equal(_internal.utcOffsetMinutes({ TIMEZONE: "Asia/Kolkata" }), 330);
});

// ------------------------------------------------------------ report

for (const [status, name, err] of results) {
  console.log(`${status.padEnd(4)} ${name}`);
  if (err) console.log("     ", err.message);
}
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
