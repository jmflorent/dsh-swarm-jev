# @local/objective-engine — objective/progress control plane

A durable, event-driven control plane for an orchestrator that tracks
**objectives** and **progress** and keeps working over time without ever
calling itself:

- an **objective** is a body of work with checkable criteria, an owner session,
  a scope, six budget counters, and a closed state machine;
- **progress** is a work order (dispatchable), a status report (evidence), or a
  heartbeat (liveness only), recorded against an objective;
- the engine journals every mutation, admits work within measured limits,
  starts workers and the verifier itself, **executes the command/artifact
  criteria itself**, gates completion on both those executed checks and an
  independent verifier verdict (plus a human acknowledgment for judgment
  criteria), and wakes the owning orchestrator only on events.

It never does stage work. The session it wakes is the orchestrator: it
decomposes, asks `swarm_assign` for personas, dispatches through the engine,
accepts reports, and requests verification. Mammoth classification is reachable
only through `objective_classify` and is advisory.

The engine boots **paused** after every host start. A human resumes it from a
top-level session with `objective_system { action: "resume" }`.

## Install

The bundle is a normal DSH plugin package (no build step, no runtime
dependencies: Node 24 built-ins and the harness services only):

```text
DSH Web → Plugins (sidebar) → Add plugin → local directory
    choose: <repo>/packages/objective-engine
```

Or wire it by hand like the other local bundles: add
`"@local/objective-engine": "link:<absolute path>"` to the profile's
`dependencies`, add `@local/objective-engine` to `dsh.profile.bundles`, run
`pnpm install` in the profile, restart DSH.

The bundle inserts one row (`objective-engine`). Every field has a default;
deployment values go in the profile patch row of the same id
([example](../../examples/profile-patch.example.yml)). Install the
[`dsh-personas`](../dsh-personas) bundle too: it ships the `objective-manager`
and `verifier` presets the engine dispatches to, and the
[`dsh-systemone`](../dsh-systemone) bundle provides `swarm_assign`, the
decision-plane seam for the classifier, and the sidebar Objectives block.

## The loop

```text
human  objective_system {action:"resume"}                 # arms the driver (human, top-level session)
human  objective_create {statement, criteria:[…], scope}  # the human creates objectives
engine WAKEUP → manager
manager objective_plan {action:"add", title, detail, acceptance:[…], criterionIds:["c1"]}
manager swarm_assign {stage}  →  persona
manager objective_dispatch {itemId, persona, brief}        # engine starts the child with that preset
child   objective_report {objectiveId, itemId, text, evidence:[…]}
engine  child settles → WAKEUP → manager
manager objective_plan {action:"accept", itemId}           # producer cannot accept its own work
manager objective_lint {objectiveId, execute:true}         # optional baseline before work
manager objective_verify {objectiveId}                     # engine pins HEAD, executes the checks, then starts the verifier
verifier objective_verdict {verificationId, verdict, commit, workspaceClean, evidence:[…]}
engine  approve → completed (mechanical) | awaiting-human (judgment criteria)
human   objective_ack {objectiveId, decision:"ack"}        # completes; "send-back" pauses
```

Every arrow after `objective_create` is an event: a child settling, the owner
going idle, a verdict, or the coarse sweep timer. There is no self-calling turn
and no background model loop; an idle engine spends nothing.

**The checker is deterministic.** `command` and `artifact` criteria are run by
the engine in the owner's workspace; a failing check stops verification before
any verifier run and returns the exit/output evidence. Only a passing preflight
starts the verifier, which still inspects the pinned commit and the semantics.
`objective_lint` reports weak checks and can run the baseline. The rationale,
the comparison with the external Ringer runner, and the trust model are in
[`docs/checker.md`](../../docs/checker.md).

## Records and states

**Objective** — `proposed → queued → active ⇄ paused`, `active → verifying →
awaiting-human → completed`, `active → blocked`, any open state `→ cancelled`.
`completed` and `cancelled` are terminal. `armed` is false after every pause,
block, or restart; only a human resume sets it.

**Work item** — `queued → dispatched → reported → accepted | rejected`,
`dispatched → failed`, open `→ cancelled`. A failed or rejected item is terminal:
the retry is a new item.

**Verification** — `requested → approved | rejected | inconclusive`,
`approved → acked`, any `→ superseded` (criteria edit, send-back). A record that
covers a strict subset of the criteria is **advisory** and can never complete
the objective.

