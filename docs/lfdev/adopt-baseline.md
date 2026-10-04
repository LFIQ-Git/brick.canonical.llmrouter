# Adopt baseline: canonical-llm

- Date: 2026-10-03
- Commit: e257290e8af77d3774a2a7b11193dde85550bb8f (main)
- Checks at baseline: `npm run typecheck` pass; `npm run check:dist` pass; `python3 test_brick_llm.py` 23/23 pass; CI on main green.
- Finish items already met: CI on PRs, committed dist with staleness check, README env contract, no secrets in git history (pattern scan of all commits).
- Finish items not met at baseline: TypeScript tests, CLAUDE.md, SessionStart hook, CHANGELOG, branch protection.
- Deferred: see "Deferred to owner" in `adopt-gaps.md`.
