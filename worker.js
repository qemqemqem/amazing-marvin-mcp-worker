// Amazing Marvin MCP server for Cloudflare Workers.
//
// A remote MCP server (Streamable HTTP transport, stateless, JSON responses)
// that lets Claude read and update an Amazing Marvin account.
//
// Single file, no dependencies, so it can be pasted into the Cloudflare
// dashboard editor or deployed with `npx wrangler deploy`.
//
// Secrets (set in Cloudflare, never in this file):
//   CONNECTOR_SECRET          required. Random string, 32+ chars. Part of the URL.
//   MARVIN_API_TOKEN          Marvin "API_TOKEN" (limited access).
//   MARVIN_FULL_ACCESS_TOKEN  optional. Marvin "FULL_ACCESS_TOKEN". Needed only
//                             for reschedule_task. Either token works for the rest.
// Plain variables (optional):
//   TIMEZONE                  IANA zone for "today". Default America/Los_Angeles.
//   READ_ONLY                 "true" hides create_task, mark_done, reschedule_task.
//   EXCLUDED_CATEGORIES       comma list of category titles get_active_tasks skips
//                             (with their descendants). Default "Lists,Inbox".
//
// Endpoint: POST https://<worker>.workers.dev/mcp/<CONNECTOR_SECRET>
// (or POST /mcp with "Authorization: Bearer <CONNECTOR_SECRET>").

const SERVER_INFO = { name: "amazing-marvin", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MARVIN_BASE = "https://serv.amazingmarvin.com/api";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Workers' free plan allows 50 outbound requests per invocation; leave headroom.
const MAX_CATEGORY_FETCHES = 40;

const INSTRUCTIONS =
  "Tools for the user's Amazing Marvin task manager. 'Today' means tasks scheduled " +
  "for a day (get_today_items). The Inbox is unscheduled, unfiled items (get_inbox). " +
  "Dates are YYYY-MM-DD in the user's time zone. Item ids come from the read tools.";

// ---------------------------------------------------------------- HTTP entry

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.CONNECTOR_SECRET || env.CONNECTOR_SECRET.length < 32) {
      return text(500, "Server not configured: set CONNECTOR_SECRET (32+ characters).");
    }

    let presented = null;
    if (url.pathname.startsWith("/mcp/")) {
      try {
        presented = decodeURIComponent(url.pathname.slice("/mcp/".length).replace(/\/$/, ""));
      } catch {
        presented = null;
      }
    } else if (url.pathname === "/mcp") {
      const auth = request.headers.get("Authorization") || "";
      if (auth.startsWith("Bearer ")) presented = auth.slice(7).trim();
    }
    // Anything without the right secret looks like a missing page.
    if (presented === null || !(await secretsEqual(presented, env.CONNECTOR_SECRET))) {
      return text(404, "Not found");
    }

    if (request.method !== "POST") {
      // Stateless server: no SSE stream to open, no session to delete.
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, rpcError(null, -32700, "Parse error"));
    }

    const marvin = new Marvin(env);
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleMessage(m, env, marvin)))).filter(Boolean);
      return out.length ? json(200, out) : new Response(null, { status: 202 });
    }
    const out = await handleMessage(body, env, marvin);
    return out ? json(200, out) : new Response(null, { status: 202 });
  },
};

// ---------------------------------------------------------------- JSON-RPC

