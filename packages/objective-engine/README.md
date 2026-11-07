# @local/objective-engine — objective/progress orchestrator

A durable, event-driven driver for an orchestrator that tracks **objectives** and
**progress** and keeps working over time:

- an **objective** is a body of work with checkable criteria, an owner session,
  and a progress-prompt budget;
- **progress** is a work order, status report, or heartbeat recorded against an
  objective;
- the engine journals both, an **independent verifier** gates completion, and a
  **driver** drops progress prompts into the owning session whenever there is
  work and budget — on idle edges, after a tracked child settles, and on a coarse
  timer. It never performs stage work itself.

The engine boots **paused**: nothing runs until a session calls
`objective_system` with `action: "resume"`.

## Why it exists

DeepSeek Harness sessions are turn-driven. A swarm orchestrator that only runs
when the human speaks is not an orchestrator; it is a very smart todo list. This
engine supplies the missing loop while keeping it bounded:

- **objectives are explicit** (`objective_create` + criteria), so "satisfied" is
  a state, not a feeling;
- **progress is recorded** (`objective_plan`, `objective_report`), so the
  orchestrator's own work orders and reports survive context compaction;
- **completion is gated** (`objective_verify` from a different session, then
  `objective_complete` by the owner), so the producer cannot grade itself;
- **the loop is budgeted** (rounds, admission caps, paused by default), so
  "runs indefinitely" means *keeps working across objectives over time*, not an
  unbounded token fire.

## Install

The bundle is a normal DSH plugin package (no build step, no runtime
dependencies):

```text
DSH Web → Plugins (sidebar) → Add plugin → local directory
    choose: <repo>/packages/objective-engine
```

Or wire it manually like the other local bundles: add
`"@local/objective-engine": "link:<absolute path>"` to the profile's
`dependencies`, add `@local/objective-engine` to `dsh.profile.bundles`, run
`pnpm install` in the profile, reload.

After activation the tools appear as host tools in every session. The engine
registers one row (`objective-engine`); deployment values go in the profile patch
override for that row.

## Configuration

Profile patch row `objective-engine` (all fields optional):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Agent: when false the driver and tools refuse work; the registry still loads. |
| `dataDir` | `$DSH_HOME/storages/objective-engine` | Directory holding `journal.jsonl`. |
| `maxActiveObjectives` | `3` | Objectives in `active` state; more are queued. |
| `maxQueuedObjectives` | `16` | Durable queue depth; beyond both caps creation is rejected `admission-full`. |
| `maxRoundsPerObjective` | `12` | Progress prompts per objective before it blocks `budget-exhausted`. |
| `progressIntervalMs` | `45000` | Timer cadence: a prompt is due after this idle gap. |
| `minWakeGapMs` | `8000` | Minimum gap between two prompts to one session. |
| `tickMs` | `20000` | Driver timer resolution. |
| `classification.enabled` | `true` | Auto-tag incoming user messages with the advisory classifier. |

## Tools

| Tool | Purpose |
|---|---|
| `objective_create` | Create an objective (statement + ≥1 criterion + optional round budget/idempotency key). The caller session owns it. |
| `objective_status` | Engine state, limits, counters, objectives, progress, verifications, tags, wakes. |
| `objective_plan` | Record a progress item: `work-order`, `status-report`, or `heartbeat`. |
| `objective_report` | Report progress, or update an existing item (`reported`, `failed`, `ready`). |
| `objective_verify` | Record an independent verdict (`pass`/`fail`/`inconclusive`) with evidence. The owner session is rejected. |
| `objective_complete` | Owner-only; requires a latest `pass` verdict. Frees a slot, promotes a queued objective. |
| `objective_cancel` | Owner-only; stop an active/queued/blocked objective. |
| `objective_classify` | Ask Mammoth whether a message is a new objective, progress, or not work — advisory only, journaled as a tag. |
| `objective_system` | `resume`, `pause`, or `status` for the driver. |

Every tool result is JSON. Mutations append a journal event before they
acknowledge, so a crash never loses acknowledged state.

## Drive an orchestrator

```text
1. objective_system { action: "resume" }        # arm the driver
2. objective_create {
     statement: "Ship the login rate limiter",
     criteria: ["tests pass", "reviewer approves"],
     budgetRounds: 12
   }
3. (the engine now sends progress prompts on idle edges, child settlement, and
   the timer — each one consumes one round)
4. objective_plan { objectiveId, text: "Implement token bucket in auth/limiter.ts" }
5. (dispatch the work order to a subagent; record results with objective_report)
6. A different session — e.g. a reviewer child — calls
   objective_verify { objectiveId, verdict: "pass", evidence: "pnpm test exited 0; diff reviewed" }
7. objective_complete { objectiveId }
```

The progress prompt tells the session what remains, the latest advisory
classification, and the round budget. When the budget runs out the objective
blocks (`budget-exhausted`) instead of prompting forever; pause the whole driver
with `objective_system { action: "pause" }`.

## Advisoriness of the classifier

Mammoth classification (`objective_classify`, and the automatic tagging of user
messages in owner sessions) never mutates objective state. It records a
`tag` event (`choice`, `newObjectiveP`, text preview, model id) that the
orchestrator may read and reason about. The deterministic boundary is the tool
call: objectives exist because `objective_create` ran, not because a classifier
said so.

## Storage, safety, limits

- **Journal:** `$DSH_HOME/storages/objective-engine/journal.jsonl`, one JSON
  event per line, fsynced per append, torn tail truncated on load.
- **Boots paused** on every process start; resuming is explicit.
- **Admission:** active objectives are capped; additional objectives queue and
  are promoted on completion/cancellation (fair per owner session, FIFO).
- **Verification:** a verdict must come from a session different from the
  owner; the latest verdict must be `pass` at completion. Evidence is stored
  verbatim.
- **Wakes** are recorded before delivery; one prompt per objective round. If the
  owning session is not live in this process, the prompt waits for the next idle
  edge.
- **Not implemented (kept out deliberately for this first version):** commit
  pinning and worktree isolation, human acknowledgment for judgment criteria,
  cross-process leader election, and a dedicated objectives page in the Web UI
  (the right-sidebar **Swarm** panel renders the engine snapshot when both
  plugins are composed).

## Tests

```text
cd packages/objective-engine
node test/run.mjs        # or: pnpm test
```

The suite covers boot/pause, create/admission/queue promotion, progress,
the verifier gate, cancellation, budget blocking, advisory classification
(in-process and auto-tag), restart fold, torn-tail repair, tool definitions,
and the driver pump (paused, resume, one prompt per idle edge, budget stop).
