// Black-box tests for the 0.8.0 tools + streaming API (chatStream, chatTools)
// against a local mock of the OCP, ocp-fallback and Anthropic legs. Fake keys
// only; no network.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let server;
let base;
const handlers = {};
const hits = { ocp: 0, fb: 0, anth: 0 };
const bodies = { ocp: [], fb: [], anth: [] };

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const seg = req.url.split("/")[1];
      const key = seg === "ocp" || seg === "fb" || seg === "anth" ? seg : null;
      if (key === null) return void res.writeHead(404).end();
      hits[key] += 1;
      try { bodies[key].push(JSON.parse(body)); } catch { bodies[key].push(body); }
      const h = handlers[key];
      if (!h) return void res.writeHead(404).end();
      h(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

const ENV_KEYS = [
  "OCP_BASE_URL", "OCP_API_KEY", "OCP_FALLBACK_BASE_URL", "OCP_FALLBACK_API_KEY",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "LLM_PROVIDER", "LLM_OCP_MAX_RETRIES",
  "LLM_ANTHROPIC_MAX_RETRIES", "WORKERS_AI_MODEL",
];

beforeEach(() => {
  delete globalThis.__lfiqWorkersAiRunner;
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of Object.keys(handlers)) delete handlers[k];
  for (const k of Object.keys(hits)) hits[k] = 0;
  for (const k of Object.keys(bodies)) bodies[k] = [];
});

let n = 0;
const load = () => import(new URL(`../dist/llm.js?tools=${++n}`, import.meta.url).href);

function chainEnv({ fallback = false } = {}) {
  process.env.OCP_BASE_URL = `${base}/ocp`;
  process.env.OCP_API_KEY = "test-ocp-key-0123456789";
  if (fallback) {
    process.env.OCP_FALLBACK_BASE_URL = `${base}/fb`;
    process.env.OCP_FALLBACK_API_KEY = "test-fb-key-0123456789";
  }
  process.env.ANTHROPIC_BASE_URL = `${base}/anth`;
  process.env.ANTHROPIC_API_KEY = "test-anth-key-0123456789";
  process.env.LLM_OCP_MAX_RETRIES = "0";
  process.env.LLM_ANTHROPIC_MAX_RETRIES = "0";
}

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(e);
  res.end();
};
const oaiChunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/** OCP-style stream: optional text, then tool calls, then finish. */
const oaiStream = ({ text, calls = [] }) => (_q, res) => {
  const ev = [oaiChunk({ role: "assistant" })];
  if (text) ev.push(oaiChunk({ content: text }));
  if (calls.length) {
    ev.push(oaiChunk({
      tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: "function", function: { name: c.name, arguments: "" } })),
    }));
    // Arguments split across chunks, as the OpenAI spec allows.
    for (const [i, c] of calls.entries()) {
      const a = JSON.stringify(c.args);
      ev.push(oaiChunk({ tool_calls: [{ index: i, function: { arguments: a.slice(0, 3) } }] }));
      ev.push(oaiChunk({ tool_calls: [{ index: i, function: { arguments: a.slice(3) } }] }));
    }
  }
  ev.push(oaiChunk({}, calls.length ? "tool_calls" : "stop"));
  ev.push("data: [DONE]\n\n");
  sse(res, ev);
};

const aev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
/** Anthropic-style message stream. */
const anthStream = ({ text, calls = [] }) => (_q, res) => {
  const ev = [aev("message_start", {
    message: { id: "msg", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 9, output_tokens: 0, cache_creation_input_tokens: 5, cache_read_input_tokens: 0 } },
  })];
  let i = 0;
  if (text) {
    ev.push(aev("content_block_start", { index: i, content_block: { type: "text", text: "" } }));
    ev.push(aev("content_block_delta", { index: i, delta: { type: "text_delta", text } }));
    ev.push(aev("content_block_stop", { index: i++ }));
  }
  for (const c of calls) {
    ev.push(aev("content_block_start", { index: i, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } }));
    ev.push(aev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.args) } }));
    ev.push(aev("content_block_stop", { index: i++ }));
  }
  ev.push(aev("message_delta", { delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }));
  ev.push(aev("message_stop", {}));
  sse(res, ev);
};
const fail = (status) => (_q, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "api_error", message: "boom" } }));
};

