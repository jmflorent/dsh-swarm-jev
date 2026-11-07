# The swarm orchestrator and the objective/progress design

This document explains the orchestrator idea behind this repository, what is
implemented today, what is designed but not built, and how the two connect.

**Status in one line:** swarm mode is implemented in the
[`dsh-systemone`](../packages/dsh-systemone) bundle; the objective/progress agent
type is **design complete and not implemented** — the full design is in
[`docs/design/objective-progress-swarm-design.md`](design/objective-progress-swarm-design.md).

---

## 1. The idea

The user's original idea, as the design document states it:

> An orchestrator that tracks **objective** messages against **progress**
> messages, uses the self-hosted Mammoth/System One decision model to tell them
> apart, and runs indefinitely by dropping progress prompts and closing
> objectives when satisfied.

Three claims hide in that sentence, and the design treats each one as a
requirement rather than an implementation detail:

1. **Objectives and progress are different records.** An objective is a state of
   the world with checkable acceptance criteria, an owner, and a budget. Progress
   is a work order, a status report with evidence, or a heartbeat. They cannot
   be the same queue with a flag.
2. **A model may propose, never decide.** Telling an objective message from a
   progress message is exactly the kind of ambiguous, unstructured judgment a
   calibrated decision model is good at — *as an advisory proposal*. The design
   forbids it from being in the control path: a proposal cannot create, attach,
   close, pause, or budget anything.
3. **"Runs indefinitely" must not mean "spends tokens forever."** Work starts
   only on an event — a human message, a child settling, a due deadline, an
   explicit resume. There is no self-calling turn and no background model loop.

The result is not a new persona prompt. It is an agent type made of a plugin (the
control loop), two presets (manager and verifier capability envelopes), two
persona entries in the swarm catalog, and a small service seam in `systemone`.

---

## 2. What is implemented today

| Piece | State | Where |
|---|---|---|
| Five role presets | Implemented | [`packages/dsh-personas`](../packages/dsh-personas) |
| `systemone_ask` / `systemone_status` | Implemented | [`packages/dsh-systemone`](../packages/dsh-systemone) |
| Decision layer (`off`/`shadow`/`enforce`) | Implemented | `lib/decisions.js` |
| Swarm mode (`swarm_enter`, `swarm_assign`, `swarm_exit`) | Implemented | `index.js`, `lib/decisions.js` |
| `objective-manager` / `verifier` presets | **Design only** | Not in the shipped personas bundle |
| `@local/objective-engine` plugin, `objective_*` tools, journal | **Design only** | Not implemented |
| Durable objective registry, budgets, wakeups, completion gate | **Design only** | Not implemented |

So today you can run the *orchestrator workflow* — enter swarm mode, decompose
work, let the decision model assign personas, dispatch subagents, and have every
call judged — but you cannot register and track objectives in a durable
registry. The Phase 0 recipe below approximates that on the team task board.

---

## 3. How the design plugs into swarm mode

Swarm mode is the runtime the design builds on. It already provides the pieces
the engine needs to stay small:

| Swarm-mode feature | Role in the objective design |
|---|---|
| `swarm_enter` / session-scoped membership | The manager session becomes an orchestrator; all other sessions stay inert |
| Orchestrator tool restriction | Keeps the manager out of stage work, so work orders are the only path to execution |
| `swarm_assign` | **Unchanged.** It remains the stage-assignment authority: the engine consumes the returned persona, it does not choose one itself |
| `swarm.personas` catalog | Extended (in config, not code) with `objective-manager` and `verifier` |
| Per-call assessment / judge | Judges the manager's and workers' calls the same way it judges any enforced session |
| Per-preset policy | Encodes the verifier's evidence-only allowance and the manager's no-completion rule |

The design adds, rather than rewrites:

- a **host plugin** `@local/objective-engine` (service `objectives`, eleven
  `objective_*` tools, an append-only journal with snapshots, admission,
  budgets, a wakeup pump, verification, and a kill switch);
- **two presets** (`objective-manager`, `verifier`) plus persona catalog entries;
- **one service seam** in `systemone`: `ctx.provide('systemone', { decide, … })`
  so the engine can ask the decision model for the advisory classification
  without duplicating the HTTP client or touching the layer's state;
