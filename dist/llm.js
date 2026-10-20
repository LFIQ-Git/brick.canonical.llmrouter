/**
 * llm.ts — CANONICAL BRICK LLM router (Layer 0).
 *
 * This is the single source of truth. Each app keeps a verbatim copy at
 * `lib/llm.ts`, synced from here — same copy-from-canonical pattern as
 * `canonical-app-family-menu/`. Do NOT edit per-app copies; edit this file
 * and re-sync. Architecture + rollout tracker: 02-brick.intel/docs/llm-architecture.md.
 *
 * Providers (resolved + failed over automatically):
 *   - "ocp"          — Win-PC OCP proxy, subscription-backed, $0/call. Primary
 *                      when OCP_BASE_URL is set and LLM_PROVIDER !== "anthropic".
 *   - "ocp-fallback" — hosted OpenAI-shape proxy on Vercel that translates to
 *                      paid Anthropic API. Intermediate failover for the OCP
 *                      path when OCP_FALLBACK_BASE_URL + OCP_FALLBACK_API_KEY
 *                      are set. Kills the Win-PC single-point-of-failure.
 *   - "anthropic"    — Anthropic SDK, through the Cloudflare AI Gateway when
 *                      AI_GATEWAY_TOKEN is set, else directly with ANTHROPIC_API_KEY. Last
 *                      paid leg on the OCP chain, and the primary when
 *                      LLM_PROVIDER=anthropic.
 *   - "workers-ai"   — Cloudflare Workers AI through the calling Worker's own
 *                      `AI` binding, registered with setWorkersAiRunner(). No
 *                      key, no proxy, no dependency on any other app. Runs only
 *                      after every other leg has failed (or none is configured),
 *                      so an exhausted Anthropic balance, a revoked key or an
 *                      outage degrades extraction instead of stopping it.
 *
 * Four things every app gets for free here:
 *   1. Automatic failover — if OCP errors transiently, the call retries on
 *      Anthropic (when ANTHROPIC_API_KEY exists). A circuit breaker skips a
 *      flapping proxy for a cooldown window.
 *   2. Model tiers — ask for "fast" | "balanced" | "deep" instead of pinning
 *      a model ID in every caller. Bump the map here, once.
 *   3. Observability — every call emits a structured `llm.call` log line
 *      (provider, model, tier, latency, ok) for spend/usage rollups.
 *   4. Two return shapes — `chat()` returns just the text; `chatDetailed()`
 *      returns `{ text, usage, raw, provider }` for callers that need token
 *      counts, the raw provider response, or the provider that actually
 *      answered (post-failover).
 *   5. Tools and streaming (0.8.0): `chatStream()` yields text deltas and
 *      tool-call events; `chatTools()` returns the whole turn with normalized
 *      tool calls. OpenAI-style function tools in, same provider chain and
 *      breakers. The caller runs the tools and sends results back as `tool`
 *      messages.
 *
 * No app may import `openai` / `@anthropic-ai/sdk` outside this file.
 */
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
/** Tier → model ID. One place to bump models family-wide. Keep IDs inside
 *  the OCP proxy allowlist. */
export const MODEL_TIERS = {
    fast: process.env.LLM_MODEL_FAST ?? "claude-haiku-4-5",
    balanced: process.env.LLM_MODEL_BALANCED ?? "claude-sonnet-5-5",
    standard: process.env.LLM_MODEL_BALANCED ?? "claude-sonnet-5-5",
    deep: process.env.LLM_MODEL_DEEP ?? "claude-sonnet-5-5",
};
/** Default model when neither `model` nor `tier` is given. */
export const DEFAULT_LLM_MODEL = process.env.EXTRACTION_MODEL ?? MODEL_TIERS.balanced;
export function getProvider() {
    if ((process.env.LLM_PROVIDER ?? "").toLowerCase() === "anthropic")
        return "anthropic";
    if (process.env.OCP_BASE_URL)
        return "ocp";
    return "anthropic";
}
// ── per-leg timeouts ────────────────────────────────────────────────────
// The SDKs default to a 10-minute timeout with 2 internal retries. On the OCP
// legs that meant a hung Win-PC could hold a call for ~30 minutes before the
// chain moved on. The OCP-shaped legs get a shorter budget so failover is
// prompt; the Anthropic leg keeps SDK defaults unless overridden.
const OCP_TIMEOUT_MS_DEFAULT = 180_000;
const OCP_MAX_RETRIES_DEFAULT = 1;
function envInt(name) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "")
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
/** Timeout + retry settings for the OCP and ocp-fallback clients.
 *  Env: LLM_OCP_TIMEOUT_MS (default 180000), LLM_OCP_MAX_RETRIES (default 1). */
function ocpClientOptions() {
    return {
        timeout: envInt("LLM_OCP_TIMEOUT_MS") ?? OCP_TIMEOUT_MS_DEFAULT,
        maxRetries: envInt("LLM_OCP_MAX_RETRIES") ?? OCP_MAX_RETRIES_DEFAULT,
    };
}
/** ocp-fallback client settings: LLM_OCP_FALLBACK_TIMEOUT_MS /
 *  LLM_OCP_FALLBACK_MAX_RETRIES when set, otherwise the OCP values. An
 *  unreachable fallback host (DNS failure, refused connection) fails in
 *  under a second either way; the timeout only matters for a host that
 *  accepts the connection and then hangs. */
function ocpFallbackClientOptions() {
    const base = ocpClientOptions();
    return {
        timeout: envInt("LLM_OCP_FALLBACK_TIMEOUT_MS") ?? base.timeout,
        maxRetries: envInt("LLM_OCP_FALLBACK_MAX_RETRIES") ?? base.maxRetries,
    };
}
/** Anthropic client overrides — only what the env sets; SDK defaults otherwise.
 *  Env: LLM_ANTHROPIC_TIMEOUT_MS, LLM_ANTHROPIC_MAX_RETRIES. */
