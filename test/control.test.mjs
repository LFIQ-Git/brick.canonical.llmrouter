// Phase 2 control plane: routes from GET /api/v1/ai/config, runs to POST /api/v1/ai/runs.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let server;
let base;
const seen = { ocp: [], anth: [], runs: [], config: 0 };
let config = null;
let ocpReply = "ok";
let anthReply = "ok";

const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = body ? JSON.parse(body) : null;
      if (req.url.startsWith("/ocp/")) {
        seen.ocp.push(b);
        if (ocpReply === "fail") return json(res, 500, { error: { message: "down" } });
        return json(res, 200, { id: "x", object: "chat.completion", created: 0, model: b.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `ocp:${b.model}` } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
      }
      if (req.url.startsWith("/anth/")) {
        seen.anth.push(b);
        if (anthReply === "fail") return json(res, 500, { type: "error", error: { type: "api_error", message: "down" } });
        return json(res, 200, { id: "m", type: "message", role: "assistant", model: b.model, stop_reason: "end_turn",
          content: [{ type: "text", text: `anth:${b.model}` }], usage: { input_tokens: 4, output_tokens: 1 } });
      }
      if (req.url.startsWith("/ctl/api/v1/ai/config")) {
        seen.config += 1;
        if (req.headers["x-scheduler-secret"] !== "sched-secret") return json(res, 401, {});
        return config ? json(res, 200, config) : json(res, 503, {});
      }
      if (req.url === "/ctl/api/v1/ai/runs" && req.method === "POST") {
        seen.runs.push(...b.runs);
        return json(res, 201, { recorded: b.runs.length });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const leg = (provider, model) => ({ provider, model });
const ROUTES = [
  { tier: "fast", task: null, primary: leg("ocp", "claude-haiku-4-5"), fallback: leg("anthropic", "claude-haiku-4-5") },
  { tier: "standard", task: null, primary: leg("ocp", "claude-sonnet-5-5"), fallback: leg("anthropic", "claude-sonnet-5-5") },
  { tier: "deep", task: null, primary: leg("ocp", "claude-opus-5-5"), fallback: null },
  { tier: "standard", task: "intel.chat", primary: leg("anthropic", "claude-sonnet-5-5"), fallback: null },
];

beforeEach(() => {
  delete globalThis.__brickLlmControl;
  for (const k of Object.keys(process.env)) if (k.startsWith("AI_ROUTE_")) delete process.env[k];
  Object.assign(process.env, {
    OCP_BASE_URL: `${base}/ocp`, OCP_API_KEY: "test-ocp-key-0123456789",
    ANTHROPIC_BASE_URL: `${base}/anth`, ANTHROPIC_API_KEY: "test-anth-key-0123456789",
    LLM_OCP_MAX_RETRIES: "0", LLM_ANTHROPIC_MAX_RETRIES: "0",
    AI_CONTROL_URL: `${base}/ctl/`, AI_CONTROL_SECRET: "sched-secret", LLM_APP_NAME: "intel",
  });
  seen.ocp = []; seen.anth = []; seen.runs = []; seen.config = 0;
  config = { router: "brick", daily_paid_cap_usd: "5.00", today_paid_usd: "0", routes: ROUTES };
  ocpReply = "ok"; anthReply = "ok";
});

let n = 0;
const load = () => import(new URL(`../dist/llm.js?c=${++n}`, import.meta.url).href);
// Hide only the router's own llm.call lines; the test runner reports through stdout too.
const quiet = async (fn) => {
  const w = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => (String(chunk).startsWith("llm.call ") ? true : w(chunk, ...rest));
  try { return await fn(); } finally { process.stdout.write = w; }
};
const ARGS = { system: "sys", messages: [{ role: "user", content: "hi" }] };

test("the table picks the model and every call lands in ai.runs", async () => {
  const L = await load();
  const r = await quiet(() => L.chatDetailed({ ...ARGS, task: "intel.brief", tier: "balanced" }));
  assert.equal(r.text, "ocp:claude-sonnet-5-5");
  assert.equal(seen.runs.length, 1);
  assert.deepEqual(
    { ...seen.runs[0], latency_ms: 0 },
    { router: "brick", app: "intel", task: "intel.brief", tier: "standard", provider: "ocp", model: "claude-sonnet-5-5",
      input_tokens: 3, output_tokens: 2, latency_ms: 0, fell_back: false, ok: true },
  );
});

test("the table is cached for 60 seconds", async () => {
  const L = await load();
  await quiet(() => L.chat({ ...ARGS, tier: "fast" }));
  await quiet(() => L.chat({ ...ARGS, tier: "fast" }));
  assert.equal(seen.config, 1);
});

test("a task override with no OCP leg goes straight to Anthropic", async () => {
  const L = await load();
  const r = await quiet(() => L.chatDetailed({ ...ARGS, task: "intel.chat", tier: "balanced" }));
  assert.equal(r.provider, "anthropic");
  assert.equal(seen.ocp.length, 0);
});

test("deep has no paid fallback: an OCP failure is not retried on Anthropic", async () => {
  ocpReply = "fail";
  const L = await load();
  await assert.rejects(quiet(() => L.chat({ ...ARGS, task: "intel.review", tier: "deep" })));
  assert.equal(seen.anth.length, 0);
  assert.equal(seen.runs[0].ok, false);
  assert.equal(seen.runs[0].model, "claude-opus-5-5");
});

test("past 80% of the cap, standard's paid leg steps down to the fast model", async () => {
  config.today_paid_usd = "4.10";
  ocpReply = "fail";
  const L = await load();
  const r = await quiet(() => L.chatDetailed({ ...ARGS, task: "intel.brief", tier: "balanced" }));
  assert.equal(r.text, "anth:claude-haiku-4-5");
  assert.equal(seen.runs.at(-1).fell_back, true);
});

test("at the cap, paid legs are held", async () => {
  config.today_paid_usd = "5.00";
  ocpReply = "fail";
  const L = await load();
  await assert.rejects(quiet(() => L.chat({ ...ARGS, task: "intel.brief", tier: "balanced" })), /cap reached|down|500/);
  assert.equal(seen.anth.length, 0);
});

test("AI_ROUTE_<TASK> overrides the table; other providers are refused", async () => {
  process.env.AI_ROUTE_INTEL_BRIEF = "anthropic:claude-haiku-4-5";
  const L = await load();
  const r = await quiet(() => L.chatDetailed({ ...ARGS, task: "intel.brief", tier: "balanced" }));
  assert.equal(r.text, "anth:claude-haiku-4-5");
  assert.throws(() => L.parseRouteOverride("workers-ai:@cf/x"), /not allowed/);
});

test("an explicit model still wins", async () => {
  const L = await load();
  const r = await quiet(() => L.chat({ ...ARGS, model: "claude-sonnet-4-6", tier: "fast" }));
  assert.equal(r, "ocp:claude-sonnet-4-6");
});

test("control plane down: built-in tiers, call still answers", async () => {
  config = null;
  const L = await load();
  const r = await quiet(() => L.chat({ ...ARGS, tier: "fast" }));
  assert.equal(r, "ocp:claude-haiku-4-5");
});

test("no control plane configured: no fetches, no runs", async () => {
  delete process.env.AI_CONTROL_URL;
  const L = await load();
  await quiet(() => L.chat({ ...ARGS, tier: "fast" }));
  assert.equal(seen.config, 0);
  assert.equal(seen.runs.length, 0);
});

test("Sonnet 5.5 on Anthropic runs without thinking and without temperature", async () => {
  ocpReply = "fail";
  const L = await load();
  await quiet(() => L.chat({ ...ARGS, task: "intel.brief", tier: "balanced", temperature: 0.3 }));
  const body = seen.anth.at(-1);
  assert.deepEqual(body.thinking, { type: "between_tools" });
  assert.equal(body.temperature, undefined);
  assert.deepEqual(L.anthropicTextSettings("claude-haiku-4-5", 100, 0.2), { max_tokens: 100, temperature: 0.2 });
});
