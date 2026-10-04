# DONE contract: canonical-llm adopt fixes

Each check must pass before the build is done.

1. Redaction: a `node:test` case makes OCP fail with an error body containing the configured `OCP_API_KEY` value and an `sk-ant-` token; the captured `llm.call` line contains neither, and `err` is at most 300 characters. Proof: `npm test`.
2. Python redaction: `test_brick_llm.py` asserts `_redact_err` removes configured secret values and token-shaped strings and caps length. Proof: `python3 test_brick_llm.py`.
3. OCP timeout: a `node:test` case with a hanging OCP and `LLM_OCP_TIMEOUT_MS=300` fails over to Anthropic in under 5 seconds. Proof: `npm test`.
4. Transient classification: `node:test` and Python tests show SDK connection and timeout errors are retried. Proof: `npm test`, `python3 test_brick_llm.py`.
5. Failover chain: `node:test` cases cover OCP ok; OCP fail to ocp-fallback; both fail to Anthropic; forced `LLM_PROVIDER=anthropic`; breaker opens after 3 failures. Proof: `npm test`.
6. Python CF Access headers: a test asserts `_ocp_default_headers()` includes the User-Agent and both CF Access headers when set. Proof: `python3 test_brick_llm.py`.
7. Log fallback: `logCall` uses `console.log` when `process.stdout.write` is unavailable (code read plus test). Proof: `npm test`.
8. API compatibility: every name exported from `dist/llm.d.ts` at e257290 is still exported with a compatible signature. Proof: diff of export lists.
9. CI runs `npm test`. Proof: `.github/workflows/ci.yml` and a green PR run.
10. `CLAUDE.md`, `.claude/settings.json` SessionStart hook exist. Proof: files present.
11. `npm run typecheck` and `npm run check:dist` pass. Proof: commands.