function anthropicClientOptions() {
    const opts = {};
    const timeout = envInt("LLM_ANTHROPIC_TIMEOUT_MS");
    const maxRetries = envInt("LLM_ANTHROPIC_MAX_RETRIES");
    if (timeout !== undefined)
        opts.timeout = timeout;
    if (maxRetries !== undefined)
        opts.maxRetries = maxRetries;
    return opts;
}
let _oai = null;
let _oaiFallback = null;
let _anthropic = null;
function getOpenAI() {
    if (_oai)
        return _oai;
    const apiKey = process.env.OCP_API_KEY ?? "ocp-no-key";
    const baseURL = process.env.OCP_BASE_URL;
    if (!baseURL) {
        throw new Error("OCP_BASE_URL not set — cannot route to OCP proxy. Set LLM_PROVIDER=anthropic to fall back to direct Anthropic API.");
    }
    // OCP's gateway 403s the OpenAI SDK's default `User-Agent: OpenAI/JS …`
    // header ("Your request was blocked"). Set a non-OpenAI UA so the
    // subscription proxy accepts the request. Callers can override via the
    // LLM_USER_AGENT env if they want their own identity in the logs.
    const userAgent = process.env.LLM_USER_AGENT ?? "brick-canonical-llm/0.1";
    // Cloudflare Access fronts ocp.lfiq.app: without a service-token pair Access
    // 302s the request to an SSO login page and the SDK receives HTML, not JSON
    // (SyntaxError: Unexpected token '<', "<!DOCTYPE "...). Send the
    // CF-Access-Client-Id/Secret service-token headers when configured.
    const defaultHeaders = { "User-Agent": userAgent };
    const cfId = process.env.OCP_CF_ACCESS_CLIENT_ID;
    const cfSecret = process.env.OCP_CF_ACCESS_CLIENT_SECRET;
    if (cfId && cfSecret) {
        defaultHeaders["CF-Access-Client-Id"] = cfId;
        defaultHeaders["CF-Access-Client-Secret"] = cfSecret;
    }
    _oai = new OpenAI({ apiKey, baseURL, defaultHeaders, ...ocpClientOptions() });
    return _oai;
}
function ocpFallbackConfigured() {
    return Boolean(process.env.OCP_FALLBACK_BASE_URL && process.env.OCP_FALLBACK_API_KEY);
}
function getOpenAIFallback() {
    if (_oaiFallback)
        return _oaiFallback;
    const apiKey = process.env.OCP_FALLBACK_API_KEY;
    const baseURL = process.env.OCP_FALLBACK_BASE_URL;
    if (!apiKey || !baseURL) {
        throw new Error("OCP_FALLBACK_BASE_URL / OCP_FALLBACK_API_KEY not set — ocp-fallback unavailable.");
    }
    const appName = process.env.LLM_APP_NAME ?? "unknown";
    _oaiFallback = new OpenAI({
        apiKey,
        baseURL,
        // X-App-Name lets the fallback proxy log which app a call came from.
        defaultHeaders: { "X-App-Name": appName },
        ...ocpFallbackClientOptions(),
    });
    return _oaiFallback;
}
/** The Left Field Cloudflare AI Gateway's Anthropic endpoint (gateway "default"). */
export const DEFAULT_AI_GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/c16c7246ee0a89e6deafe19a74480c6a/default/anthropic";
/** True when the paid Anthropic leg can run: through the AI Gateway, or directly with a key. */
export function anthropicConfigured() {
    return Boolean(process.env.AI_GATEWAY_TOKEN?.trim() || process.env.ANTHROPIC_API_KEY);
}
/**
 * The paid Anthropic client. With AI_GATEWAY_TOKEN set, calls go through the
 * Cloudflare AI Gateway, which holds the Anthropic key, logs every call and
 * enforces the spend limit; the request carries the gateway token and no
 * x-api-key, so the gateway's stored key is used. Otherwise it calls Anthropic
 * directly with ANTHROPIC_API_KEY. Env: AI_GATEWAY_TOKEN, AI_GATEWAY_URL.
 */
function getAnthropic() {
    if (_anthropic)
        return _anthropic;
    const token = process.env.AI_GATEWAY_TOKEN?.trim();
    if (token) {
        const baseFetch = (input, init) => fetch(input, init);
        _anthropic = new Anthropic({
            apiKey: "gateway",
            baseURL: process.env.AI_GATEWAY_URL?.trim() || DEFAULT_AI_GATEWAY_URL,
            defaultHeaders: { "cf-aig-authorization": `Bearer ${token}` },
            fetch: (input, init) => {
                const headers = new Headers(init?.headers);
                headers.delete("x-api-key");
                return baseFetch(input, { ...init, headers });
            },
            ...anthropicClientOptions(),
        });
        return _anthropic;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
        throw new Error("Neither AI_GATEWAY_TOKEN nor ANTHROPIC_API_KEY is set. Set OCP_BASE_URL to use the subscription proxy instead.");
    }
    _anthropic = new Anthropic({ apiKey, ...anthropicClientOptions() });
    return _anthropic;
}
// ── observability ───────────────────────────────────────────────────────
function logCall(rec) {
    // One structured line per call — cheap to grep / ship to a log drain later.
    // Falls back to console.log on runtimes without a usable process.stdout
    // (e.g. Cloudflare Workers without nodejs_compat).
    try {
        const line = `llm.call ${JSON.stringify({ ...rec, ts: new Date().toISOString() })}`;
        try {
            process.stdout.write(`${line}\n`);
        }
        catch {
            console.log(line);
        }
    }
    catch {
        /* logging must never throw */
    }
    enqueueRun(rec);
}
const ROUTE_TTL_MS = 60_000;
const CONTROL_TIMEOUT_MS = 2_000;
const RUN_QUEUE_MAX = 500;
const CONTROL_KEY = "__brickLlmControl";
const _gc = globalThis;
const _ctl = (_gc[CONTROL_KEY] ??= {
    at: 0,
    routes: null,
    cap: null,
    spent: null,
    inflight: null,
    queue: [],
    hook: null,
});
function controlUrl() {
    const u = process.env.AI_CONTROL_URL?.trim();
    return u ? u.replace(/\/$/, "") : null;
}
function controlHeaders() {
    const s = process.env.AI_CONTROL_SECRET?.trim();
    return s ? { "x-scheduler-secret": s, "content-type": "application/json" } : null;
}
/** Fetch the route table when the cached copy is older than 60 s. Never throws. */
export async function refreshRoutes(force = false) {
    const url = controlUrl();
    const headers = controlHeaders();
    if (!url || !headers)
        return;
    if (!force && Date.now() - _ctl.at < ROUTE_TTL_MS)
        return;
    if (_ctl.inflight)
        return _ctl.inflight;
    _ctl.inflight = (async () => {
        try {
            const r = await fetch(`${url}/api/v1/ai/config?router=brick`, {
                headers,
                signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
            });
            if (r.ok) {
                const j = (await r.json());
                if (Array.isArray(j.routes))
                    _ctl.routes = j.routes;
                _ctl.cap = Number(j.daily_paid_cap_usd ?? NaN);
                _ctl.spent = Number(j.today_paid_usd ?? NaN);
            }
        }
        catch {
            /* keep the previous table */
        }
        finally {
            _ctl.at = Date.now();
            _ctl.inflight = null;
        }
    })();
    return _ctl.inflight;
}
/** Receive every finished call as well (metrics, tests). Errors in the hook are swallowed. */
export function onRun(hook) {
    _ctl.hook = hook;
}
function appName() {
    return (process.env.LLM_APP_NAME || "unknown").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}
