# Checker evolution acceptance (0.3.0)

**Status: passed** — the deterministic checker executed the delivery criteria,
the independent verifier approved, and the objective completed on 2026-11-08.

## What was exercised

Isolated headless composition (`DSH_HOME=/tmp/dsh-checker-accept`, profile
`headless` + `dsh-base`, the three local bundles, an explicit
`agent-preset-registry`, and the forge model endpoint), with the task delivered
as a top-level `user/message`:

- objective `obj-5ba269e73bf6404aba09` with two mechanical criteria:
  - `c1` command: `test -s docs/checker.md && grep -q 'Ringer' docs/checker.md`
  - `c2` artifact: `docs/checker.md`, at least 2 KiB
- one work order dispatched to a preset `architect` worker; the worker reported;
  the owner accepted it;
- `objective_verify` executed both checks **in the engine** (verification
  `ver-d7fd99a219794cddb2f0`, `checker.mode: "engine"`, `executed: 2`) before
  starting the verifier child;
- verifier child (preset `verifier`, distinct from the producer) confirmed the
  pinned commit `539bc97`, a clean workspace, and approved with full coverage;
- objective state **completed**, completion record names the verification; no
  `mechanical-check-failed` was returned.

Recorded check evidence:

| Criterion | Execution | Result |
|---|---|---|
| `c1` command | engine, cwd repo | exit **0**, 18 ms, passed |
| `c2` artifact | engine, stat + sha256 | exists, **8,898 bytes**, sha256 `13b9dbee…695c`, passed |

The run also produced one transient `engine/overloaded` event during the
verifier wait and an `engine/recovered` event after completion; final load was
idle (`backpressure: false`, no children).

## Defects caught and fixed during this evolution

The audit before merge found three issues in the first checker implementation,
all fixed and covered by regressions:

1. **Checks ran before the verification gate.** A non-owner could call
   `objective_verify` and make the engine execute criterion commands; a request
   with no accepted work order also executed checks before returning `not-ready`.
   `prepareVerification` now validates authority, revision, readiness, budget,
   commit pin, and a clean workspace **before** any check runs.
2. **Duplicate criterion ids could fake full coverage.**
   `criterionIds:["c1","c1"]` was treated as a non-advisory request and could
   complete a two-criterion objective after checking only `c1`. Ids are deduped,
   advisory is decided by set size, and approval requires the verification's
   criteria set to equal every objective criterion id.
3. **Dirty pinned workspaces were checked anyway.** Verification now refuses a
   dirty pinned workspace with `dirty-workspace` before executing checks, so
   executed evidence always corresponds to the pinned commit.

The audit also noted that a request-level check run is not a verdict-time
re-pin; the verifier is required to report the final commit and clean workspace,
and approval downgrades to inconclusive on a mismatch, which the run exercised
on an earlier dirty attempt.

## What this does not replace

Executed checks catch a missing or broken delivery, not a subtle semantic
wrongness. The independent verifier approval remains mandatory, as does human
acknowledgment for judgment criteria — the Ringer doctrine, kept intact.
