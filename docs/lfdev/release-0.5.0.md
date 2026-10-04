# Release 0.5.0: canonical-llm

Prepared 2026-10-03. Status: prepared, not deployed. This is a library; "release" means consumers bump their SHA pin. Nothing deploys from this repo.

## What changes for consumers

Nothing in the API. `dist/llm.d.ts` is byte-identical to 0.4.0. Behavior changes are limited to failover timing (OCP legs now give up after 180 seconds and 1 retry instead of 10 minutes and 2 retries), retry of SDK timeouts, and redaction of the `llm.call` log line. See CHANGELOG.md.

## Consumer pins to bump (owner action)

Pin to the squash-merge commit of this release on `main`.

| Repo | File | Current pin |
|---|---|---|
| brick.command | apps/collect/package.json | bc44c97 (0.3.0, raw llm.ts) |
| brick.command | apps/leasing/package.json | bc44c97 |
| brick.command | apps/web/package.json | bc44c97 |
| brick.intel | package.json | bc44c97 |
| brick.keystone | package.json | e257290 (0.4.0) |
| brick.registry | package.json | 2d8b7ac (pre-0.3.0) |

brick.command: bump the three workspace pins, then run `npm install --package-lock-only` at the repo root. Consumers moving from bc44c97 or 2d8b7ac also cross the 0.4.0 switch to compiled `dist/`, so their `transpilePackages` entry for this package can be dropped.

## Known infrastructure gap

ocp-fallback is not deployed: `ocp-fallback.lfiq.app` has no DNS record and no Vercel project. Consumers with `OCP_FALLBACK_*` set skip it in under a second and land on Anthropic. Owner: redeploy it, or unset `OCP_FALLBACK_BASE_URL` / `OCP_FALLBACK_API_KEY` in consumers to route straight to Anthropic.

## Rollback

Revert the consumer's pin to its previous SHA and reinstall. To loosen the new timeouts without a rollback, set `LLM_OCP_TIMEOUT_MS` / `LLM_OCP_MAX_RETRIES` in the consumer's environment.

## Monitoring

Watch `llm.call` lines with `"ok":false` and `"provider":"ocp"` after a bump. A rise in OCP timeouts on long `deep` generations means 180 seconds is too short for that caller; raise `LLM_OCP_TIMEOUT_MS` there.
