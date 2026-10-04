# canonical-llm

`@lfiq/canonical-llm`: the Layer-0 LLM router every BRICK app installs as a git dependency pinned to a commit SHA. `brick_llm.py` is its Python twin. README.md has the full contract.

## Rules

- **This repo is public.** Never commit keys, tokens, hostnames of private services beyond what README already names, customer data, or real log output. Tests use a local mock server and fake keys only.
- **Consumers pin by SHA, so the exported API is a contract.** Never remove or rename an export, never narrow a type, never change a default that changes which provider answers. Additive changes only; anything breaking needs a major version and the owner's sign-off.
- **Source and `dist/` ship together.** Edit `llm.ts`, run `npm run build`, commit both. CI fails on a stale `dist/`.
- **Change both twins.** A behavior change in `llm.ts` gets the same change in `brick_llm.py` (the Python twin still lacks the ocp-fallback leg).
- **Nothing secret in logs.** Every error that reaches an `llm.call` line goes through `redactErr` / `_redact_err`.
- Do not bump consumer pins from here. Release notes list the repos to bump; the owner does it.

## Commands

| Check | Command |
|---|---|
| Typecheck | `npm run typecheck` |
| Router tests | `npm test` (runs against `dist/`, build first) |
| dist is current | `npm run check:dist` |
| Python twin | `python3 test_brick_llm.py` |

## Lifecycle docs

`docs/lfdev/` holds the as-built brief, spec, gap list and baseline. `BUILD.md` is the build ledger.
