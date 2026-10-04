# Build: canonical-llm adopt fixes
Started: 2026-10-03  |  Status: COMPLETE

## Objective
Close the Risk, Broken-promise and guardrail gaps in `docs/lfdev/adopt-gaps.md` without changing the exported API: secret-safe error logging, prompt failover from a hung OCP, retry of SDK timeouts, CF Access headers in the Python twin, a log fallback, and a TypeScript test suite in CI.

## DONE means
- [x] Redaction (TS): `npm test` "llm.call err never contains secrets" passes.
- [x] Redaction (Py): `python3 test_brick_llm.py` `test_redact_err_removes_secrets_and_caps_length` passes.
- [x] OCP timeout: `npm test` "a hung OCP times out and fails over promptly" passes (~0.3 s with `LLM_OCP_TIMEOUT_MS=300`).
- [x] Transient classification: `npm test` "chatWithRetry retries an SDK timeout" and Python `test_transient_sdk_connection_errors` pass.
- [x] Failover chain and breaker: 6 `npm test` cases pass.
- [x] Python CF Access headers: `test_ocp_default_headers` passes.
- [x] Log fallback: `npm test` "logging falls back to console.log" passes.
- [x] API compatibility: export list of `dist/llm.d.ts` identical to e257290 (`diff` empty); `dist/llm.d.ts` byte-identical.
- [x] CI runs `npm test` (`.github/workflows/ci.yml`).
- [x] `CLAUDE.md` and `.claude/settings.json` SessionStart hook exist.
- [x] `npm run typecheck` and `npm run check:dist` pass.

## Explicitly NOT in scope
- Python ocp-fallback leg, breaker half-open change, lazy SDK imports, 4xx failover policy, branch protection. See "Deferred to owner" in `docs/lfdev/adopt-gaps.md`.

## Decision log
| # | Decision | Reasoning | Reversible? |
|---|----------|-----------|-------------|
| 1 | OCP and ocp-fallback clients default to 180 s timeout and 1 SDK retry (`LLM_OCP_TIMEOUT_MS`, `LLM_OCP_MAX_RETRIES`). | Worst case for a hung Win-PC drops from ~30 min to ~6 min while still allowing an 8192-token non-streaming answer. | Yes, env or one constant. |
| 2 | Anthropic leg keeps SDK defaults; `LLM_ANTHROPIC_TIMEOUT_MS` / `LLM_ANTHROPIC_MAX_RETRIES` only apply when set. | It is the last leg; an explicit timeout would also bypass the SDK's long-request guard. | Yes. |
| 3 | Tests run black-box against `dist/` with a local HTTP mock for all three legs. | Exercises the real SDKs and the shipped JS with no exports added for testing. | Yes. |
| 4 | Error text in logs is redacted and capped at 300 characters; thrown errors are unchanged. | Callers still get full errors; only the log line is sanitized. | Yes. |

## Blockers
_(empty)_

## Session log
### 2026-10-03
- Wrote 13 `node:test` cases; 3 failed and 1 crashed the runner against e257290 dist (breaker counted SDK-internal retries, hang and SDK-timeout cases timed out at 60 s).
- Implemented per-leg client options, `redactErr`, SDK connection-error classification and console.log fallback in `llm.ts`; same in `brick_llm.py` plus CF Access headers and User-Agent.
- Gates: `npm test` 13/13, `python3 test_brick_llm.py` 27/27, typecheck clean, exports identical.