async function captureLogs(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const s = String(chunk);
    if (s.startsWith("llm.call ")) { lines.push(JSON.parse(s.slice(9))); return true; }
    return orig(chunk, ...rest);
  };
  try { return { result: await fn(), lines }; } catch (error) { return { error, lines }; } finally { process.stdout.write = orig; }
}

const TOOLS = [{ type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
const ARGS = { system: "sys", messages: [{ role: "user", content: "weather?" }], tools: TOOLS, model: "claude-sonnet-4-6" };

async function collect(it) {
  const events = [];
  for await (const e of it) events.push(e);
  return events;
}

test("chatStream on OCP: start, text, tool_call_start, tool_call, done", async () => {
  chainEnv();
  handlers.ocp = oaiStream({ text: "Checking.", calls: [{ id: "t1", name: "get_weather", args: { city: "SF" } }] });
  const L = await load();
  const { result: events, lines } = await captureLogs(() => collect(L.chatStream(ARGS)));
  assert.deepEqual(events.map((e) => e.type), ["start", "text", "tool_call_start", "tool_call", "done"]);
  assert.deepEqual(events[0], { type: "start", provider: "ocp", model: "claude-sonnet-4-6" });
  assert.equal(events[1].text, "Checking.");
  assert.deepEqual(events[3].call, { id: "t1", name: "get_weather", arguments: { city: "SF" } });
  const done = events[4].result;
  assert.equal(done.finishReason, "tool_calls");
  assert.equal(done.provider, "ocp");
  assert.equal(done.text, "Checking.");
  assert.equal(hits.anth, 0);
  // OCP request: OpenAI tools passed through, stream on.
  assert.equal(bodies.ocp[0].stream, true);
  assert.deepEqual(bodies.ocp[0].tools, TOOLS);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].provider, "ocp");
  assert.equal(lines[0].mode, "stream");
  assert.equal(lines[0].toolCalls, 1);
});

test("chatTools sends tool results back in OpenAI shape on OCP", async () => {
  chainEnv();
  handlers.ocp = oaiStream({ text: "62F and foggy." });
  const L = await load();
  const r = await L.chatTools({
    ...ARGS,
    effort: "low",
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "get_weather", arguments: { city: "SF" } }] },
      { role: "tool", toolCallId: "t1", content: "62F" },
    ],
  });
  assert.equal(r.text, "62F and foggy.");
  assert.equal(r.finishReason, "stop");
  assert.deepEqual(r.toolCalls, []);
  const msgs = bodies.ocp[0].messages;
  assert.deepEqual(msgs[0], { role: "system", content: "sys" });
  assert.deepEqual(msgs[2], {
    role: "assistant", content: null,
    tool_calls: [{ id: "t1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
  });
  assert.deepEqual(msgs[3], { role: "tool", tool_call_id: "t1", content: "62F" });
  assert.equal(bodies.ocp[0].reasoning_effort, "low");
});

test("OCP down: chatStream fails over to Anthropic with translated tools and messages", async () => {
  chainEnv();
  handlers.ocp = fail(503);
  handlers.anth = anthStream({ calls: [{ id: "tu1", name: "get_weather", args: { city: "NYC" } }] });
  const L = await load();
  const { result: events, lines } = await captureLogs(() => collect(L.chatStream({
    ...ARGS,
    system: [{ text: "stable", cache_control: { type: "ephemeral" } }, { text: "\n\nvolatile" }],
    anthropic: { thinking: { type: "between_tools" } },
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: "Looking.", toolCalls: [{ id: "tu0", name: "get_weather", arguments: { city: "SF" } }] },
      { role: "tool", toolCallId: "tu0", content: "timeout", isError: true },
    ],
  })));
  assert.equal(events[0].provider, "anthropic");
  const done = events.at(-1).result;
  assert.deepEqual(done.toolCalls, [{ id: "tu1", name: "get_weather", arguments: { city: "NYC" } }]);
  assert.equal(done.finishReason, "tool_calls");
  assert.equal(done.usage.cache_creation_input_tokens, 5);
  const body = bodies.anth[0];
  assert.deepEqual(body.tools, [{ name: "get_weather", description: "Weather", input_schema: TOOLS[0].function.parameters, cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(body.system, [
    { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
    { type: "text", text: "\n\nvolatile" },
  ]);
  assert.deepEqual(body.thinking, { type: "between_tools" });
  assert.deepEqual(body.messages[1], {
    role: "assistant",
    content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "tu0", name: "get_weather", input: { city: "SF" } }],
  });
  assert.deepEqual(body.messages[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tu0", content: "timeout", is_error: true, cache_control: { type: "ephemeral" } }],
  });
  assert.deepEqual(lines.map((l) => [l.provider, l.ok]), [["ocp", false], ["anthropic", true]]);
  assert.equal(lines[1].failedOver, true);
});

