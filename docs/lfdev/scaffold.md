# Scaffold check: canonical-llm

As built, 2026-10-03.

- [x] CI gate on pull requests: `.github/workflows/ci.yml` runs typecheck, dist check, Python tests on PR to `main`.
- [ ] TypeScript tests: none. Failover, timeout and logging behavior of `llm.ts` is untested.
- [x] Environment manifest: README "Env contract" names every variable.
- [ ] Environment check script: not applicable to a library; consumers own their env.
- [n/a] Migrations tooling: no database.
- [ ] Agent guardrails: no `CLAUDE.md`.
- [ ] Claude Code SessionStart hook: none.
- [x] README sections: purpose, distribution, API, consumers, env contract.
- [ ] Branch protection on `main`: not set (GitHub API returns 404). Repo settings are owner-only.
- [ ] CHANGELOG: none.
