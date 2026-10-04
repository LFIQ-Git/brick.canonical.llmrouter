// Black-box tests for dist/llm.js. A local HTTP server stands in for the
// OCP proxy, the ocp-fallback proxy and the Anthropic API, so the real SDKs
// run end to end with no network access and no real keys.
//
// Each test imports a fresh module instance (query-string cache bust) so the
// memoized SDK clients and circuit breakers start clean.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let server;
let base;
/** route prefix -> handler(req, res, body) */
const handlers = {};
const hits = { ocp: 0, fb: 0, anth: 0 };

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // Resolve the leg from a fixed set; never index by the raw URL segment.
      const seg = req.url.split("/")[1];
      const key = seg === "ocp" || seg === "fb" || seg === "anth" ? seg : null;
      if (key === null) {
        res.writeHead(404).end();
        return;
      }
      hits[key] += 1;
      const h = key === "ocp" ? handlers.ocp : key === "fb" ? handlers.fb : handlers.anth;
      if (!h) {
        res.writeHead(404).end();
        return;
      }
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
  "OCP_BASE_URL", "OCP_API_KEY", "OCP_CF_ACCESS_CLIENT_ID", "OCP_CF_ACCESS_CLIENT_SECRET",
  "OCP_FALLBACK_BASE_URL", "OCP_FALLBACK_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
  "LLM_PROVIDER", "LLM_OCP_TIMEOUT_MS", "LLM_OCP_MAX_RETRIES", "LLM_ANTHROPIC_TIMEOUT_MS",
  "LLM_ANTHROPIC_MAX_RETRIES", "LLM_OCP_FALLBACK_TIMEOUT_MS", "LLM_OCP_FALLBACK_MAX_RETRIES",
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of Object.keys(handlers)) delete handlers[k];
  for (const k of Object.keys(hits)) hits[k] = 0;
});

let n = 0;
async function load() {
  n += 1;
  return import(new URL(`../dist/llm.js?t=${n}`, import.meta.url).href);
}

/** Full chain configured; SDK-internal retries off so tests are fast. */
function chainEnv() {
  process.env.OCP_BASE_URL = `${base}/ocp`;
  process.env.OCP_API_KEY = "test-ocp-key-0123456789";
  process.env.OCP_FALLBACK_BASE_URL = `${base}/fb`;
  process.env.OCP_FALLBACK_API_KEY = "test-fb-key-0123456789";
  process.env.ANTHROPIC_BASE_URL = `${base}/anth`;
  process.env.ANTHROPIC_API_KEY = "test-anth-key-0123456789";
  process.env.LLM_OCP_MAX_RETRIES = "0";
  process.env.LLM_ANTHROPIC_MAX_RETRIES = "0";
}

const json = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
const oaiOk = (text) => (_q, res) =>
  json(res, 200, {
    id: "x", object: "chat.completion", created: 0, model: "m",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
const anthOk = (text) => (_q, res) =>
  json(res, 200, {
    id: "msg", type: "message", role: "assistant", model: "m", stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: 7, cache_read_input_tokens: 0 },
  });
const fail = (status, message = "boom") => (_q, res) =>
  json(res, status, { error: { type: "api_error", message } });
const hang = () => () => { /* never respond */ };

/** Capture `llm.call` lines written during fn(). */
async function captureLogs(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const s = String(chunk);
    if (s.startsWith("llm.call ")) {
      lines.push(JSON.parse(s.slice("llm.call ".length)));
      return true;
    }
    return orig(chunk, ...rest);
  };
  try {
    const result = await fn();
    return { result, lines };
  } catch (e) {
    return { error: e, lines };
  } finally {
    process.stdout.write = orig;
  }
}

const ARGS = { system: "sys", messages: [{ role: "user", content: "hi" }] };

test("OCP answers when healthy", async () => {
  chainEnv();
  handlers.ocp = oaiOk("from-ocp");
  const L = await load();
  const { result, lines } = await captureLogs(() => L.chatDetailed(ARGS));
  assert.equal(result.text, "from-ocp");
  assert.equal(result.provider, "ocp");
  assert.equal(result.usage.input_tokens, 3);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, true);
  assert.equal(hits.fb + hits.anth, 0);
});

test("OCP sends CF Access headers and a non-OpenAI User-Agent", async () => {
  chainEnv();
  process.env.OCP_CF_ACCESS_CLIENT_ID = "cf-id";
  process.env.OCP_CF_ACCESS_CLIENT_SECRET = "cf-secret";
  let seen;
  handlers.ocp = (q, res, b) => { seen = q.headers; oaiOk("ok")(q, res, b); };
  const L = await load();
  await captureLogs(() => L.chat(ARGS));
  assert.equal(seen["cf-access-client-id"], "cf-id");
  assert.equal(seen["cf-access-client-secret"], "cf-secret");
  assert.doesNotMatch(seen["user-agent"], /^OpenAI/);
});

