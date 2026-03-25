---
name: bug-diagnostics
description: Diagnostic workflow for software bugs using the scientific method and red-first tests. Use when investigating incorrect behavior, regressions, or unexplained outputs; when the user wants ranked hypotheses before coding; when they require a failing test before any fix; or when debugging incrementally with evidence from the codebase and tests.
---

# Bug diagnostics

## When this skill applies

Follow this workflow whenever diagnosis matters more than a quick guess: production bugs, library behavior mismatches, flaky tests, or “works in UI but not in totals” style issues.

## Scientific method (mandatory shape)

1. **Observe** — State the symptom in precise, testable terms (inputs, expected vs actual, scope).
2. **Hypothesize** — Propose multiple plausible causes (at least three when the problem allows). Rank them by likelihood with one-line justification each.
3. **Design experiments** — For top hypotheses, define low-cost checks: what to read, run, or add. Prefer experiments that can **falsify** a hypothesis.
4. **Run** — Execute in order: read relevant code paths first, then minimal repro or automated check.
5. **Conclude** — Discard or refine hypotheses from evidence; avoid confirming only the first idea.

Prefer hypotheses grounded in **actual code** (read implementations, search for call sites) over generic API guesses.

## Red-only workflow (mandatory for fixes)

- **Before** changing production code to fix a bug, add or adjust an **automated failing test** that reproduces the bug (same project test runner and conventions).
- **Stop** after the test fails for the right reason (assertion message matches the defect). Do not implement the fix in the same step unless the user explicitly asks to combine steps.
- **Then** implement the smallest change that makes the test pass and run the relevant suite.

If a test cannot be written yet, say why and use the smallest alternative repro (script, logged snippet) with a clear path to a test later.

## Experiments to prefer

- Read the implementation of the suspected code path; cite file paths when reporting.
- Grep or search for related patterns (`getTypeDescriptor`, event handlers, aggregates).
- One minimal pipeline or unit test that isolates the failure.
- Avoid new modes, flags, or alternate APIs unless the user requests them.

## What to avoid

- Fixing without a falsifiable check (test or repro).
- Single-hypothesis tunnel vision.
- Large refactors mixed with diagnosis.
- “Probably X” without reading the code or running an experiment.

## Relation to other rules

If the workspace or user has a rule for structured hypothesis listing (e.g. `/do-science`), align the **same** ranked-hypothesis and experiment format; this skill adds the **red-first test** requirement for code changes.