/** ai.routes tier for a router tier: balanced and standard are the same tier. */
export function tableTier(tier) {
    if (tier === "fast" || tier === "deep")
        return tier;
    return "standard";
}
function enqueueRun(rec) {
    if (!rec.task || (!controlUrl() && !_ctl.hook))
        return;
    const run = {
        router: "brick",
        app: rec.task.split(".")[0],
        task: rec.task,
        tier: rec.routeTier ?? tableTier(rec.tier),
        provider: rec.provider,
        model: rec.model,
        ...(rec.usage?.input_tokens !== undefined ? { input_tokens: rec.usage.input_tokens } : {}),
        ...(rec.usage?.output_tokens !== undefined ? { output_tokens: rec.usage.output_tokens } : {}),
        latency_ms: rec.latencyMs,
        fell_back: Boolean(rec.failedOver),
        ok: rec.ok,
        ...(rec.err ? { error: rec.err.slice(0, 300) } : {}),
    };
    if (_ctl.hook) {
        try {
            void Promise.resolve(_ctl.hook(run)).catch(() => { });
        }
        catch {
            /* hook errors never fail a call */
        }
    }
    if (controlUrl()) {
        _ctl.queue.push(run);
        if (_ctl.queue.length > RUN_QUEUE_MAX)
            _ctl.queue.splice(0, _ctl.queue.length - RUN_QUEUE_MAX);
    }
}
/** Send queued runs to ai.runs. Awaited at the end of every call (2 s cap). Never throws. */
export async function flushRuns() {
    const url = controlUrl();
    const headers = controlHeaders();
    if (!url || !headers || _ctl.queue.length === 0)
        return;
    const batch = _ctl.queue.splice(0, 100);
    try {
        const r = await fetch(`${url}/api/v1/ai/runs`, {
            method: "POST",
            headers,
            body: JSON.stringify({ runs: batch }),
            signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        });
        if (r.ok && typeof _ctl.spent === "number") {
            /* spend refreshes with the next route fetch */
        }
    }
    catch {
        /* dropped: a logging failure never fails a call */
    }
}
export function taskEnvName(task) {
    return `AI_ROUTE_${task.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}
function legsToModels(legs) {
    const out = {};
    for (const l of legs) {
        if (l.provider === "ocp" && !out.ocpModel)
            out.ocpModel = l.model;
        if (l.provider === "anthropic" && !out.anthropicModel)
            out.anthropicModel = l.model;
    }
    return out;
}
/** Parse "ocp:claude-sonnet-5-5,anthropic:claude-sonnet-5-5". */
export function parseRouteOverride(spec) {
    return spec.split(",").map((part) => {
        const s = part.trim();
        const i = s.indexOf(":");
        const provider = s.slice(0, i);
        const model = s.slice(i + 1).trim();
        if (i < 1 || !model)
            throw new Error(`bad route leg "${s}": use provider:model`);
        if (provider !== "ocp" && provider !== "anthropic") {
            throw new Error(`route provider "${provider}" is not allowed on the BRICK router (ocp or anthropic)`);
        }
        return { provider, model };
    });
}
/**
 * Resolve the models for one call. Order: an explicit `model`, then
 * AI_ROUTE_<TASK>, then the ai.routes table (task override, else tier default),
 * then MODEL_TIERS. The daily paid cap applies to table routes: past 80% the
 * standard tier's paid model steps down to the fast tier's, and at the cap
 * paid legs are skipped.
 */
export async function resolveRoute(args) {
    const tier = tableTier(args.tier);
    const task = args.task || `${appName()}.${tier}`;
    if (args.model)
        return { task, tier, ocpModel: args.model, anthropicModel: args.model, source: "model", budget: "ok" };
    const override = args.task ? process.env[taskEnvName(args.task)]?.trim() : undefined;
    if (override)
        return { task, tier, ...legsToModels(parseRouteOverride(override)), source: "override", budget: "ok" };
    await refreshRoutes();
    const routes = _ctl.routes;
    if (routes) {
        const route = (args.task ? routes.find((r) => r.task === args.task) : undefined) ??
            routes.find((r) => r.task === null && r.tier === tier);
        if (route) {
            const models = legsToModels([route.primary, ...(route.fallback ? [route.fallback] : [])]);
            let budget = "ok";
            const cap = _ctl.cap ?? NaN;
            const spent = _ctl.spent ?? NaN;
            if (cap > 0 && spent >= cap) {
                budget = "held";
                delete models.anthropicModel;
            }
            else if (cap > 0 && spent >= cap * 0.8 && route.tier === "standard") {
                const fast = routes.find((r) => r.task === null && r.tier === "fast");
                const fastPaid = fast ? legsToModels([fast.primary, ...(fast.fallback ? [fast.fallback] : [])]).anthropicModel : undefined;
                if (fastPaid) {
                    budget = "step_down";
                    models.anthropicModel = fastPaid;
                }
            }
            return { task, tier: route.tier, ...models, source: "table", budget };
        }
    }
    const model = args.tier ? MODEL_TIERS[args.tier] : DEFAULT_LLM_MODEL;
    return { task, tier, ocpModel: model, anthropicModel: model, source: "builtin", budget: "ok" };
}
// ── error redaction — nothing secret reaches a log line ──────────────────
const SECRET_ENV_NAMES = [
    "OCP_API_KEY",
    "OCP_CF_ACCESS_CLIENT_ID",
    "OCP_CF_ACCESS_CLIENT_SECRET",
    "OCP_FALLBACK_API_KEY",
    "ANTHROPIC_API_KEY",
    "AI_GATEWAY_TOKEN",
];
const ERR_MAX_CHARS = 300;
// [pattern, replacement] — replacements keep the label, drop the value.
const TOKEN_PATTERNS = [
    [/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]"], // Anthropic / OpenAI-style keys
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"], // auth header values
    [
        /\b(api[_-]?key|x-api-key|cf-aig-authorization|authorization|cf-access-client-secret|cf-access-client-id)(["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
        "$1$2[redacted]",
    ],
];
/** First string `code` found walking the `cause` chain (max 5 levels). */
function rootCauseCode(e) {
    let cur = e;
    for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
        const code = cur.code;
        if (typeof code === "string" && code)
            return code;
        cur = cur.cause;
    }
    return undefined;
}
/** Error text safe to log: configured secret values and token-shaped strings
 *  removed, whitespace collapsed, capped at ERR_MAX_CHARS. */
function redactErr(e) {
    let s;
    try {
        s = e instanceof Error ? e.message : String(e);
        // SDK connection errors say only "Connection error."; surface the
        // network cause code (ENOTFOUND, ECONNREFUSED, ...) so a dead leg is
        // obvious in the log.
        const code = rootCauseCode(e);
        if (code && !s.includes(code))
            s = `${s} (${code})`;
    }
    catch {
        s = "[unprintable error]";
    }
    for (const name of SECRET_ENV_NAMES) {
        const v = process.env[name];
        if (v && v.length >= 6)
            s = s.split(v).join("[redacted]");
    }
    for (const [re, replacement] of TOKEN_PATTERNS)
        s = s.replace(re, replacement);
    s = s.replace(/\s+/g, " ").trim();
    return s.length > ERR_MAX_CHARS ? `${s.slice(0, ERR_MAX_CHARS - 1)}…` : s;
}
// ── circuit breakers — skip a flapping proxy for a cooldown ──────────────
// Independent breakers per leg of the OCP chain so a wedged Win-PC doesn't
// trip the hosted fallback and vice versa.
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;
function makeBreaker() {
    let failures = 0;
    let openedAt = 0;
    return {
        open() {
            if (failures < BREAKER_THRESHOLD)
                return false;
            if (Date.now() - openedAt > BREAKER_COOLDOWN_MS) {
                failures = 0; // cooldown elapsed — half-open, allow a probe
                return false;
            }
            return true;
        },
        note(ok) {
            if (ok) {
                failures = 0;
            }
            else {
                failures += 1;
                if (failures >= BREAKER_THRESHOLD)
                    openedAt = Date.now();
            }
        },
    };
}
const _ocpBreaker = makeBreaker();
const _ocpFallbackBreaker = makeBreaker();
function resolveModel(args) {
    if (args.model)
        return { model: args.model, tier: args.tier };
    if (args.tier)
        return { model: MODEL_TIERS[args.tier], tier: args.tier };
    return { model: DEFAULT_LLM_MODEL };
}
/** Default backstop model: general-purpose, 262k context, on the Workers AI catalog. */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/zai-org/glm-5.2";
// Kept on globalThis, not in a module variable: bundlers such as vinext can load
// this module once per environment (rsc, ssr), and a runner registered from the
// Worker entry must be visible to every copy.
const RUNNER_KEY = "__lfiqWorkersAiRunner";
const _g = globalThis;
function workersAiRunner() {
    return _g[RUNNER_KEY] ?? null;
}
/**
 * Register the last-resort Workers AI leg. Call once per isolate from a Worker
 * entry point; see workersAiRunnerFromBinding(). Pass null to remove it.
 * Outside a Worker nothing is registered and the chain is unchanged.
 */
export function setWorkersAiRunner(runner) {
    _g[RUNNER_KEY] = runner;
}
/**
 * Build a runner from a Workers AI binding. Handles both response shapes the
 * catalog returns: `{ response: string }` and OpenAI-style `{ choices: [...] }`.
 */
export function workersAiRunnerFromBinding(ai) {
    return async ({ model, system, messages, maxTokens, temperature }) => {
        const raw = (await ai.run(model, {
            messages: [{ role: "system", content: system }, ...messages],
            max_tokens: maxTokens,
            ...(temperature !== undefined ? { temperature } : {}),
        }));
        const fromChoices = raw?.choices?.[0]?.message?.content;
        const text = typeof raw?.response === "string"
            ? raw.response
            : typeof fromChoices === "string"
                ? fromChoices
                : raw?.response !== undefined
                    ? JSON.stringify(raw.response)
                    : "";
        return {
            text,
            usage: { input_tokens: raw?.usage?.prompt_tokens, output_tokens: raw?.usage?.completion_tokens },
            raw,
        };
    };
}
async function callWorkersAi(system, messages, maxTokens, temperature) {
    const runner = workersAiRunner();
    if (!runner)
        throw new Error("workers-ai runner not registered");
    const model = process.env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL;
    const out = await runner({ model, system, messages, maxTokens, temperature });
    if (!out.text)
        throw new Error(`workers-ai returned no text (${model})`);
    return { out, model };
}
async function callOpenAIShape(client, system, messages, model, maxTokens, temperature) {
    const r = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
        messages: [
            { role: "system", content: system },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
    });
    return {
        text: r.choices[0]?.message?.content ?? "",
        usage: {
            input_tokens: r.usage?.prompt_tokens,
            output_tokens: r.usage?.completion_tokens,
        },
        raw: r,
    };
}
const callOcp = (s, m, model, mt, t) => callOpenAIShape(getOpenAI(), s, m, model, mt, t);
const callOcpFallback = (s, m, model, mt, t) => callOpenAIShape(getOpenAIFallback(), s, m, model, mt, t);
/**
 * Per-model settings for a plain text call. Thinking tokens count against
 * max_tokens, so a model that thinks by default needs thinking off or room.
 * Haiku 4.x does not think by default and takes sampling settings; Sonnet 5.5
 * thinks by default, rejects sampling settings, and turns thinking off with
 * `between_tools`; other current models think always, so they get low effort
 * and headroom. Older models pass through unchanged.
 */
export function anthropicTextSettings(model, maxTokens, temperature) {
    if (model === "claude-sonnet-5-5")
        return { max_tokens: maxTokens, thinking: { type: "between_tools" } };
    if (/^claude-(opus-5|fable-5|haiku-5)/.test(model))
        return { max_tokens: maxTokens + 4096, output_config: { effort: "low" } };
    return { max_tokens: maxTokens, ...(temperature !== undefined ? { temperature } : {}) };
}
async function callAnthropic(system, messages, model, maxTokens, temperature) {
    // System block marked cache_control: ephemeral → 5-min prompt-cache hits
    // (~90% input-token discount) when the system prefix repeats.
    const a = getAnthropic();
    const r = await a.messages.create({
        model,
        ...anthropicTextSettings(model, maxTokens, temperature),
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const block = r.content.find((b) => b.type === "text");
    return {
        text: block && block.type === "text" ? block.text : "",
        usage: {
            input_tokens: r.usage?.input_tokens,
            output_tokens: r.usage?.output_tokens,
            cache_creation_input_tokens: r.usage?.cache_creation_input_tokens ?? undefined,
            cache_read_input_tokens: r.usage?.cache_read_input_tokens ?? undefined,
        },
        raw: r,
    };
}
/**
 * Core routing + failover. Returns the rich result. `chat()` and
 * `chatDetailed()` are thin wrappers over this.
 *
 * Routing chain when primary === "ocp" (Win-PC reachable):
 *   1. OCP (Win-PC, $0)               — skip if breaker open
 *   2. ocp-fallback (hosted, paid)    — skip if not configured or breaker open
 *   3. Anthropic direct SDK           — skip if ANTHROPIC_API_KEY unset
 *
 * Each step's transient failure is logged + advances to the next. When primary
 * is "anthropic" (forced or no OCP_BASE_URL), only step 3 runs; the OCP chain
 * is opt-in and Anthropic-primary callers don't pay the latency of probing it.
 */
async function runChat(args) {
    try {
        return await runChatLegs(args);
    }
    finally {
        await flushRuns();
    }
}
async function runChatLegs(args) {
    const route = await resolveRoute(args);
    const { task } = route;
    const tier = args.tier;
    const routeTier = route.tier;
    const maxTokens = args.maxTokens ?? 8192;
    const primary = getProvider();
    const ocpModel = route.ocpModel;
    const paidModel = route.anthropicModel;
    const anthropicAvailable = anthropicConfigured() && Boolean(paidModel);
    const fallbackAvailable = ocpFallbackConfigured() && Boolean(paidModel);
    const ctx = { tier, task, routeTier };
    // ── Leg 1: OCP (Win-PC) ────────────────────────────────────────────────
    if (primary === "ocp" && ocpModel && !_ocpBreaker.open()) {
        const t = Date.now();
        try {
            const out = await callOcp(args.system, args.messages, ocpModel, maxTokens, args.temperature);
            _ocpBreaker.note(true);
            logCall({ provider: "ocp", model: ocpModel, ...ctx, usage: out.usage, latencyMs: Date.now() - t, ok: true });
            return { ...out, provider: "ocp" };
        }
        catch (e) {
            _ocpBreaker.note(false);
            const err = redactErr(e);
            logCall({ provider: "ocp", model: ocpModel, ...ctx, latencyMs: Date.now() - t, ok: false, err });
            if (!fallbackAvailable && !anthropicAvailable && !workersAiRunner())
                throw e;
            // fall through
        }
    }
    // ── Leg 2: ocp-fallback (hosted) ───────────────────────────────────────
    if (primary === "ocp" && paidModel && fallbackAvailable && !_ocpFallbackBreaker.open()) {
        const t = Date.now();
        try {
            const out = await callOcpFallback(args.system, args.messages, paidModel, maxTokens, args.temperature);
            _ocpFallbackBreaker.note(true);
            logCall({ provider: "ocp-fallback", model: paidModel, ...ctx, usage: out.usage, latencyMs: Date.now() - t, ok: true, failedOver: true });
            return { ...out, provider: "ocp-fallback" };
        }
        catch (e) {
            _ocpFallbackBreaker.note(false);
            const err = redactErr(e);
            logCall({ provider: "ocp-fallback", model: paidModel, ...ctx, latencyMs: Date.now() - t, ok: false, failedOver: true, err });
            if (!anthropicAvailable && !workersAiRunner())
                throw e;
            // fall through
        }
    }
    // ── Leg 3: Anthropic direct SDK ────────────────────────────────────────
    const fellOver = primary === "ocp" && Boolean(ocpModel);
    let lastErr = new Error(route.budget === "held"
        ? `Daily paid AI cap reached for the BRICK router; ${task} has no free leg that answered.`
        : "No LLM provider configured: set ANTHROPIC_API_KEY or OCP_BASE_URL.");
    if (anthropicAvailable && paidModel) {
        const t = Date.now();
        try {
            const out = await callAnthropic(args.system, args.messages, paidModel, maxTokens, args.temperature);
            logCall({
                provider: "anthropic",
                model: paidModel,
                ...ctx,
                usage: out.usage,
                latencyMs: Date.now() - t,
                ok: true,
                failedOver: fellOver,
                cacheWrite: out.usage.cache_creation_input_tokens,
                cacheRead: out.usage.cache_read_input_tokens,
            });
            return { ...out, provider: "anthropic" };
        }
        catch (e) {
            const err = redactErr(e);
            logCall({ provider: "anthropic", model: paidModel, ...ctx, latencyMs: Date.now() - t, ok: false, failedOver: fellOver, err });
            if (!workersAiRunner())
                throw e;
            lastErr = e;
        }
    }
    // ── Leg 4: Workers AI backstop (calling Worker's own AI binding) ───────
    if (!workersAiRunner())
        throw lastErr;
    const t4 = Date.now();
    try {
        const { out, model: wModel } = await callWorkersAi(args.system, args.messages, maxTokens, args.temperature);
        logCall({ provider: "workers-ai", model: wModel, ...ctx, usage: out.usage, latencyMs: Date.now() - t4, ok: true, failedOver: true });
        return { ...out, provider: "workers-ai" };
    }
    catch (e) {
        const err = redactErr(e);
        logCall({
            provider: "workers-ai",
            model: process.env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL,
            ...ctx,
            latencyMs: Date.now() - t4,
            ok: false,
            failedOver: true,
            err,
        });
        // Surface the paid-leg error: it is the one an operator needs to act on.
        throw lastErr;
    }
}
/**
 * Single round-trip chat. Returns the model's text ("" if none). For token
 * counts or the raw provider response, use `chatDetailed()`.
 */
export async function chat(args) {
    return (await runChat(args)).text;
}
/**
 * Like `chat()`, but returns the rich result — `{ text, usage, raw, provider }`.
 * Use when you need token counts, the raw response (e.g. stop_reason), or the
 * provider that actually answered after failover.
 */
export async function chatDetailed(args) {
    return runChat(args);
}
// ── retry helpers ───────────────────────────────────────────────────────
const LLM_MAX_ATTEMPTS = 3;
const LLM_BACKOFF_MS = [500, 1500, 4000];
function isTransientLLMError(e) {
    if (!e || typeof e !== "object")
        return false;
    // SDK connection failures and timeouts carry no HTTP status or Node error
    // code — classify them by class (APIConnectionTimeoutError extends
    // APIConnectionError in both SDKs).
    if (e instanceof OpenAI.APIConnectionError || e instanceof Anthropic.APIConnectionError)
        return true;
    const status = e.status;
    if (status === 429)
        return true;
    if (typeof status === "number" && status >= 500 && status < 600)
        return true;
    const code = e.code;
    // `ETIMEDOUT` is Node's connection-timeout code — list it explicitly; the
    // literal `TIMEOUT` does not match it as a substring. `TIMEOUT` still
    // covers SDK-specific timeout codes (e.g. `REQUEST_TIMEOUT`).
    if (code && /ETIMEDOUT|TIMEOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(code))
        return true;
    return false;
}
export async function chatWithRetry(args) {
    return (await chatDetailedWithRetry(args)).text;
}
export async function chatDetailedWithRetry(args) {
    let lastErr;
    for (let attempt = 0; attempt < LLM_MAX_ATTEMPTS; attempt++) {
        try {
            return await runChat(args);
        }
        catch (e) {
            lastErr = e;
            if (!isTransientLLMError(e) || attempt === LLM_MAX_ATTEMPTS - 1)
                throw e;
            const delay = LLM_BACKOFF_MS[attempt] ?? 4000;
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
export function withTimeout(p, ms, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}
/** Convert Anthropic-format tools (`{ name, description, input_schema }`) to
 *  OpenAI function tools, for callers migrating from the Anthropic SDK. */
export function toolsFromAnthropic(tools) {
    return tools.map((t) => ({
        type: "function",
        function: {
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            parameters: t.input_schema ?? { type: "object", properties: {} },
        },
    }));
}
function systemText(system) {
    return typeof system === "string" ? system : system.map((p) => p.text).join("");
}
function parseArgs(raw) {
    if (!raw)
        return {};
    try {
        const v = JSON.parse(raw);
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    }
    catch {
        return {};
    }
}
function isAbort(e, signal) {
    if (signal?.aborted)
        return true;
    const name = e?.name;
    return name === "AbortError" || e instanceof OpenAI.APIUserAbortError || e instanceof Anthropic.APIUserAbortError;
}
function toOpenAIMessages(system, messages) {
    const out = [{ role: "system", content: systemText(system) }];
    for (const m of messages) {
        if (m.role === "user")
            out.push({ role: "user", content: m.content });
        else if (m.role === "assistant") {
            if (m.toolCalls?.length) {
                out.push({
                    role: "assistant",
                    content: m.content || null,
                    tool_calls: m.toolCalls.map((c) => ({
                        id: c.id,
                        type: "function",
                        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
                    })),
                });
            }
            else
                out.push({ role: "assistant", content: m.content });
        }
        else
            out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
    return out;
}
function mapOpenAIFinish(r) {
    if (r === "stop")
        return "stop";
    if (r === "tool_calls" || r === "function_call")
        return "tool_calls";
    if (r === "length")
        return "length";
    return "other";
}
async function* openAIShapeLeg(client, args, model) {
    const tools = args.tools?.length ? args.tools : undefined;
    const body = {
        model,
        max_tokens: args.maxTokens ?? 8192,
        stream: true,
        stream_options: { include_usage: true },
        messages: toOpenAIMessages(args.system, args.messages),
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        ...(tools ? { tools, ...(args.toolChoice ? { tool_choice: args.toolChoice } : {}) } : {}),
        ...(args.effort ? { reasoning_effort: args.effort } : {}),
    };
    const stream = await client.chat.completions.create(body, { signal: args.signal });
    let text = "";
    let finish;
    let usage = {};
    const calls = [];
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
        if (chunk.usage) {
            usage = { input_tokens: chunk.usage.prompt_tokens, output_tokens: chunk.usage.completion_tokens };
        }
        const choice = chunk.choices?.[0];
        if (!choice)
            continue;
        const delta = choice.delta;
        if (delta?.content) {
            text += delta.content;
            yield { type: "text", text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
            const i = tc.index ?? calls.length;
            const slot = (calls[i] ??= { id: "", name: "", args: "", started: false });
            if (tc.id)
                slot.id = tc.id;
            if (tc.function?.name)
                slot.name += tc.function.name;
            if (tc.function?.arguments)
                slot.args += tc.function.arguments;
            if (!slot.started && slot.name) {
                slot.started = true;
                yield { type: "tool_call_start", index: i, id: slot.id, name: slot.name };
            }
        }
        if (choice.finish_reason)
            finish = choice.finish_reason;
    }
    const toolCalls = calls
        .filter((c) => c && c.name)
        .map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: parseArgs(c.args) }));
    for (const call of toolCalls)
        yield { type: "tool_call", call };
    let finishReason = mapOpenAIFinish(finish);
    if (toolCalls.length && finishReason !== "length")
        finishReason = "tool_calls";
    yield { type: "end", out: { text, usage, raw: chunks, toolCalls, finishReason } };
}
const EPHEMERAL = { type: "ephemeral" };
/** Translate the normalized conversation to Anthropic messages. Tool results
 *  become `tool_result` blocks on a user turn; consecutive same-role turns are
 *  merged, since Anthropic requires alternation. The last block gets a cache
 *  breakpoint so each tool-loop round trip reads the previous one from cache. */
function toAnthropicMessages(messages) {
    const out = [];
    const push = (role, blocks) => {
        if (!blocks.length)
            return;
        const last = out[out.length - 1];
        if (last && last.role === role)
            last.content.push(...blocks);
        else
            out.push({ role, content: blocks });
    };
    for (const m of messages) {
        if (m.role === "user")
            push("user", m.content ? [{ type: "text", text: m.content }] : []);
        else if (m.role === "assistant" && Array.isArray(m.providerBlocks) && m.providerBlocks.length) {
            push("assistant", m.providerBlocks);
        }
        else if (m.role === "assistant") {
            const blocks = [];
            if (m.content)
                blocks.push({ type: "text", text: m.content });
            for (const c of m.toolCalls ?? [])
                blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} });
            push("assistant", blocks);
        }
        else {
            push("user", [{
                    type: "tool_result",
                    tool_use_id: m.toolCallId,
                    content: m.content,
                    ...(m.isError ? { is_error: true } : {}),
                }]);
        }
    }
    const last = out[out.length - 1];
    if (last) {
        const i = last.content.length - 1;
        const b = last.content[i];
        if (!(b.type === "text" && !b.text))
            last.content[i] = { ...b, cache_control: EPHEMERAL };
    }
    return out;
}
function mapAnthropicStop(r) {
    if (r === "end_turn" || r === "stop_sequence")
        return "stop";
    if (r === "tool_use")
        return "tool_calls";
    if (r === "max_tokens")
        return "length";
    return "other";
}
/**
 * Thinking and sampling settings for a tool turn. Sonnet 5.5 thinks by default
 * and rejects sampling settings; `between_tools` keeps it from spending the
 * answer budget on extended thinking (accepted at effort high or below, and only
 * when the caller sets no thinking of its own). Haiku 4.x and older models keep
 * the caller's temperature.
 */
function anthropicToolSettings(model, args) {
    const callerThinking = Boolean(args.anthropic && "thinking" in args.anthropic);
    if (model === "claude-sonnet-5-5") {
        return !callerThinking && args.effort !== "xhigh" && args.effort !== "max" ? { thinking: { type: "between_tools" } } : {};
    }
    if (/^claude-(opus-5|fable-5|haiku-5)/.test(model))
        return {};
    return args.temperature !== undefined ? { temperature: args.temperature } : {};
}
async function* anthropicLeg(args, model) {
    const a = getAnthropic();
    const system = typeof args.system === "string"
        ? [{ type: "text", text: args.system, cache_control: EPHEMERAL }]
        : args.system.filter((p) => p.text).map((p) => ({ type: "text", text: p.text, ...(p.cache_control ? { cache_control: p.cache_control } : {}) }));
    const tools = (args.tools ?? []).map((t, i, all) => ({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
        ...(i === all.length - 1 ? { cache_control: EPHEMERAL } : {}),
    }));
    const body = {
        model,
        max_tokens: args.maxTokens ?? 8192,
        system,
        messages: toAnthropicMessages(args.messages),
        ...anthropicToolSettings(model, args),
        ...(tools.length ? { tools, ...(args.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}) } : {}),
        ...(args.effort ? { output_config: { effort: args.effort } } : {}),
        ...(args.anthropic ?? {}),
    };
    const stream = a.messages.stream(body, { signal: args.signal });
    let index = 0;
    for await (const ev of stream) {
        if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
            yield { type: "tool_call_start", index: index++, id: ev.content_block.id, name: ev.content_block.name };
        }
        else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) {
            yield { type: "text", text: ev.delta.text };
        }
    }
    const final = await stream.finalMessage();
    const toolCalls = [];
    let text = "";
    for (const b of final.content) {
        if (b.type === "text")
            text += b.text;
        else if (b.type === "tool_use") {
            const input = b.input;
            toolCalls.push({
                id: b.id,
                name: b.name,
                arguments: input && typeof input === "object" && !Array.isArray(input) ? input : {},
            });
        }
    }
    for (const call of toolCalls)
        yield { type: "tool_call", call };
    yield {
        type: "end",
        out: {
            text,
            usage: {
                input_tokens: final.usage?.input_tokens,
                output_tokens: final.usage?.output_tokens,
                cache_creation_input_tokens: final.usage?.cache_creation_input_tokens ?? undefined,
                cache_read_input_tokens: final.usage?.cache_read_input_tokens ?? undefined,
            },
            raw: final,
            toolCalls,
            finishReason: mapAnthropicStop(final.stop_reason),
            providerBlocks: final.content,
        },
    };
}
async function* workersAiLeg(args) {
    const msgs = [];
    for (const m of args.messages) {
        if (m.role === "user" || m.role === "assistant")
            msgs.push({ role: m.role, content: m.content });
    }
    const { out } = await callWorkersAi(systemText(args.system), msgs, args.maxTokens ?? 8192, args.temperature);
    yield { type: "text", text: out.text };
    yield { type: "end", out: { text: out.text, usage: out.usage, raw: out.raw, toolCalls: [], finishReason: "stop" } };
}
function streamLegs(args, model) {
    const primary = getProvider();
    const legs = [];
    if (primary === "ocp") {
        if (!_ocpBreaker.open()) {
            legs.push({ provider: "ocp", model, failedOver: false, breaker: _ocpBreaker, run: () => openAIShapeLeg(getOpenAI(), args, model) });
        }
        if (ocpFallbackConfigured() && !_ocpFallbackBreaker.open()) {
            legs.push({ provider: "ocp-fallback", model, failedOver: true, breaker: _ocpFallbackBreaker, run: () => openAIShapeLeg(getOpenAIFallback(), args, model) });
        }
    }
    if (anthropicConfigured()) {
        legs.push({ provider: "anthropic", model, failedOver: primary === "ocp", run: () => anthropicLeg(args, model) });
    }
    if (workersAiRunner() && !args.tools?.length) {
        legs.push({
            provider: "workers-ai",
            model: process.env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL,
            failedOver: true,
            run: () => workersAiLeg(args),
        });
    }
    return legs;
}
/**
 * Core of chatStream / chatTools. `buffered` collects a whole leg before
 * yielding anything, so a failure at any point can move to the next leg.
 * Unbuffered, failover is possible only until the first event is yielded.
 */
async function* runStream(args, buffered) {
    try {
        yield* runStreamLegs(args, buffered);
    }
    finally {
        await flushRuns();
    }
}
async function* runStreamLegs(args, buffered) {
    const { model, tier } = resolveModel({ system: "", messages: [], model: args.model, tier: args.tier });
    const task = args.task || `${appName()}.${tableTier(tier)}`;
    const legs = streamLegs(args, model);
    const mode = buffered ? "tools" : "stream";
    let lastErr = new Error("No LLM provider configured: set ANTHROPIC_API_KEY or OCP_BASE_URL.");
    // Surface the most actionable error: the last paid leg's, not the backstop's.
    let paidErr;
    for (const leg of legs) {
        if (args.signal?.aborted)
            throw args.signal.reason ?? new Error("aborted");
        const t = Date.now();
        let emitted = false;
        const log = (ok, extra = {}) => logCall({
            provider: leg.provider,
            model: leg.model,
            tier,
            task,
            ...(extra.out ? { usage: extra.out.usage } : {}),
            latencyMs: Date.now() - t,
            ok,
            ...(leg.failedOver ? { failedOver: true } : {}),
            mode,
            ...(extra.out ? { toolCalls: extra.out.toolCalls.length } : {}),
            ...(extra.out?.usage.cache_creation_input_tokens !== undefined ? { cacheWrite: extra.out.usage.cache_creation_input_tokens } : {}),
            ...(extra.out?.usage.cache_read_input_tokens !== undefined ? { cacheRead: extra.out.usage.cache_read_input_tokens } : {}),
            ...(extra.err ? { err: extra.err } : {}),
        });
        try {
            const pending = [];
            let result = null;
            for await (const ev of leg.run()) {
                let out;
                if (ev.type === "end") {
                    result = {
                        ...ev.out,
                        provider: leg.provider,
                        model: leg.model,
                        message: {
                            role: "assistant",
                            content: ev.out.text,
                            ...(ev.out.toolCalls.length ? { toolCalls: ev.out.toolCalls } : {}),
                            ...(ev.out.providerBlocks ? { providerBlocks: ev.out.providerBlocks } : {}),
                        },
                    };
                    out = { type: "done", result };
                }
                else
                    out = ev;
                if (buffered)
                    pending.push(out);
                else {
                    if (!emitted) {
                        emitted = true;
                        yield { type: "start", provider: leg.provider, model: leg.model };
                    }
                    yield out;
                }
            }
            if (!result)
                throw new Error(`${leg.provider} stream ended without a result`);
            leg.breaker?.note(true);
            log(true, { out: result });
            if (buffered) {
                yield { type: "start", provider: leg.provider, model: leg.model };
                for (const ev of pending)
                    yield ev;
            }
            return;
        }
        catch (e) {
            if (isAbort(e, args.signal))
                throw e;
            leg.breaker?.note(false);
            log(false, { err: redactErr(e) });
            if (emitted)
                throw e; // text already reached the caller; no silent restart
            lastErr = e;
            if (leg.provider !== "workers-ai")
                paidErr = e;
        }
    }
    throw paidErr ?? lastErr;
}
/**
 * Stream one model turn with optional function tools. Yields `start`
 * (provider + model), `text` deltas, `tool_call_start`, `tool_call` and a
 * final `done` carrying the full `ToolChatResult`. Fails over to the next leg
 * only before the first event; after that an error is thrown.
 */
export function chatStream(args) {
    return runStream(args, false);
}
/**
 * One model turn with optional function tools, not streamed to the caller.
 * Returns the text, normalized tool calls and finish reason. Fails over to the
 * next leg on any error, mid-response included.
 */
export async function chatTools(args) {
    for await (const ev of runStream(args, true)) {
        if (ev.type === "done")
            return ev.result;
    }
    throw new Error("chatTools: no result");
}
//# sourceMappingURL=llm.js.map