test("OCP failure fails over to ocp-fallback", async () => {
  chainEnv();
  handlers.ocp = fail(500);
  handlers.fb = oaiOk("from-fb");
  const L = await load();
  const { result, lines } = await captureLogs(() => L.chatDetailed(ARGS));
  assert.equal(result.provider, "ocp-fallback");
  assert.equal(result.text, "from-fb");
  assert.deepEqual(lines.map((l) => [l.provider, l.ok]), [["ocp", false], ["ocp-fallback", true]]);
  assert.equal(lines[1].failedOver, true);
});

test("OCP and fallback failing land on Anthropic", async () => {
  chainEnv();
  handlers.ocp = fail(502);
  handlers.fb = fail(503);
  handlers.anth = anthOk("from-anth");
  const L = await load();
  const { result, lines } = await captureLogs(() => L.chatDetailed(ARGS));
  assert.equal(result.provider, "anthropic");
  assert.equal(result.text, "from-anth");
  assert.equal(result.usage.cache_creation_input_tokens, 7);
  assert.equal(lines.at(-1).cacheWrite, 7);
  assert.equal(lines.at(-1).failedOver, true);
});

test("OCP failure with no other leg configured rethrows", async () => {
  process.env.OCP_BASE_URL = `${base}/ocp`;
  process.env.LLM_OCP_MAX_RETRIES = "0";
  handlers.ocp = fail(500);
  const L = await load();
  const { error } = await captureLogs(() => L.chat(ARGS));
  assert.ok(error);
  assert.equal(error.status, 500);
});

test("LLM_PROVIDER=anthropic skips the OCP chain", async () => {
  chainEnv();
  process.env.LLM_PROVIDER = "anthropic";
  handlers.ocp = oaiOk("should-not-be-used");
  handlers.anth = anthOk("direct");
  const L = await load();
  const { result } = await captureLogs(() => L.chatDetailed(ARGS));
  assert.equal(result.provider, "anthropic");
  assert.equal(hits.ocp, 0);
});

test("breaker opens after 3 OCP failures and skips OCP", async () => {
  chainEnv();
  handlers.ocp = fail(500);
  handlers.fb = oaiOk("fb");
  const L = await load();
  for (let i = 0; i < 3; i++) await captureLogs(() => L.chat(ARGS));
  assert.equal(hits.ocp, 3);
  await captureLogs(() => L.chat(ARGS));
  assert.equal(hits.ocp, 3, "4th call must not touch OCP while the breaker is open");
  assert.equal(hits.fb, 4);
});

