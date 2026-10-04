# Adopt gaps: canonical-llm

Written 2026-10-03 against commit e257290. Unattended fleet run: Risk, Broken promise and in-repo guardrail items were approved by the fleet brief's default; everything else is deferred to the owner.

## Risk

1. **Error text logged verbatim.** `llm.ts` `runChat` and `brick_llm.py` `_run_chat` put `e.message` / `str(e)` into the `llm.call` line unbounded. Provider and proxy error bodies can echo request headers or keys, and a Cloudflare Access login page arrives as a full HTML body. Fix: redact configured secret values and token-shaped strings, collapse whitespace and cap the length. **Approved.**
2. **A hung OCP blocks failover for up to 30 minutes.** The OCP and ocp-fallback clients use SDK defaults (10 minute timeout, 2 internal retries), so a wedged Win-PC holds the call for up to three 10-minute attempts before the chain moves on. Fix: per-leg timeout and retry settings on the OCP legs with env overrides, defaults short enough to fail over promptly. **Approved.**

## Broken promise

3. **SDK timeouts are not retried.** README promises transient-error retry, but `isTransientLLMError` only checks `status` and `code`. SDK connection errors and timeouts (`APIConnectionError`, `APIConnectionTimeoutError`) carry neither, so `chatWithRetry` gives up on them. Same in `brick_llm.py`. Fix: classify those SDK error classes as transient. **Approved.**
4. **Python twin cannot reach OCP behind Cloudflare Access.** `brick_llm.py` claims an env contract identical to `llm.ts`, but `_get_openai` sends neither the `CF-Access-Client-Id/Secret` headers nor the non-OpenAI User-Agent that `llm.ts` sends, so ocp.lfiq.app redirects or 403s Python calls. Fix: send the same headers. **Approved.**
5. **Log line is lost on runtimes without `process.stdout`.** `logCall` writes to `process.stdout`; on Cloudflare Workers without `nodejs_compat` this throws and the try/catch drops the line, so observability silently disappears. Fix: fall back to `console.log`. **Approved.**

## Missing guardrail

6. **No TypeScript tests.** Failover order, breaker, retry, timeout and log redaction in `llm.ts` have no test. Fix: `node:test` suite against a local mock HTTP server for both SDKs, run in CI. **Approved.**
7. **No `CLAUDE.md`.** Fix: add one with the release flow, the public-repo rule and the backwards-compatibility rule. **Approved.**
8. **No SessionStart hook.** Fix: `.claude/settings.json` hook that runs `npm ci` when `node_modules` is missing. **Approved.**
9. **No CHANGELOG.** Fix: add `CHANGELOG.md` at release. **Approved.**
10. **Branch protection on `main` is off.** Repo settings are hands-off in this run. **Deferred.**

## Improvement

11. Python twin has no ocp-fallback leg (documented in README). **Deferred.**
12. `pyproject.toml` version (0.1.0) and description ("OCP→Anthropic→Ollama→rules") are stale. Description fix is approved as part of docs; version alignment deferred.
13. Breaker half-open lets three probes through instead of one. Behavior change across both twins; **deferred**.
14. `openai` and `@anthropic-ai/sdk` are optional peers but imported at top level, so a consumer missing one fails at import. Making the imports lazy changes module shape; **deferred**.
15. A 400 from OCP (caller error) trips the breaker and fails over to the paid legs. Needs an owner call on which statuses should fail over. **Deferred.**

## Deferred to owner

- ocp-fallback is not deployed (`ocp-fallback.lfiq.app` has no DNS record and no Vercel project): redeploy it, or point the router at the Anthropic API directly by unsetting `OCP_FALLBACK_BASE_URL` / `OCP_FALLBACK_API_KEY` in consumers. The router now fails past it in under a second.

- Turn on branch protection for `main` (repo settings).
- Add the ocp-fallback leg to `brick_llm.py`.
- Decide whether 4xx caller errors should skip failover and the breaker.
- Decide whether to make SDK imports lazy so a consumer can omit one optional peer.
- Bump consumer SHA pins after this release merges.
