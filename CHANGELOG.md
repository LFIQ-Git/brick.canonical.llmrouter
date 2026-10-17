# Changelog

All notable changes to `@lfiq/canonical-llm`. Consumers pin by commit SHA; bump the pin to pick up a release.

## 0.9.1 (2026-10-16)

Tool turns on Sonnet 5.5. Additive.

### Fixed
- **Thinking blocks are kept between tool rounds.** `chatTools` and `chatStream` threw away the Anthropic thinking blocks when the caller rebuilt the assistant turn. Each result now carries `message`, the assistant turn with its Anthropic content blocks in `providerBlocks`. Append it as is (`messages.push(r.message)`) and the Anthropic leg replays it unchanged. Other legs ignore `providerBlocks`.
- **Sonnet 5.5 tool turns.** They now send `thinking: {type: "between_tools"}`, unless the caller sets thinking itself or asks for effort above `high`. They also no longer send sampling settings, which Sonnet 5.5 rejects. Opus 5.x, Fable 5 and Haiku 5.x get no sampling settings either.

## 0.9.0 (2026-10-15)

Phase 2 of the AI Model Usage Plan. Additive, apart from the Sonnet 5.5 change noted below. With no new env vars set, routing is the same as 0.8.0.

### Added
- **Task keys.** `chat`, `chatDetailed`, `chatStream` and `chatTools` take a `task` ("intel.brief"). It defaults to `<LLM_APP_NAME>.<tier>`.
- **Route table.** With `AI_CONTROL_URL` (brickston-backend) and `AI_CONTROL_SECRET` (its scheduler secret) set, models come from `GET /api/v1/ai/config?router=brick`, which is `ai.routes` edited on the AI Console Models page. The table is cached for 60 s. Lookup order:
  1. an explicit `model`
  2. `AI_ROUTE_<TASK>`
  3. the task override in the table
  4. the tier default in the table
  5. `MODEL_TIERS`

  A route with no OCP leg skips OCP. A route with no paid leg (Deep) never falls back to the API.
- **Run log.** Every call is posted to `POST /api/v1/ai/runs`, so it lands in `ai.runs` and the Models page spend view. The post is awaited with a 2 s cap and never fails a call. `onRun(hook)` and `flushRuns()` are exported as well.
- **Budget guard.** The daily paid cap applies to table routes:
  - Past 80%, the standard tier's paid model steps down to the fast tier's.
  - At the cap, paid legs are skipped.
- `"standard"` is accepted as a tier, the same as `"balanced"`.
- Python twin `brick_llm.py`: the same task, table, override, budget and run-log behavior (`resolve_route`, `refresh_routes`, `flush_runs`, `ChatArgs.task`).

### Changed
- On the Anthropic leg, `claude-sonnet-5-5` is sent with `thinking: {type: "between_tools"}` and without sampling settings. It thinks by default, and the thinking spent `max_tokens`, which truncated answers. Haiku 4.x is unchanged. Opus 5.x, Fable 5 and Haiku 5.x get low effort plus 4,096 tokens of headroom.

## 0.8.0 (2026-10-12)

Additive. Existing exports and the text API are unchanged; safe to bump from 0.7.0.

### Added
- `chatStream(args)`: one model turn as an async iterator of `start`, `text`, `tool_call_start`, `tool_call` and `done` events. Fails over to the next leg only before the first event.
- `chatTools(args)`: the same turn buffered, returning `{ text, toolCalls, finishReason, usage, raw, provider, model }`. Fails over on any error, mid-response included.
- OpenAI-format function tools in (`ToolDefinition`), normalized `ToolCall { id, name, arguments }` out. Conversation messages carry `assistant.toolCalls` and `{ role: "tool", toolCallId, content, isError? }` results.
- Provider chain unchanged: OCP, ocp-fallback, Anthropic (tools and tool results translated to Anthropic blocks, prompt-cache breakpoints on system parts, last tool and last message), then Workers AI for text-only turns only.
- `system` may be an array of parts with `cache_control`, so a caller keeps a cached stable block and a volatile tail on the Anthropic leg.
- `effort` (OCP `reasoning_effort`, Anthropic `output_config.effort`), `anthropic` extra fields for the Anthropic leg only (e.g. `thinking`), and `signal` (abort never fails over).
- `toolsFromAnthropic()` converts Anthropic `input_schema` tools.
- `llm.call` lines from the new API carry `mode` (`stream` or `tools`) and `toolCalls`.
- 10 new black-box tests (`test/tools.test.mjs`).

