# The checker: making delivery meet expectations

This page records the delivery-verification (checker) design, including what we
adopted from an external project, [Ringer](https://github.com/NateBJones-Projects/ringer)
(analysed 2026-11-08), and what we deliberately did not adopt.

The goal is narrow: **an agent's "done" is not evidence.** Completion should be
decided by executing the expectations against the delivered workspace, and a
second, independent reviewer should judge what execution cannot prove.

## What Ringer does

Ringer is a parallel worker-swarm runner. Each task in its manifest carries:

- a `spec` (the prompt),
- a `check` (any shell command; **exit 0 is the only thing Ringer believes**),
- `expect_files` (must exist and be non-empty before the check runs),
- optional `max_attempts` (default 2: one try plus one retry with the check's
  failure output injected into the prompt).

It executes the check itself, captures output, retries once with the failure
context, logs every attempt to a local JSONL eval log (per model/task-type pass
rates), lints manifests for weak checks before spending tokens, and offers a
`--baseline` mode that runs every check against the unmodified tree so a broken
check is discovered before workers are paid for. Its README states the limits
plainly: executed checks catch laziness, not subtle wrongness, so an
orchestrator review stays mandatory even on a green check.

## What our checker did before this change

The objective engine pinned the commit, dispatched a **verifier child** with a
different preset, and the verifier ran the checks and reported evidence through
`objective_verdict`. The engine validated the verdict's shape: commit matches,
workspace clean, evidence covers every mechanical criterion, and the producer
cannot vote. That was already stronger than self-reporting, but the **execution
facts came from the verifier agent**: a lazy or dishonest verifier could claim
an exit code it did not observe. There was no check lint, no baseline, and
artifact checks were described but not executed deterministically.

## What we changed

1. **The engine executes command and artifact criteria itself** (`lib/checker.js`)
   before a verifier is started. Each check records its cwd, exit code, signal,
   timeout flag, duration, and bounded stdout/stderr excerpt. Artifact checks
   stat the file, enforce a minimum size, and verify an optional SHA-256.
2. **A failed executed check stops verification before any verifier run.** The
   `objective_verify` result is `code: "mechanical-check-failed"` with the exact
   failing criteria/output; the objective stays active; no verifier budget is
   consumed. This is the Ringer "check decides pass/fail" rule applied to the
   control plane.
3. **Approval still needs the independent verifier**, which now receives the
   engine's executed results in its brief. It must confirm the pinned commit and
   clean workspace, judge semantic correctness, and may re-run a check when the
   evidence looks weak. Completion requires both the executed checks passing
   and the verifier's approve (plus human ack for judgment criteria).
4. **Check lint is returned by `objective_create`** as non-blocking warnings and
   exposed through a new `objective_lint` tool: vacuous checks (`true`, `:`,
   echo-only), checks likely to fail silently (`diff -q`, quiet probes without a
   diagnostic), duplicate commands, evidence-only criteria, and a missing write
   scope.
5. **`objective_lint {execute: true}` provides the baseline.** It runs every
   mechanical criterion against the current workspace and returns the executed
   results without creating a verification or spending verifier budget. Assertions
   about new behavior should fail before the work; an assertion about unchanged
   behavior that fails baseline is a broken check, not work for a model.
6. **Command checks run before artifact assertions** in one verification, so a
   command can produce the deliverable an artifact criterion then checks (the
   Ringer ordering guarantee).
7. **Workers are told the delivery checks in their brief**, so expectations are
   part of the task rather than a surprise at verification. A rejected
   verification wakeup includes the engine's failing-check output as retry
   context.
8. **Artifact expectations gained `minBytes`** (default 1) in addition to
   `sha256`, so "the file exists" can be made as strict as the deliverable needs.

Configuration: `checkerExecute: false` falls back to verifier-executed evidence
for environments without a host subprocess service; `checkerTimeoutMs` (default
120 s), `checkerMaxTimeoutMs`, and `checkerMaxOutputBytes` bound execution.

## Comparison

| Concern | Ringer | Our checker before | Our checker now |
|---|---|---|---|
| Who executes the check | Ringer process, shell command | Verifier child agent claims the result | **Engine**, via `ctx.subprocess` (`bash -lc`), captured exit/output |
| What proves pass | Exit code | Verifier evidence matching the criterion shape | **Executed exit code / stat+hash**, plus verifier approve for semantics |
| Missing deliverable | `expect_files` non-empty | Verifier inspection | **Artifact stat/hash/minBytes** |
| Check quality before work | Lint rules + `--baseline` | None | **Creation warnings + `objective_lint` (optionally executes)** |
| Failed check and retry | Auto retry once with failure output | Verification reject/inconclusive; owner plans a new item | **Fail fast with output; owner plans retry; failure context in wakeup** |
| Independent review | Orchestrator patch review mandatory | Verifier child required | **Verifier child still required; checks cannot be overridden** |
| Attempt/eval telemetry | JSONL eval log, per-model scoreboard, routing tiers | Journal + status, no per-attempt eval rows | Journal includes executed checks; per-attempt eval log is Phase-2 work |
| Isolation | Per-task dirs/worktrees | `scope.paths` in one checkout | unchanged (Phase 2 worktrees) |
| Live visibility | Ringside dashboard | Sidebar Objectives panel + status | unchanged |

## Deliberately not adopted yet

- **Automatic retry loop with failure injection.** The engine never re-runs a
  worker by itself; the owner must plan a new work order, and the wakeup now
  carries the failing check output. A retry policy is a manager decision, and
  automatic retries consume budgets without a human-visible reason. Revisit in
  Phase 2 alongside the worktree/merge queue.
- **Per-attempt eval log and model scoreboard.** Ringer's `runs.jsonl`/`models`
  loop is excellent; our journal can feed the same idea, but the schema and
  model-routing decision belong with Phase-2 metrics, not a checker change.
- **A separate `expect_files` list.** Our artifact criteria serve the same role
  and are tied to the completion gate; a second redundant list would drift.
- **Agent hooks that nudge toward the tool.** Not applicable to the in-host
  engine; the equivalent is the orchestrator/objective-manager preset guidance.

## Trust and security notes

- Checks are re-executed and the tree re-pinned at **verdict** time; a delivery
  that changed or broke after the request cannot be approved. Approval of
  executable criteria also requires the deterministic checker unless
  `allowVerifierOnlyCompletion` is explicitly enabled.
- The verification **gate runs before any check command**: authority, revision,
  readiness, budgets, commit pin, and a clean pinned workspace are validated
  first. An unauthorized or premature request executes nothing. Duplicate
  criterion ids are deduplicated, and approval requires complete criteria
  coverage.


- Commands come from objective criteria, which in the default configuration are
  authored in a **human-authority** turn (`objective_create`); an
  agent-proposed objective needs human approval. The checker does not execute
  arbitrary text from worker reports.
- Checks run with the owner's working directory through the harness subprocess
  service, with bounded output and a hard timeout; child environments are
  scrubbed by that service. `checkerExecute: false` disables host execution.
- The verifier cannot override a failed engine check; the engine's executed
  evidence is authoritative for mechanical criteria. Conversely, the engine
  cannot override a verifier reject: both gates must pass.

## Using it

```json
{
  "statement": "The exporter writes a non-empty CSV with the expected header",
  "criteria": [
    {
      "statement": "export exits 0 and prints the row count",
      "check": {
        "kind": "command",
        "command": "make export && test -s out/export.csv && head -1 out/export.csv | grep -qx 'id,name'",
        "cwd": ".",
        "expectedExitCode": 0,
        "timeoutMs": 300000
      }
    },
    {
      "statement": "the artifact is the expected file",
      "check": { "kind": "artifact", "path": "out/export.csv", "minBytes": 32 }
    },
    {
      "statement": "the operator confirms the column names",
      "check": { "kind": "human-ack", "prompt": "Are the columns correct for the finance import?" }
    }
  ]
}
```

Before starting work, baseline the checks:

```text
objective_lint { objectiveId: "obj-…", execute: true }
```

An assertion about new behavior that fails baseline is expected; an assertion
about unchanged behavior that fails baseline is the check's bug. At
verification, the engine executes the checks, and only a passing preflight
starts the verifier. Approve requires both.