async function handleMessage(msg, env, marvin) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, "Invalid request");
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null; // notifications/initialized, cancelled, etc.
  if (!msg.method) return null; // a response from the client; nothing to do

  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: visibleTools(env).map(({ handler, ...def }) => def) });
    case "tools/call": {
      const tool = visibleTools(env).find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const result = await tool.handler(params.arguments || {}, { env, marvin });
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const json = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const text = (status, s) =>
  new Response(s, { status, headers: { "Content-Type": "text/plain" } });

async function secretsEqual(a, b) {
  // Compare hashes so timing doesn't leak the secret's length or prefix.
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------------------------------------------------------------- Marvin client

class Marvin {
  constructor(env) {
    this.env = env;
    this.cache = new Map(); // per-request cache of GETs
  }

  headers(fullAccess) {
    const h = { "Content-Type": "application/json", "User-Agent": "amazing-marvin-mcp-worker/1.0" };
    if (fullAccess) {
      if (!this.env.MARVIN_FULL_ACCESS_TOKEN) {
        throw new Error("This needs MARVIN_FULL_ACCESS_TOKEN, which isn't set on the server.");
      }
      h["X-Full-Access-Token"] = this.env.MARVIN_FULL_ACCESS_TOKEN;
    } else if (this.env.MARVIN_API_TOKEN) {
      h["X-API-Token"] = this.env.MARVIN_API_TOKEN;
    } else if (this.env.MARVIN_FULL_ACCESS_TOKEN) {
      h["X-Full-Access-Token"] = this.env.MARVIN_FULL_ACCESS_TOKEN;
    } else {
      throw new Error("No Marvin token set on the server (MARVIN_API_TOKEN).");
    }
    return h;
  }

  async call(method, endpoint, { params, body, fullAccess = false } = {}) {
    const url = new URL(`${MARVIN_BASE}/${endpoint}`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const key = method === "GET" ? url.toString() : null;
    if (key && this.cache.has(key)) return this.cache.get(key);

    const res = await fetch(url.toString(), {
      method,
      headers: this.headers(fullAccess),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? " (check the Marvin token)" : "";
      throw new Error(`Marvin API returned ${res.status} for ${endpoint}${hint}: ${raw.slice(0, 200)}`);
    }
    let data = raw;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* plain-text reply */ }
    if (key) this.cache.set(key, data);
    return data;
  }

  todayItems(date) { return this.call("GET", "todayItems", { params: { date } }); }
  dueItems(by) { return this.call("GET", "dueItems", { params: { by } }); }
  children(parentId) { return this.call("GET", "children", { params: { parentId } }); }
  categories() { return this.call("GET", "categories"); }
  labels() { return this.call("GET", "labels"); }
}

// ---------------------------------------------------------------- dates

function tz(env) { return env.TIMEZONE || "America/Los_Angeles"; }

function todayIn(env, now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz(env), year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// Marvin's timeZoneOffset is the UTC offset in minutes (Pacific standard = -480).
function utcOffsetMinutes(env, now = new Date()) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz(env), timeZoneName: "longOffset" })
    .formatToParts(now).find((p) => p.type === "timeZoneName").value; // "GMT-08:00" or "GMT"
  const m = part.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] || 0);
  return m[1] === "-" ? -mins : mins;
}

function checkDate(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new Error(`${name} must be a date in YYYY-MM-DD form.`);
  }
  return value;
}

// ---------------------------------------------------------------- shaping

const isScheduled = (item) => Boolean(item.day) && item.day !== "unassigned";

async function lookups(marvin) {
  const [cats, labels] = await Promise.all([marvin.categories(), marvin.labels()]);
  return {
    catTitle: new Map((cats || []).map((c) => [c._id, c.title])),
    labelTitle: new Map((labels || []).map((l) => [l._id, l.title])),
  };
}