- config changes only: the objective tools and team tools are added to
  `swarm.orchestratorTools`, `objective-manager` to `swarm.presets`, and the two
  personas to `swarm.personas`.

`swarm_assign` keeps its exact current meaning. It is not a message classifier
and not a completion judge: the classifier question is a separate
`objective_classify` call whose answer is journaled as advisory, and the
completion gate never reads an assignment.

---

## 4. The design at a glance

The full design is decision-complete — protocols, state machines, limits,
failure policy, file/row changes, tests, and open decisions. A compact summary:

### Three planes

| Plane | Owner | Rule |
|---|---|---|
| **Control plane** | `@local/objective-engine` | Owns the registry, journal, admission, budgets, wakeups, completion gate, kill switch. The only writer of objective state |
| **Data plane** | Ordinary sessions and presets | Manager session, role workers, verifier child. Produce work, evidence, reports, verdicts; cannot mutate objective state |
| **Decision plane** | System One via `@local/systemone` | Produces advisory classification proposals only. No control-path calls |

### Two record types, one registry

- **Objective** — statement, 1–12 checkable criteria, owner, priority, scope,
  budget (rounds, tokens, wall time, items, verifier runs, concurrency), state,
  revision.
- **WorkItem** — `work-order` (dispatchable), `status-report` (evidence),
  `heartbeat` (liveness; never progress).
- **Verification** — pinned commit, per-criterion evidence, verdict, human ack.
  The only path to completion.

State machines are closed and event-sourced: objective transitions O1–O14, work
item I1–I10, verification lifecycle, engine lifecycle. Every mutation is a
journal event with an idempotency key and CAS on revisions; a producer can never
accept or verify its own work; a verifier can only touch its own record; a
classifier proposal can never transition anything.

### Event-driven, not self-driving

| Event source | Mechanism |
|---|---|
| Human message in the owner session | A normal turn |
| Child settlement | `subagent/end` |
| Owner idle | `agent/status` + idle check before a wakeup |
| Deadline sweep | One coarse timer for budget/stall/queue deadlines; no model call unless an action exists |
| Cadence (Phase 2 only) | A `dsh-schedule` task created through the service; delivery is an event, never authority |
| Restart | Journal fold; always ends paused, never wakes anything |

The pump is serialized, reserves an idempotent wakeup before prompting, uses a
pre-step fence to reject duplicate or stale prompts, and coalesces a burst of
child completions into one model turn.

### Completion is a gate, not an opinion

An objective completes only when a verifier — a different session, started by
the engine, on the pinned commit — covers **every** criterion with evidence, and
every judgment criterion has a human ack recorded from a root turn containing a
direct human message. Purely mechanical objectives may complete on an approval
without an ack. All other paths fail closed.

### Bounded by design

Admission caps active objectives, queued objectives, per-owner objectives, items
per objective, in-flight items, verifier runs, dispatches per hour, rounds,
tokens, wall time, stall time, and queue age. Exhaustion blocks with a typed
reason and is never auto-retried. A kill switch (`objective_system pause`, a
`PAUSED` sentinel, or a service call) pauses the engine, cancels in-flight
children, expires wakeups, and survives restart.

### Phasing

| Phase | What it is | Entry criteria |
|---|---|---|
| **Phase 0** | A bounded prototype with **no plugin**: orchestrator session + swarm mode + team board as registry + reviewer child as verifier + human/automation ticks + hard caps | User approval; config backed up |
| **Phase 1** | The control-plane plugin: journal, admission, budgets, wakeups, completion gate, verifier preset, tests | Phase 0 on ≥10 supervised objectives with zero completion-gate bypasses; writeup of every bypass |
| **Phase 2** | Always-on hardening: circuit breaker, durable cadence, worktree isolation + serialized merge queue, ack surface, metrics, 72 h soak | Phase 1 acceptance green; two weeks of supervised use; incident review; decisions on the open questions |

The design carries a **REQUEST CHANGES** review verdict with **nine must-fix
conditions**. Section 10.4 of the design maps each condition to its mechanism
and to Phase 0/1/2 tests, and the coverage statement is explicit that conditions
2–6 and 8 are enforced only from Phase 1. The corrected design does not claim
that a prototype enforces them.

---

## 5. Try the workflow today (Phase 0 prototype)

You can exercise the shape of the objective workflow with only what this
repository ships plus DSH's team bundle. This is a **manual, supervised
prototype** — not the engine.

