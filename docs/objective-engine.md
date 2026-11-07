# The objective/progress orchestrator (MVP)

`packages/objective-engine` (`@local/objective-engine` 0.1.0) is a working,
bounded implementation of the objective/progress loop this kit was built for.
It is the operational counterpart of the
[full design](design/objective-progress-swarm-design.md): the design explains
why the control plane is shaped this way and which hardening items remain.

## What it does

- Tracks two record types in one durable journal: **objectives** (a body of
  work with checkable criteria, an owner session, and a round budget) and
  **progress** (work orders, status reports, heartbeats).
- Gates completion: a different session must record a `pass` verdict with
  `objective_verify` before the owner may call `objective_complete`.
- Keeps an orchestrator working **over time**: when the engine is resumed, a
  driver drops progress prompts into the owning session on idle edges, after a
  tracked child settles, and on a coarse timer. Every prompt consumes one round;
  exhausted objectives block instead of looping.
- Bounds itself: active objectives are capped, extra objectives queue and are
  promoted on completion/cancellation, and the whole driver boots **paused**.
- Uses Mammoth as an **advisory classifier**: incoming user messages in owner
  sessions are tagged (`new-objective` / `progress` / `not-work`, with a
  probability), and `objective_classify` exposes the same question to the
  orchestrator. Tags never mutate state; the tools are the deterministic
  boundary.

It never does stage work itself. The session it prompts is the orchestrator:
it decomposes, dispatches subagents (with swarm mode and `swarm_assign` when
desired), verifies their claims, and integrates results.

## Install

```text
DSH Web → Plugins (sidebar) → Add plugin → local directory
    choose: <repo>/packages/objective-engine
```

The bundle has **no runtime dependencies** (Node built-ins only), so it installs
without registry resolution. If you wire profiles by hand, add
`"@local/objective-engine": "link:<path>"` to the profile dependencies and
`@local/objective-engine` to `dsh.profile.bundles`.

The bundle inserts one row (`objective-engine`). Its defaults run without a
profile override; deployment values go in the profile patch row of the same id.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | When false, the driver and tools refuse work. |
| `dataDir` | `$DSH_HOME/storages/objective-engine` | Holds `journal.jsonl`. |
| `maxActiveObjectives` | `3` | Active objectives before new ones queue. |
| `maxQueuedObjectives` | `16` | Durable queue depth; beyond both caps creation is rejected `admission-full`. |
| `maxRoundsPerObjective` | `12` | Default progress-prompt budget (per objective override on create). |
| `progressIntervalMs` | `45000` | Timer cadence for "drop a progress prompt over time". |
| `minWakeGapMs` | `8000` | Minimum gap between prompts to one session. |
| `tickMs` | `20000` | Timer resolution. |
| `classification.enabled` | `true` | Auto-tag incoming user messages. |

## Tools

| Tool | Purpose |
|---|---|
| `objective_create` | Create an objective (statement, ≥1 criterion, optional budget/idempotency key). Caller session owns it. |
| `objective_status` | Engine state, limits, counters, objectives, progress, verifications, tags, wakes. |
| `objective_plan` | Record a work order / status report / heartbeat. |
| `objective_report` | Report progress or update an existing item. |
| `objective_verify` | Independent verdict (`pass`/`fail`/`inconclusive`) + evidence. Owner rejected. |
| `objective_complete` | Owner-only; requires a latest `pass` verdict. Frees a slot, promotes a queued objective. |
| `objective_cancel` | Owner-only cancellation of an active/queued/blocked objective. |
| `objective_classify` | Advisory Mammoth question about a message. Journaled; no state change. |
| `objective_system` | `resume`, `pause`, or `status` for the driver. |

## The loop, step by step

```text
1. objective_system { action: "resume" }        # arm the driver
2. objective_create {
     statement: "Ship the login rate limiter",
     criteria: ["tests pass", "reviewer approves"],
     budgetRounds: 12
   }
3. The engine sends progress prompts while the objective is active:
   - an idle edge in the owner session,
   - a tracked child settling,
   - the coarse timer (progressIntervalMs).
   Each prompt consumes one round and shows the remaining budget.
4. The orchestrator advances the objective with objective_plan /
   objective_report and dispatches work orders to subagents.
5. A different session records objective_verify(pass, evidence). The owner
   calls objective_complete. The engine promotes the next queued objective.
6. objective_system { action: "pause" } stops the loop; the engine also boots
   paused after every process start.
```

## Storage and safety

- Journal: `$DSH_HOME/storages/objective-engine/journal.jsonl`, one JSON event
  per line, fsynced per append, torn tail truncated on load.
- Boots paused; resuming is explicit.
- Verification requires a distinct session; the latest verdict must be `pass`.
- Wakes are journaled before delivery; one per objective round.
- The engine can only prompt sessions that are live in the same process; a
  dormant session waits for its next idle edge.

## What is not implemented (relative to the design)

- Commit pinning and per-objective worktree isolation.
- Human acknowledgment for judgment criteria (verification is session-based).
- Cross-process leader election / durable cadence through the schedule service.
- Dedicated Web UI page; the right-sidebar **Swarm** panel renders the engine
  snapshot (paused state, counts, objectives with round budgets) when the
  systemone bundle is also composed.

The design's [nine conditions](design/objective-progress-swarm-design.md) remain
the checklist for Phase 2 hardening. This MVP enforces the core loop and the
verification gate; it does not claim the full always-on envelope.

## Tests

```bash
cd packages/objective-engine
node test/run.mjs        # or: pnpm test
```

Coverage: boot/pause, create/admission/queue promotion, progress, verifier gate,
cancellation, budget blocking, advisory classification (explicit and automatic),
restart fold, torn-tail repair, tool definitions, and the driver pump.
