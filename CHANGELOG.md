# Changelog

All notable changes to `@lfiq/canonical-llm`. Consumers pin by commit SHA; bump the pin to pick up a release.

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