**Criteria** — `{ id, statement, check, requiresHumanAck }` with
`check.kind` ∈ `command` (`command`, `cwd?`, `expectedExitCode`, `timeoutMs?`),
`artifact` (`path`, `sha256?`, `minBytes?`), `human-ack` (`prompt`), `evidence`
(a string criterion; the verifier cites what it ran or read). The engine
executes `command`/`artifact` criteria; `evidence`/`human-ack` are judgment
criteria. A `human-ack` criterion, or any criterion with
`requiresHumanAck: true`, needs `objective_ack` after the verifier's approval.
Purely mechanical objectives complete on the approval.

## Tools

| Tool | Who | Purpose |
|---|---|---|
| `objective_create` | human (direct human message, top-level session) | Create an objective: statement, 1–12 criteria, priority, scope, budget. Returns non-blocking check-lint warnings. Beyond the active cap it queues. With `allowAgentProposedObjectives` an agent creates a `proposed` record a human must approve. |
| `objective_status` | anyone | Engine mode, counts, limits, measured load, classifier health, wakeups, recent events, and the redacted records (`objectiveId` narrows). |
| `objective_plan` | owner | `add` a work order / status report / heartbeat; `accept`, `reject`, `cancel` an item. |
| `objective_dispatch` | owner | Start a worker child for a queued work order with the persona `swarm_assign` returned. Provenance is recorded by the engine. |
| `objective_report` | assigned child (item) / owner (objective level) | File evidence or a heartbeat. Reports never complete anything. |
| `objective_verify` | owner or human | Request verification once every linked work order is accepted. Pins the commit, **executes every command/artifact criterion**, and starts the verifier child with a distinct preset only when they pass; a failing check returns `mechanical-check-failed` with its output and consumes no verifier run. |
| `objective_lint` | owner or human | Lint an objective's checks (or a proposed criteria array); `execute:true` runs the mechanical baseline without creating a verification. |
| `objective_verdict` | the verifier child | Per-criterion evidence and `approve` / `reject` / `inconclusive`. Producers are rejected; missing evidence, a wrong commit, or a dirty workspace downgrade to inconclusive. |
| `objective_ack` | human | `ack` completes an approved objective with judgment criteria; `send-back` pauses it with a note. |
| `objective_control` | human | `approve`, `pause`, `resume`, `cancel`, `edit` (criteria edits supersede verifications), `budget-raise`, `reset-attempts`. |
| `objective_system` | human (`resume`), top-level session (`pause`) | The driver: `resume` (optionally `resumeAll` after a restart), `pause` (kill switch), `status`. |
| `objective_classify` | anyone | Advisory Mammoth proposal: `new_objective`, `attach:<id>`, `not_work`, `ambiguous`, `none_fit`. Journaled; never applied. |

Every tool result is lossless JSON with `ok` and, on failure, a stable `code`
(`unauthorized`, `record-incomplete`, `stale-revision`, `admission-rejected`,
`admission-busy` with `retryAfterMs`, `budget-exhausted`, `not-ready`,
`verification-required`, `ack-incomplete`, `objective-terminal`,
`engine-paused`, `engine-degraded`, `classifier-unavailable`, …).

## Authority

Execution-time checks, not prompt rules: creation, approval, control, ack, and
resume require a **direct human message in the current open turn of a
top-level session** (the `dsh-tool-goal` pattern). Engine wakeups carry their
own source kind and never inherit that authority. Plans, dispatches, and
verification requests require the **owner session**. Item reports require the
**assigned child**. Verdicts require the **verifier the engine started**; when
no subagent service is composed the record is `external` and any non-producer
session with a different preset may answer.

## Budgets, admission, and load

Per objective: `rounds` (admitted engine prompts), `tokens` (through
`ctx.tokenMeter` when present), `wallTimeMs`, `items`, `verifierRuns`,
`concurrency`. Exhaustion blocks the objective with `budget-exhausted`; nothing
retries it; a human raises the budget and resumes.

Admission: `maxActiveObjectives` (active, verifying, awaiting-human),
`maxQueuedObjectives`, `maxObjectivesPerOwnerSession`, duplicate statements
within 24 h, overlapping `scope.paths` between active objectives. Load is
measured separately: `maxInFlightItemsGlobal`, `maxActiveItemsPerObjective`,
`maxDispatchesPerHour`, `maxConcurrentVerifierRuns`, per-day verifier runs.
Backpressure stops work wakeups but keeps verdict, failure, and ack handling;
two hot sweeps journal `engine/overloaded` once per hour.

## Storage and durability