### Not in the Python twin
`brick_llm.py` gets no tools or streaming API in this release; no Python consumer calls tools.

### Consumers to bump
brick.sticks (moves Kit chat, voice and the task sweep onto `chatStream` / `chatTools`). Others only if they adopt the new API.

## 0.7.0 (2026-10-11)

Exported API unchanged. Model defaults change; provider order does not.

### Changed
- `balanced` and `deep` tiers now default to `claude-sonnet-5-5` (was `claude-sonnet-4-6`). `DEFAULT_LLM_MODEL` follows `balanced`, so untiered calls move too. `fast` stays `claude-haiku-4-5`, because OCP does not serve a 5.5 Haiku. Same change in `brick_llm.py`.
- `LLM_MODEL_FAST`, `LLM_MODEL_BALANCED`, `LLM_MODEL_DEEP` and `EXTRACTION_MODEL` still override per deployment.

### Consumers to bump
brick.intel, brick.command (apps/web, apps/collect, apps/leasing), lfiq.registry, brick.keystone, and brick.sticks and lfiq.pursue once they adopt the router.

## 0.6.0 (2026-10-11)

Additive. Safe to bump from 0.5.0; nothing changes until an app registers a runner.

### Added
- Workers AI backstop leg. A Worker calls `setWorkersAiRunner(workersAiRunnerFromBinding(env.AI))` once, and any call that fails on every other leg (Anthropic out of credit, revoked key, outage, no paid provider configured) is answered by Cloudflare Workers AI through that Worker's own `AI` binding. No key and no dependency on another app. Model: `WORKERS_AI_MODEL`, default `@cf/zai-org/glm-5.2`. `provider` reports `"workers-ai"` and the `llm.call` line logs the leg.
- If the backstop also fails, the paid leg's error is rethrown, since that is the one to act on.

## 0.5.0 (2026-10-03)

Exported API unchanged. Safe to bump from any 0.3.x or 0.4.0 pin.

### Fixed
- A hung OCP no longer stalls a call for up to ~30 minutes. The OCP and ocp-fallback clients now time out after 180 seconds with 1 SDK retry (`LLM_OCP_TIMEOUT_MS`, `LLM_OCP_MAX_RETRIES`).
- `chatWithRetry()` / `chatDetailedWithRetry()` now retry SDK connection errors and timeouts, which carry no HTTP status.
- The `llm.call` log line no longer carries raw error text. Configured key values and token-shaped strings are redacted and the field is capped at 300 characters. Errors thrown to callers are unchanged.
- The log line falls back to `console.log` on runtimes without a usable `process.stdout`.
- `brick_llm.py` now sends the User-Agent and Cloudflare Access headers OCP requires, and has the same timeouts, retry classification and redaction.

### Added
- `LLM_ANTHROPIC_TIMEOUT_MS` / `LLM_ANTHROPIC_MAX_RETRIES` and `LLM_OCP_FALLBACK_TIMEOUT_MS` / `LLM_OCP_FALLBACK_MAX_RETRIES` optional overrides.
- `llm.call` `err` names the network cause of a connection failure (for example `ECONNREFUSED`, `ENOTFOUND`).
- Tests prove an unreachable ocp-fallback fails in under a second, trips its own breaker, and that OCP plus fallback down with no Anthropic key throws rather than hangs.
- `npm test`: 16 black-box router tests against a local mock of all three legs, run in CI.
- `CLAUDE.md`, SessionStart hook, lfdev adopt documents.

## 0.4.0 (2026-09-22)
- Ship compiled JavaScript in `dist/`; consumers no longer need `transpilePackages`.

## 0.3.0 (2026-08-24)
- Prompt-cache counters (`cacheWrite` / `cacheRead`) in `llm.call` and `ChatUsage`.

## 0.2.0 (2026-06-11)
- ocp-fallback leg between OCP and direct Anthropic.
