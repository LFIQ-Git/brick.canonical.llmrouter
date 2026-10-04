# Spec: canonical-llm

As built, 2026-10-03 (commit e257290).

## Architecture

- `llm.ts` (TypeScript, ESM) compiled by `tsc -p tsconfig.build.json` into `dist/llm.js` and `dist/llm.d.ts`, which are committed. `package.json` `main`/`types`/`exports` point at `dist/`.
- `openai` and `@anthropic-ai/sdk` are optional peer dependencies, imported at module top level in `llm.ts`.
- `brick_llm.py` is the Python twin. It imports the SDKs lazily and has OCP and Anthropic legs only (no ocp-fallback).
- No database, no routes, no scheduled jobs, no UI.

## Exported API (TypeScript)

Types `Provider`, `ModelTier`, `ChatMessage`, `ChatArgs`, `ChatUsage`, `ChatResult`. Values `MODEL_TIERS`, `DEFAULT_LLM_MODEL`, `getProvider`, `chat`, `chatDetailed`, `chatWithRetry`, `chatDetailedWithRetry`, `withTimeout`. Consumers pin by SHA, so this surface must stay backwards-compatible.

## Integrations

| Leg | Client | Auth (env names only) | Failure handling as built |
|---|---|---|---|
| ocp | OpenAI SDK, `OCP_BASE_URL` | `OCP_API_KEY`, `OCP_CF_ACCESS_CLIENT_ID`, `OCP_CF_ACCESS_CLIENT_SECRET`; custom User-Agent | Any error notes the breaker and falls through if another leg exists. SDK defaults apply: 10 minute timeout, 2 internal retries. |
| ocp-fallback | OpenAI SDK, `OCP_FALLBACK_BASE_URL` | `OCP_FALLBACK_API_KEY`; `X-App-Name` from `LLM_APP_NAME` | Same as above, own breaker. SDK defaults apply. |
| anthropic | Anthropic SDK | `ANTHROPIC_API_KEY` | Error is logged and thrown. SDK defaults apply. |

Circuit breaker: 3 consecutive failures open a leg for 60 seconds, then the counter resets.

Retry: `chatDetailedWithRetry` makes up to 3 attempts on status 429, 5xx, or a connection error code, backing off 500 ms and 1500 ms.

## Observability

One `llm.call {json}` line per leg attempt on `process.stdout`, with provider, model, tier, latency, ok, failedOver, err (the raw error message), and cache counters.

## Environments and secrets

Read from `process.env` / `os.environ` at call time, except `MODEL_TIERS` and `DEFAULT_LLM_MODEL`, which are read at import time in TypeScript. Secret names: `OCP_API_KEY`, `OCP_CF_ACCESS_CLIENT_SECRET`, `OCP_FALLBACK_API_KEY`, `ANTHROPIC_API_KEY`.

## Checks

`npm run typecheck`, `npm run check:dist` (rebuild and diff `dist/`), `python3 test_brick_llm.py` (23 pure-function tests). CI runs all three on push and PR to `main` (`.github/workflows/ci.yml`). There are no TypeScript tests.
