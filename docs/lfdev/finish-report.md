# Finish report: canonical-llm

| # | Step | Status | Fixed | Left (with reason) | Needs a decision | Gates after |
|---|---|---|---|---|---|---|
| 0 | lfdev-audit | skipped | | The same-day adopt gap list (`adopt-gaps.md`, 15 findings) served as the audit. | | green |
| 1 | lfdev-clean | done (short) | 0 | `tsc --noUnusedLocals --noUnusedParameters` clean; no dead code found; no lint config exists for a single-file library. | | green |
| 2 | lfdev-test | done | 16 TS tests added, 5 Python tests added | | | 16/16, 28/28 |
| 3 | lfdev-harden | done | Log redaction, bounded OCP timeouts, SDK-timeout retry; `npm audit` 0 vulnerabilities; git history scanned for keys, none found; `npm pack` ships only README, dist, llm.ts, package.json. | Branch protection is a repo setting, out of scope for this run. | Should 4xx caller errors skip failover? | green |
| 4 | lfdev-perf | skipped | | No hot path beyond one HTTP call per leg; timeouts handled in harden. | | |
| 5 | lfdev-polish | skipped | | No UI. | | |
| 6 | lfdev-copy | done (short) | pyproject description corrected | Error messages are developer-facing and already plain. | | |
| 7 | lfdev-docs | done | README: new env vars, tests section, brick.registry consumer; CLAUDE.md; CHANGELOG.md | | | |
| 8 | lfdev-release | prepared, not deployed | 0.4.0 to 0.5.0, CHANGELOG, `release-0.5.0.md` | Consumer pin bumps are owner work. | | |

## Final verification

Recorded from a clean `npm ci` in the worktree; see "Final report".

## Final report
**canonical-llm, version 0.5.0, 2026-10-03.**
canonical-llm is the shared model router every BRICK app uses to reach Claude, trying the free OCP proxy first and failing over to the paid legs. It is a library consumed by six package pins across four repos.

**State.** All 16 router tests, 28 Python twin tests, the type check and the dist build check pass from a clean install. Prepared for release; not yet deployed (consumers bump their pins).

**What this round improved.**
- A hung OCP now fails over in about 6 minutes at worst instead of about 30.
- Error text in logs can no longer carry API keys or Cloudflare Access secrets, and is capped at 300 characters.
- Network timeouts are now retried by `chatWithRetry`, which previously gave up on them.
- The Python twin can now reach OCP through Cloudflare Access.
- The router went from 0 to 16 automated tests covering every failover path, now enforced in CI.

**Risks and open decisions.** The ocp-fallback leg is not deployed (no DNS record, no Vercel project); calls skip it in under a second, and the owner should redeploy it or unset it in consumers. The 180-second OCP timeout may cut off very long `deep` generations; the owner can raise it per app. Branch protection on `main` is off (owner). The Python twin still lacks the ocp-fallback leg (owner). Whether caller errors such as 400 should fail over to paid legs is undecided (owner).

**How it is run.** No runtime of its own. Rollback: revert the consumer's SHA pin. Monitoring: `llm.call` lines in each consumer's logs.

Next: /lfdev-ship
