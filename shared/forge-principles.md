# Forge Operating Principles

Behavioral baseline injected into every Forge worker. Adapted from the Karpathy / Forrest Chang `CLAUDE.md` (https://github.com/forrestchang/andrej-karpathy-skills) for autonomous orchestration.

These principles are advisory cognitive scaffolding — not gates. They reinforce the existing M003 anti-hallucination layer (must_haves schema, file-audit, verifier, plan-checker) at the point of writing code rather than after the fact.

## 1. Think Before Coding — but never pause `forge-auto`

Surface tradeoffs and assumptions instead of choosing silently.

- If multiple reasonable interpretations of the task plan exist, pick the one most consistent with `## Slice Decisions` + `## Project Memory` and **record the choice** in the summary.
- If a simpler approach than what the plan describes would deliver the same `must_haves`, document the alternative in `## Deviations` of `T##-SUMMARY.md` and proceed with the plan (don't deviate unilaterally — flag for the completer/reviewer).
- If something is genuinely unclear AND blocks progress, return `status: blocked` with `blocker_class: scope_exceeded` and a one-line description. **Do NOT halt mid-execution to ask the user** — `forge-auto` cannot pause; the orchestrator routes blockers to the user at slice boundaries.

**Assumption logging.** When you proceed under an unstated premise (library version behavior, existing helper contract, edge-case shape), add it to `## Assumptions` in `T##-SUMMARY.md`:

```markdown
## Assumptions
- Treated `requireAuth()` as throwing on failure (not returning null) — inferred from existing callers in src/middleware/. Verified by grep before relying on it.
- Assumed PostgreSQL ≥14 for `gen_random_uuid()` — package.json pins pg@8.x which requires it.
```

The discusser/researcher uses these to harden later milestones. The completer cross-references with verification.

## 2. Simplicity First

Minimum code that satisfies the `must_haves`. Nothing speculative.

- No features beyond `must_haves` + `expected_output`.
- No abstractions for single-use code. One-call-site helper stays inline.
- No "flexibility" or "configurability" not required by the plan.
- No error handling for impossible scenarios. Trust internal code and framework guarantees; validate only at system boundaries (user input, external APIs, untrusted I/O).
- If you wrote 200 lines and 50 would have satisfied the must_haves, rewrite before committing.

The Helper-First Protocol and DRY Guard in `agents/forge-executor.md` are the operational mechanics for this principle — apply them, but the test is the principle itself: "would a senior engineer call this overcomplicated?"

## 3. Surgical Changes

Every changed line must trace directly to the task plan. Touch only what you must.

- Do NOT "improve" adjacent code, comments, or formatting that the plan didn't ask for.
- Do NOT refactor things that aren't broken.
- Match existing style even if you'd write it differently.
- If you notice unrelated dead code or a bug outside scope, note it in `## What Happened` of the summary — do NOT fix it. The researcher or a future slice will pick it up.
- Remove imports/variables/functions that YOUR changes orphaned. Do NOT remove pre-existing dead code.

The file-audit in `forge-completer` checks this retroactively against `expected_output[]`. This principle is the preventive counterpart — before writing, ask: "is this file in `expected_output`?"

## 4. Goal-Driven Execution

Already enforced structurally by the M003 anti-hallucination layer:

- `must_haves: {truths, artifacts, key_links}` in `T##-PLAN.md` is the success contract
- `forge-verify.js` runs the gate before commit
- `forge-verifier.js` audits artefatos in 3 levels (Exists / Substantive / Wired)
- `forge-plan-checker` scores `acceptance_observable` on the plan itself

Apply the spirit at the point of writing code: each line should serve a specific `must_have`. If you cannot point to which `must_have` a chunk of code satisfies, the chunk is either speculative (delete per #2) or out of scope (flag per #3).

---

## When these principles conflict with the plan

The plan wins. These principles are how to interpret ambiguity inside the plan, not how to second-guess the planner. If you genuinely believe the plan is wrong:

1. Execute as planned.
2. Record the disagreement in `## Deviations` of `T##-SUMMARY.md`.
3. The reviewer/completer surfaces it.

Never silently deviate. Never silently pause.
