# Brief: canonical-llm

As built, 2026-10-03 (commit e257290).

## What it is

`@lfiq/canonical-llm` is the Layer-0 LLM router for the BRICK app family. Each BRICK app installs it as a git dependency pinned to a commit SHA and re-exports it from a one-line `lib/llm.ts` shim (README.md, "Consumers"). `brick_llm.py` is a Python port for the family's Python jobs.

## Users

- BRICK app code (brick.intel, brick.keystone, brick.command workspaces) that needs a model call. The callers are other programs, not people.
- The owner, who changes model routing in one place and bumps the SHA pin in each consumer.

## Core purpose

Send a chat request to the cheapest working Claude endpoint and fail over automatically: OCP at ocp.lfiq.app (subscription, $0 per call), then the paid hosted ocp-fallback proxy, then the Anthropic API directly (llm.ts `runChat`).

## Critical journeys

1. An app calls `chat()` / `chatDetailed()` with a tier; OCP answers; one `llm.call` log line is written.
2. OCP is down or hung; the call moves to ocp-fallback, then to Anthropic; the caller still gets text and the `provider` that answered.
3. A transient error (429, 5xx, connection reset) on the last leg is retried by `chatWithRetry()` with backoff.
4. The owner changes `llm.ts`, runs `npm run build`, commits source and `dist/` together, and bumps consumer pins.

## Not in scope

Streaming, tool use, images, and the CI import guard (its master copy lives in the vault, per README).