test("a hung OCP times out and fails over promptly", async () => {
  chainEnv();
  process.env.LLM_OCP_TIMEOUT_MS = "300";
  handlers.ocp = hang();
  handlers.fb = oaiOk("fb-after-timeout");
  const L = await load();
  const t = Date.now();
  const { result } = await captureLogs(() => L.chatDetailed(ARGS));
  assert.equal(result.provider, "ocp-fallback");
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t}ms`);
});

test("chatWithRetry retries an SDK timeout (no status, no code)", async () => {
  process.env.ANTHROPIC_BASE_URL = `${base}/anth`;
  process.env.ANTHROPIC_API_KEY = "test-anth-key-0123456789";
  process.env.LLM_ANTHROPIC_TIMEOUT_MS = "200";
  process.env.LLM_ANTHROPIC_MAX_RETRIES = "0";
  let calls = 0;
  handlers.anth = (q, res, b) => {
    calls += 1;
    if (calls === 1) return; // hang -> SDK timeout
    anthOk("second-try")(q, res, b);
  };
  const L = await load();
  const { result, error } = await captureLogs(() => L.chatWithRetry(ARGS));
  assert.equal(error, undefined, error && String(error));
  assert.equal(result, "second-try");
  assert.equal(calls, 2);
});

test("chatWithRetry does not retry a 400", async () => {
  process.env.ANTHROPIC_BASE_URL = `${base}/anth`;
  process.env.ANTHROPIC_API_KEY = "test-anth-key-0123456789";
  process.env.LLM_ANTHROPIC_MAX_RETRIES = "0";
  handlers.anth = fail(400, "bad request");
  const L = await load();
  const { error } = await captureLogs(() => L.chatWithRetry(ARGS));
  assert.equal(error.status, 400);
  assert.equal(hits.anth, 1);
});

test("llm.call err never contains secrets and is length-capped", async () => {
  chainEnv();
  process.env.OCP_CF_ACCESS_CLIENT_SECRET = "cf-secret-value-abcdef";
  const leak =
    `key ${process.env.OCP_API_KEY} cf ${process.env.OCP_CF_ACCESS_CLIENT_SECRET} ` +
    `tok sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA Bearer abcdefghijklmnop123456 ` + "x".repeat(2000);
  handlers.ocp = fail(500, leak);
  handlers.fb = fail(500, `fb ${process.env.OCP_FALLBACK_API_KEY}`);
  handlers.anth = fail(400, `anth ${process.env.ANTHROPIC_API_KEY}`);
  const L = await load();
  const { error, lines } = await captureLogs(() => L.chat(ARGS));
  assert.ok(error);
  assert.equal(lines.length, 3);
  for (const l of lines) {
    const s = JSON.stringify(l);
    for (const secret of [
      process.env.OCP_API_KEY, process.env.OCP_FALLBACK_API_KEY, process.env.ANTHROPIC_API_KEY,
      process.env.OCP_CF_ACCESS_CLIENT_SECRET, "sk-ant-api03-AAAA", "abcdefghijklmnop123456",
    ]) {
      assert.ok(!s.includes(secret), `log leaked ${secret}: ${s}`);
    }
    assert.ok(l.err.length <= 300, `err is ${l.err.length} chars`);
  }
});

test("logging falls back to console.log when stdout.write is unusable", async () => {
  chainEnv();
  handlers.ocp = oaiOk("ok");
  const L = await load();
  const origWrite = process.stdout.write;
  const origLog = console.log;
  const logged = [];
  // Throw only for our log line so the test runner's own output still works.
  process.stdout.write = (chunk, ...rest) => {
    if (String(chunk).startsWith("llm.call ")) throw new Error("no stdout here");
    return origWrite.call(process.stdout, chunk, ...rest);
  };
  console.log = (s) => logged.push(String(s));
  try {
    assert.equal(await L.chat(ARGS), "ok");
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
  assert.equal(logged.filter((s) => s.startsWith("llm.call ")).length, 1);
});

/** A localhost port with nothing listening: connections are refused. */
async function deadPort() {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

test("unreachable ocp-fallback fails fast and lands on Anthropic", async () => {
  chainEnv();
  // Default retry settings: the dead host must still fail in well under 5 s.
  delete process.env.LLM_OCP_MAX_RETRIES;
  process.env.OCP_FALLBACK_BASE_URL = `http://127.0.0.1:${await deadPort()}/v1`;
  handlers.ocp = fail(400, "ocp rejects");
  handlers.anth = anthOk("anth-after-dead-fallback");
  const L = await load();
  const t = Date.now();
  const { result, lines } = await captureLogs(() => L.chatDetailed(ARGS));
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t}ms`);
  assert.equal(result.provider, "anthropic");
  const fb = lines.find((l) => l.provider === "ocp-fallback");
  assert.equal(fb.ok, false);
  assert.match(fb.err, /ECONNREFUSED/);
});

test("OCP and fallback both down with no Anthropic key: throws, both legs logged", async () => {
  chainEnv();
  delete process.env.ANTHROPIC_API_KEY;
  process.env.OCP_BASE_URL = `http://127.0.0.1:${await deadPort()}/v1`;
  process.env.OCP_FALLBACK_BASE_URL = `http://127.0.0.1:${await deadPort()}/v1`;
  const L = await load();
  const { error, lines } = await captureLogs(() => L.chat(ARGS));
  assert.ok(error, "must throw, not hang or return empty text");
  assert.deepEqual(lines.map((l) => [l.provider, l.ok]), [["ocp", false], ["ocp-fallback", false]]);
});

test("dead ocp-fallback trips its own breaker and is skipped", async () => {
  chainEnv();
  process.env.OCP_FALLBACK_BASE_URL = `http://127.0.0.1:${await deadPort()}/v1`;
  process.env.LLM_OCP_FALLBACK_MAX_RETRIES = "0";
  handlers.ocp = fail(500);
  handlers.anth = anthOk("anth");
  const L = await load();
  for (let i = 0; i < 3; i++) await captureLogs(() => L.chat(ARGS));
  const { lines } = await captureLogs(() => L.chat(ARGS));
  assert.deepEqual(lines.map((l) => l.provider), ["anthropic"], "OCP and fallback breakers both open");
});

test("exported API surface is unchanged", async () => {
  const L = await load();
  for (const name of [
    "MODEL_TIERS", "DEFAULT_LLM_MODEL", "getProvider", "chat", "chatDetailed",
    "chatWithRetry", "chatDetailedWithRetry", "withTimeout",
  ]) {
    assert.ok(name in L, `missing export ${name}`);
  }
  assert.deepEqual(Object.keys(L.MODEL_TIERS).sort(), ["balanced", "deep", "fast"]);
});