**Setup**

1. Install both bundles and set System One to `mode: shadow` first.
2. Confirm `@deepseek-ai/dsh-experimental-agent-team-profile` is in the profile
   (it provides the team board).
3. Start a session with the **Orchestrator** preset.

**Run one objective**

1. The human writes the objective explicitly, with acceptance criteria. The
   orchestrator creates **one team task** for the objective
   (`team_task_create`), title `OBJ-1`, description containing statement,
   criteria, owner, budget counters, priority, and state.
2. Progress items become separate tasks (`ITEM-1.1`, …) with `kind`,
   `acceptance`, and a link to the objective task.
3. The orchestrator enters swarm mode (`swarm_enter`) and keeps the workplan in
   its todo list.
4. For each stage it calls `swarm_assign(stage, needs, context?)`; it dispatches
   a subagent with the returned persona's instructions and a self-contained
   brief.
5. A reviewer child (or a second human-driven reviewer session) validates the
   work and returns a verdict with evidence.
6. The human acks judgment criteria; the orchestrator marks the task completed
   only after the verdict and the ack.

**The caps you enforce by discipline**

- one active objective at a time;
- at most four items;
- at most two verifier runs;
- wall time ≤ one day;
- no objective completed without a distinct verifier and a human ack;
- no classifier opinion acted on automatically (there is no classifier in the
  control path in Phase 0).

**What the prototype deliberately loses** — documented in the design, not
accidental: the team board has four statuses, no budget enforcement, no
verification model, and advisory write scopes only. The value of Phase 0 is the
operator experience and the log of every place discipline was bypassed; that log
is Phase 1's entry criterion.

---

## 6. What would have to be built next

Phase 1 is specified file-by-file and row-by-row in the design (§8):

| New artifact | Purpose |
|---|---|
| `objective-engine/package.json`, `cordis.patch.yml`, `index.js` | Host plugin, bundle row, service |
| `lib/store.js`, `lib/fold.js`, `lib/transition.js` | Append-only journal, pure fold, command transitions |
| `lib/admission.js`, `lib/pump.js`, `lib/dispatch.js` | Limits/queue/fairness, serialized wakeups, child dispatch |
| `lib/verify.js`, `lib/classify.js`, `lib/prompts.js`, `lib/status.js` | Commit pinning + verdict validation, advisory classification, versioned prompts, status payload |
| `preset-objective-manager`, `preset-verifier` rows in `dsh-personas` | Capability envelopes for the manager and verifier sessions |
| `ctx.provide('systemone', …)` in `packages/dsh-systemone` | The decision-plane seam |
| Profile rows for `objective-engine` + additions to `swarm.personas` / `swarm.orchestratorTools` / `swarm.presets` | Deployment wiring |
| Tests (`test/`, a nine-condition suite, fake ctx) | Prove the gate, duplicate replay, restart, outage, and bypass rejection |

If you are implementing it, read the design's Appendix B first: it separates
every **proposal** (new code) from behavior that was **verified** as shipped in
DSH 0.2.2-rc.1, and gives the fallback for each proposal that might not hold.

---

## 7. Open questions the design leaves to the operator

The full design lists twelve, each with a recommended default. The ones that
change what gets built:

| # | Question | Recommended default |
|---|---|---|
| 11.1 | Who produces objectives vs progress? | Human creates objectives; manager/work items progress |
| 11.4 | What does "satisfied" mean, and who declares it? | Verifier verdict covering all criteria + human ack for judgment criteria |
| 11.5 | Idle/event-driven vs periodic ticking? | Event-driven only; per-objective cadence is Phase 2 opt-in, off by default |
| 11.7 | Is the new type the swarm orchestrator or a sixth persona? | A new preset + plugin role that *uses* swarm mode; the orchestrator preset keeps working |
| 11.9 | Host-plane tools or preset-scoped tools? | Host-plane with execution-time authority in Phase 1; consider scoping in Phase 2 |
| 11.12 | Autonomy envelope | Bounded supervised windows now; always-on only after Phase 2 hardening |

Read [`docs/design/objective-progress-swarm-design.md`](design/objective-progress-swarm-design.md)
for the protocol, state machines, limits, failure policy, and the full
nine-condition acceptance matrix.