function shape(item, lk) {
  const out = {
    id: item._id,
    title: item.title,
    type: item.type === "project" ? "project" : "task",
  };
  if (item.done) out.done = true;
  if (isScheduled(item)) out.day = item.day;
  if (item.dueDate) out.dueDate = item.dueDate;
  if (item.startDate) out.startDate = item.startDate;
  if (item.parentId && item.parentId !== "unassigned" && item.parentId !== "root") {
    out.parentId = item.parentId;
    const t = lk && lk.catTitle.get(item.parentId);
    if (t) out.parent = t;
  } else if (item.parentId === "unassigned") {
    out.parent = "Inbox";
  }
  if (Array.isArray(item.labelIds) && item.labelIds.length) {
    out.labels = item.labelIds.map((id) => (lk && lk.labelTitle.get(id)) || id);
  }
  if (item.timeEstimate) out.timeEstimateMinutes = Math.round(item.timeEstimate / 60000);
  if (item.isStarred) out.starred = item.isStarred;
  if (item.isFrogged) out.frogged = item.isFrogged;
  if (item.dailySection) out.dailySection = item.dailySection;
  if (item.backburner) out.backburner = true;
  if (item.note) out.note = item.note.length > 500 ? item.note.slice(0, 500) + "…" : item.note;
  return out;
}

function arr(x) { return Array.isArray(x) ? x : []; }

// ---------------------------------------------------------------- tools