test("ocp-fallback answers before Anthropic when configured", async () => {
  chainEnv({ fallback: true });
  handlers.ocp = fail(502);
  handlers.fb = oaiStream({ text: "from-fb" });
  const L = await load();
  const r = await L.chatTools(ARGS);
  assert.equal(r.provider, "ocp-fallback");
  assert.equal(r.text, "from-fb");
  assert.equal(hits.anth, 0);
});

test("OCP breaker opens after 3 failures and skips OCP for tool calls", async () => {
  chainEnv();
  handlers.ocp = fail(500);
  handlers.anth = anthStream({ text: "a" });
  const L = await load();
  for (let i = 0; i < 3; i++) await L.chatTools(ARGS);
  assert.equal(hits.ocp, 3);
  const r = await L.chatTools(ARGS);
  assert.equal(r.provider, "anthropic");
  assert.equal(hits.ocp, 3);
});

test("chatTools fails over on a mid-stream OCP error; chatStream does not once text is out", async () => {
  chainEnv();
  // Text, then the connection drops before [DONE].
  handlers.ocp = (_q, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(oaiChunk({ content: "partial" }));
    setTimeout(() => res.destroy(), 20);
  };
  handlers.anth = anthStream({ text: "whole" });
  let L = await load();
  const r = await L.chatTools(ARGS);
  assert.equal(r.provider, "anthropic");
  assert.equal(r.text, "whole");

  L = await load();
  const seen = [];
  await assert.rejects(async () => { for await (const e of L.chatStream(ARGS)) seen.push(e.type); });
  assert.deepEqual(seen.slice(0, 2), ["start", "text"]);
});

test("an aborted call throws and never fails over", async () => {
  chainEnv();
  handlers.ocp = () => { /* hang */ };
  handlers.anth = anthStream({ text: "should-not-run" });
  const L = await load();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(L.chatTools({ ...ARGS, signal: ac.signal }));
  assert.equal(hits.anth, 0);
});

test("Workers AI answers a text-only chatTools call but is skipped when tools are given", async () => {
  // No OCP, no Anthropic: only the runner.
  const L = await load();
  L.setWorkersAiRunner(async () => ({ text: "from-wai", usage: {}, raw: {} }));
  const r = await L.chatTools({ system: "s", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.provider, "workers-ai");
  assert.equal(r.text, "from-wai");
  await assert.rejects(L.chatTools(ARGS), /No LLM provider configured/);
});

test("toolsFromAnthropic converts input_schema tools", async () => {
  const L = await load();
  assert.deepEqual(
    L.toolsFromAnthropic([{ name: "a", description: "d", input_schema: { type: "object", properties: { x: { type: "number" } } } }, { name: "b" }]),
    [
      { type: "function", function: { name: "a", description: "d", parameters: { type: "object", properties: { x: { type: "number" } } } } },
      { type: "function", function: { name: "b", parameters: { type: "object", properties: {} } } },
    ],
  );
});

test("text API unchanged: chatDetailed still non-streaming", async () => {
  chainEnv();
  handlers.ocp = (_q, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "plain" } }] }));
  };
  const L = await load();
  const r = await L.chatDetailed({ system: "s", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.text, "plain");
  assert.equal(bodies.ocp[0].stream, undefined);
});