```text
$DSH_HOME/storages/objective-engine/
  journal.jsonl    hash-chained command events (opm/v1), fsynced per append
  advisory.jsonl   classifier proposals — never part of the fold
  snapshot.json    periodic full fold, a load accelerator only
  LOCK             pid + startedAt; a second engine on the directory stays degraded
  PAUSED           optional operator sentinel: forces paused, refuses resume
```

- Commit-before-ack: a mutation is acknowledged only after its line is on disk.
  A write failure makes the engine **degraded** (read-only) rather than guessing.
- The whole chain is validated from genesis on every load; a torn tail is
  truncated, a gap or hash mismatch refuses to serve (`engine-degraded`).
- Idempotency: `objective_create` with `idempotencyKey` replays the original
  result for the same payload and fails `idempotency-conflict` for a different
  one; wakeups carry `opm:v1:wake:<objective>:<occurrence>` keys.
- Restart: dispatched items fail (`process-restart`), requested verifications
  become inconclusive, active objectives are paused and disarmed, pending
  wakeups expire, and the engine starts paused. Nothing wakes at boot.

## Operator runbook

| Situation | What to do |
|---|---|
| Fresh start | `objective_system {action:"resume"}` from a top-level session in a human turn |
| After a host restart | `swarm_enter` again in the manager session, then `objective_system {action:"resume", resumeAll:true}` or `objective_control {action:"resume"}` per objective |
| Stop everything now | `objective_system {action:"pause"}`; it survives restart. Or create `PAUSED` in the data directory |
| `blocked: budget-exhausted` | `objective_control {action:"budget-raise", budget:{rounds: N}}`, then `resume` |
| `blocked: verification-failed` | `objective_control {action:"reset-attempts"}` or `edit` the criteria, then `resume` |
| `blocked: worker-failures` | read the failed items in `objective_status`, fix the brief or scope, `reset-attempts`, `resume` |
| `awaiting-human` for days | `objective_ack {decision:"ack"}` or `send-back`; after `maxAckAgeMs` it blocks `human-ack-timeout` |
| `engine-degraded` | read `objective_status.engine.degraded`; stop the host, back up the directory, remove a stale `LOCK` only if its pid is dead, or restore `journal.jsonl` from the last good line; delete `snapshot.json` to force a full replay |
| Reset completely (destructive) | stop the host, move the data directory aside; every objective is gone and must be recreated |
| Remove the bundle | pause first, remove the bundle from the profile, keep the directory for audit |

## Configuration

See [`docs/configuration.md`](../../docs/configuration.md#7-localobjective-engine-configuration)
for every field. The ones you are most likely to change:

| Field | Default | Meaning |
|---|---|---|
| `maxActiveObjectives` / `maxQueuedObjectives` / `maxObjectivesPerOwnerSession` | 3 / 32 / 3 | Admission bounds |
| `maxRoundsPerObjective` | 12 | Admitted engine prompts per objective |
| `progressIntervalMs` / `minWakeGapMs` / `tickMs` | 45 s / 8 s / 20 s | Driver cadence |
| `verifierPresets` | `[verifier, reviewer]` | Presets tried for the verifier child (must differ from the producer's) |
| `checkerExecute` | `true` | Execute command/artifact criteria in the engine before the verifier; `false` falls back to verifier-run evidence |
| `checkerTimeoutMs` / `checkerMaxTimeoutMs` | 120 s / 1 h | Per-check default and ceiling |
| `checkerMaxOutputBytes` | 64 KiB | Bounded stdout/stderr captured per check |
| `allowAgentProposedObjectives` | `false` | Agent-created objectives are `proposed` until a human approves |
| `classification.*` | design thresholds | Advisory classifier thresholds, breaker, auto-tagging |

## Tests

```text
cd packages/objective-engine
node test/run.mjs        # or: pnpm test
```

Twenty-one sections over a fake Cordis context: boot/lock/sentinel, torn tail and
hash chain, record completeness and human authority, admission and queue
promotion, agent-proposed objectives, the full completion gate with dispatch
provenance and commit pinning, mechanical completion and send-back, budgets,
restart reconstruction and replay determinism, wakeups and the pre-step fence,
coalescing and backpressure, the kill switch, the advisory classifier with the
outage policy and the replay paradox, the decision-rule table, fallback paths,
the deterministic checker (executed command pass/fail, no verifier run on a
failed preflight, artifact stat/hash, lint and baseline), the verification-gate
regressions (authority/readiness/coverage/clean pin before any check runs), the
dispatch-depth and human-actor regressions, and tool wiring against the registry contract (no
external dependency needed).