const READ = { readOnlyHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "get_today_items",
    title: "Tasks scheduled for a day",
    description: "Tasks and projects scheduled for a day (default today in the user's time zone), including Marvin's rollover items. Open items only unless include_done is true.",
    annotations: READ,
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
        include_done: { type: "boolean", description: "Also return items already marked done." },
      },
    },
    async handler(args, { env, marvin }) {
      const date = checkDate(args.date, "date") || todayIn(env);
      const [items, lk] = await Promise.all([marvin.todayItems(date), lookups(marvin)]);
      const list = arr(items).filter((i) => args.include_done || !i.done);
      return { date, count: list.length, items: list.map((i) => shape(i, lk)) };
    },
  },
  {
    name: "get_due_items",
    title: "Due and overdue items",
    description: "Open tasks and projects due on or before a date (default today). Items due before today are flagged overdue.",
    annotations: READ,
    inputSchema: {
      type: "object",
      properties: { by: { type: "string", description: "YYYY-MM-DD. Defaults to today." } },
    },
    async handler(args, { env, marvin }) {
      const today = todayIn(env);
      const by = checkDate(args.by, "by") || today;
      const [items, lk] = await Promise.all([marvin.dueItems(by), lookups(marvin)]);
      const list = arr(items).filter((i) => !i.done).map((i) => {
        const s = shape(i, lk);
        if (i.dueDate && i.dueDate < today) s.overdue = true;
        return s;
      });
      return { by, today, count: list.length, items: list };
    },
  },
  {
    name: "get_inbox",
    title: "Inbox",
    description: "Open items in the Marvin Inbox: not filed in a category, not scheduled to a day, not backburnered, no future start date. Hides leftover recurring-task copies, which the app also hides.",
    annotations: READ,
    inputSchema: { type: "object", properties: {} },
    async handler(args, { env, marvin }) {
      const today = todayIn(env);
      const [items, lk] = await Promise.all([marvin.children("unassigned"), lookups(marvin)]);
      const list = arr(items).filter((i) =>
        !i.done &&
        !i.backburner &&
        !isScheduled(i) &&
        !(i.startDate && i.startDate > today) &&
        !i.recurringTaskId
      );
      return { count: list.length, items: list.map((i) => shape(i, lk)) };
    },
  },
  {
    name: "get_active_tasks",
    title: "Active tasks",
    description: "Open tasks across all categories and projects, like Marvin's Active Tasks list: skips projects, backburnered items and categories, and the excluded categories (default Lists and Inbox) with their sub-projects. Slow: one request per category.",
    annotations: READ,
    inputSchema: { type: "object", properties: {} },
    async handler(args, { env, marvin }) {
      const cats = arr(await marvin.categories());
      const byId = new Map(cats.map((c) => [c._id, c]));
      const excludedTitles = (env.EXCLUDED_CATEGORIES ?? "Lists,Inbox")
        .split(",").map((s) => s.trim()).filter(Boolean);

      const excluded = new Set();
      const addDescendants = (id) => {
        for (const c of cats) {
          if (c.parentId === id && !excluded.has(c._id)) { excluded.add(c._id); addDescendants(c._id); }
        }
      };
      for (const c of cats) if (excludedTitles.includes(c.title)) { excluded.add(c._id); addDescendants(c._id); }

      const backburnered = (id, seen = new Set()) => {
        if (!id || id === "root" || id === "unassigned" || seen.has(id)) return false;
        seen.add(id);
        const c = byId.get(id);
        if (!c) return false;
        return Boolean(c.backburner) || backburnered(c.parentId, seen);
      };

      const targets = cats.filter((c) => !excluded.has(c._id) && !backburnered(c._id));
      const budget = MAX_CATEGORY_FETCHES - 2; // categories + labels already used
      const toFetch = targets.slice(0, budget);
      const skipped = targets.slice(budget).map((c) => c.title);

      const lk = await lookups(marvin);
      const seenTask = new Set();
      const tasks = [];
      // Two at a time: Marvin asks clients to keep request rates low.
      for (let i = 0; i < toFetch.length; i += 2) {
        const batch = await Promise.all(toFetch.slice(i, i + 2).map((c) => marvin.children(c._id)));
        for (const kids of batch) {
          for (const t of arr(kids)) {
            if (t.type === "project" || t.done || t.backburner || excluded.has(t.parentId)) continue;
            if (seenTask.has(t._id)) continue;
            seenTask.add(t._id);
            tasks.push(shape(t, lk));
          }
        }
      }
      const out = { count: tasks.length, items: tasks };
      if (skipped.length) {
        out.warning = `Only the first ${toFetch.length} categories were read (hosting limit); ${skipped.length} skipped.`;
        out.skippedCategories = skipped;
      }
      return out;
    },
  },
  {
    name: "get_children",
    title: "Items in a category or project",
    description: "Open tasks and sub-projects directly inside one category or project. Use 'unassigned' for the raw Inbox.",
    annotations: READ,
    inputSchema: {
      type: "object",
      properties: { parent_id: { type: "string", description: "Category or project id, from get_categories." } },
      required: ["parent_id"],
    },
    async handler(args, { marvin }) {
      if (!args.parent_id || typeof args.parent_id !== "string") throw new Error("parent_id is required.");
      const [items, lk] = await Promise.all([marvin.children(args.parent_id), lookups(marvin)]);
      const list = arr(items).filter((i) => !i.done);
      return { parentId: args.parent_id, count: list.length, items: list.map((i) => shape(i, lk)) };
    },
  },
  {
    name: "get_categories",
    title: "Categories and projects",
    description: "All categories and projects with their ids and parents.",
    annotations: READ,
    inputSchema: { type: "object", properties: {} },
    async handler(args, { marvin }) {
      const cats = arr(await marvin.categories());
      const title = new Map(cats.map((c) => [c._id, c.title]));
      return {
        count: cats.length,
        items: cats.map((c) => {
          const o = { id: c._id, title: c.title, type: c.type || "category" };
          if (c.parentId && c.parentId !== "root") { o.parentId = c.parentId; o.parent = title.get(c.parentId); }
          if (c.backburner) o.backburner = true;
          if (c.dueDate) o.dueDate = c.dueDate;
          return o;
        }),
      };
    },
  },
  {
    name: "get_labels",
    title: "Labels",
    description: "All labels with their ids.",
    annotations: READ,
    inputSchema: { type: "object", properties: {} },
    async handler(args, { marvin }) {
      const labels = arr(await marvin.labels());
      return { count: labels.length, items: labels.map((l) => ({ id: l._id, title: l.title })) };
    },
  },
  {
    name: "create_task",
    title: "Create a task",
    description: "Create a Marvin task. The title also accepts Marvin shortcuts such as +today, #Category, @label and 30m unless auto_complete is false.",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        day: { type: "string", description: "Day to schedule it, YYYY-MM-DD." },
        due_date: { type: "string", description: "Deadline, YYYY-MM-DD." },
        parent_id: { type: "string", description: "Category or project id. Omit for the Inbox." },
        time_estimate_minutes: { type: "number" },
        note: { type: "string" },
        label_ids: { type: "array", items: { type: "string" } },
        starred: { type: "integer", minimum: 0, maximum: 3 },
        auto_complete: { type: "boolean", description: "Parse shortcuts in the title. Default true." },
      },
      required: ["title"],
    },
    async handler(args, { env, marvin }) {
      if (!args.title || typeof args.title !== "string") throw new Error("title is required.");
      const body = { title: args.title, timeZoneOffset: utcOffsetMinutes(env) };
      const day = checkDate(args.day, "day");
      const due = checkDate(args.due_date, "due_date");
      if (day) body.day = day;
      if (due) body.dueDate = due;
      if (args.parent_id) body.parentId = String(args.parent_id);
      if (args.time_estimate_minutes) body.timeEstimate = Math.round(Number(args.time_estimate_minutes) * 60000);
      if (args.note) body.note = String(args.note);
      if (Array.isArray(args.label_ids) && args.label_ids.length) body.labelIds = args.label_ids.map(String);
      if (args.starred !== undefined) body.isStarred = Number(args.starred);

      const url = new URL(`${MARVIN_BASE}/addTask`);
      const headers = marvin.headers(false);
      if (args.auto_complete === false) headers["X-Auto-Complete"] = "false";
      const res = await fetch(url.toString(), { method: "POST", headers, body: JSON.stringify(body) });
      const raw = await res.text();
      if (!res.ok) throw new Error(`Marvin API returned ${res.status} for addTask: ${raw.slice(0, 200)}`);
      let created = null;
      try { created = JSON.parse(raw); } catch { /* ignore */ }
      return { created: created && created._id ? shape(created) : raw };
    },
  },
  {
    name: "mark_done",
    title: "Mark a task done",
    description: "Mark one task done by id. Marvin's server repeats some recurring tasks; others repeat only when the Marvin app next syncs.",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { item_id: { type: "string" } },
      required: ["item_id"],
    },
    async handler(args, { env, marvin }) {
      if (!args.item_id || typeof args.item_id !== "string") throw new Error("item_id is required.");
      const res = await marvin.call("POST", "markDone", {
        body: { itemId: args.item_id, timeZoneOffset: utcOffsetMinutes(env) },
      });
      const items = arr(res);
      const hit = items.find((i) => i._id === args.item_id);
      return { ok: true, item: hit ? shape(hit) : { id: args.item_id } };
    },
  },
  {
    name: "reschedule_task",
    title: "Move a task to another day",
    description: "Change the day a task is scheduled for, or pass day 'unassigned' to unschedule it. Needs the full-access token on the server.",
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string" },
        day: { type: "string", description: "YYYY-MM-DD, or 'unassigned'." },
      },
      required: ["item_id", "day"],
    },
    async handler(args, { marvin }) {
      if (!args.item_id || typeof args.item_id !== "string") throw new Error("item_id is required.");
      const day = args.day === "unassigned" ? "unassigned" : checkDate(args.day, "day");
      if (!day) throw new Error("day is required.");
      const now = Date.now();
      await marvin.call("POST", "doc/update", {
        fullAccess: true,
        body: {
          itemId: args.item_id,
          setters: [
            { key: "day", val: day },
            { key: "fieldUpdates.day", val: now },
            { key: "updatedAt", val: now },
          ],
        },
      });
      return { ok: true, id: args.item_id, day };
    },
  },
];

function visibleTools(env) {
  const readOnly = String(env.READ_ONLY || "").toLowerCase() === "true";
  return TOOLS.filter((t) => !(readOnly && t.write)).map(({ write, ...t }) => t);
}

// Exported for tests.
export const _internal = { todayIn, utcOffsetMinutes, shape, TOOLS };
