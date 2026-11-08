# The objective/progress orchestrator

`packages/objective-engine` (`@local/objective-engine` 0.2.0) is the control
plane for an orchestrator that runs **over time**: it tracks objectives against
progress, wakes the owning session only on events, gates completion on an
independent verifier, and bounds everything with budgets and admission limits.
This page is the reference; the [design](design/objective-progress-swarm-design.md)
explains why the control plane is shaped this way, and the
[package README](../packages/objective-engine/README.md) is the operator runbook.

## Is the idea viable?

The original question was whether an orchestrator that tracks *objective*
messages against *progress* messages, uses Mammoth to tell them apart, and
"runs indefinitely by dropping progress prompts" is viable or bad practice.
The answer this kit implements:

- **Viable, with three corrections.** Objectives and progress are different
  records with different authority, not two labels on one queue. A model may
  *propose* which one a message is; it never *decides* — only an explicit tool
  call by an authorized actor creates or attaches anything. And "runs
  indefinitely" means *keeps working across objectives, started by events*,
  never a self-calling loop: an idle engine makes no model calls.
- **Overload is measured, not counted.** One objective can generate unbounded
  work, so the engine bounds in-flight items, verifier backlog, dispatch rate,
  and per-objective tokens, rounds, and wall time — not just the number of
  objectives.
- **Completion is a gate.** A different session with a different preset, on
  the pinned commit, must cover every criterion with evidence; judgment
  criteria additionally need a human acknowledgment. The producer cannot grade
  itself through any tool path.

## Three planes

| Plane | Owner | Rule |
|---|---|---|
| Control | `@local/objective-engine` | The only writer of objective state: registry, journal, admission, budgets, wakeups, dispatch provenance, completion gate, kill switch |
| Data | sessions and presets | Manager, workers, verifier. Produce work, evidence, reports, verdicts; cannot mutate objective state except through the engine's authority checks |
| Decision | System One via `@local/systemone` | Advisory classification proposals only; `swarm_assign` chooses personas, unchanged |

## Record types

**Objective** (`opm/v1`): `statement`, `criteria[]` (`id`, `statement`,
`check`, `requiresHumanAck`), `criteriaVersion`, `owner` (session + preset),
`creator` (`human` or `agent`), `priority` 0–9, `scope` (`paths`), `budget`
(`rounds`, `tokens`, `wallTimeMs`, `items`, `verifierRuns`, `concurrency`),
`state`, `blockedReason`, `armed`, `revision`, counters.

**Work item**: `work-order` (dispatchable; needs `acceptance[]` and
`link.criterionIds[]`), `status-report` (evidence), `heartbeat` (liveness only).
Fields: `assignedPersona`, `assignedChild` (`kind: child|external`, session,
preset), `evidence[]`, `report`, `state`, `attempt`, `failure`.

**Verification**: `criterionIds[]`, `advisory` (subset), `commit`
(`pinned`, `commit`, `dirty`), `verifier` (`kind: child|external`), `evidence[]`,
`verdict` (`kind`, `requested`, `downgrade`, `coverage`), `ack`, `state`.

**Wakeup**: `objectiveId`, `form`, `occurrence`, `objectiveState`, `revision`,
`state` (`reserved`, `admitted`, `expired`, `superseded`).

## State machines

Objective:

| From → To | Trigger | Actor |
|---|---|---|
| ∅ → `active` / `queued` | `objective_create` | human (root turn) |
| ∅ → `proposed` → `active` | `objective_create` (agent, flag on) → `objective_control approve` | agent → human |
| `queued` → `active` | slot freed (completion, cancellation, sweep) | engine |
| `active` → `paused` | `objective_control pause`, criteria edit, send-back, restart | human / engine |
| `paused` → `active` | `objective_control resume` (budget not exhausted) | human only |
| `active` → `verifying` | `objective_verify` with every linked work order accepted | owner / human |
| `verifying` → `active` | reject or inconclusive within limits | engine |
| `verifying` → `awaiting-human` | approve with a judgment criterion | engine |
| `verifying` → `completed` | approve, purely mechanical criteria | engine |
| `awaiting-human` → `completed` | `objective_ack ack` | human only |
| `awaiting-human` → `paused` | `objective_ack send-back` | human only |
| open → `blocked` | budget exhausted, stall, 3 worker failures, 2 verification failures, queue/ack age | engine |
| `blocked` → `active` | `objective_control resume` after raise / reset / edit | human only |
| open → `cancelled` | `objective_control cancel` | human only |

Work item: `queued → dispatched → reported → accepted | rejected`;
`dispatched → failed` (child error, stall, restart); open `→ cancelled`.
Terminal items are never reopened; a retry is a new item.

Forbidden by construction: producer → completed (no tool exists), verifier →
anything but its own verdict, proposal → any state change, worker accepting its
own item, dispatch while paused or disarmed, retry after budget exhaustion
without a human raise, auto-resume after restart, same item re-dispatched.

## The driver

Event sources: a human message in the owner session (a normal turn), a child
settling (`subagent/end`), the owner going idle (`agent/status`), an explicit
resume, and one coarse sweep timer for deadlines (budgets, stalls, queue age,
ack age). Nothing else starts work.

The pump is per session and serialized. On each event it selects at most one
action by priority — ack pending, verdict notice, failed item, ready work,
blocked notice, or (when nothing is open) a "plan the next step" prompt on the
`progressIntervalMs` cadence — reserves a wakeup, and queues it with
`agent.followup` under source kind `objective-engine`. One wakeup per session is
outstanding at a time, so a burst of child completions produces one turn.

The `agent/pre-step` fence then admits the wakeup (consuming one round),
supersedes it when a human message is in the same batch (the human always wins),
or rejects the step when the wakeup is stale (its objective changed state, was
disarmed, or the engine paused). A rejected or superseded wakeup costs nothing.

Prompt templates are versioned (`template=1`) and carry the wake id, occurrence,
objective id, and revision in a header, so the model and the fence can both
detect a duplicate.

## Advisory classification

`objective_classify` sends the design's three questions in one request
(`message_type` with five labels, `target_objective` when several objectives are
active, `is_objective` as a probability) and applies the deterministic decision
rule with the configured thresholds (`objectiveProbability`,
`progressProbability`, `choiceFloor`, `confidenceFloor`, `margin`). Proposals are
journaled in `advisory.jsonl` with the model id and latency; a second
classification of the same message that disagrees turns both into `ambiguous`,
and a third is refused. Incoming human messages in owner sessions are auto-tagged
after the step decision. Outage policy: a failure returns
`classifier-unavailable`, three consecutive failures open a breaker for
`breakerCooldownMs`, and `classificationCallsPerHour` caps the rate. None of it
touches the command journal; a forged proposal cannot create a record.

## Composition

- **Presets** (`dsh-personas`): `objective-manager` (plans, dispatches through
  the engine, no subagent tools) and `verifier` (read-only on source, evidence
  only). The orchestrator preset's spawn tool gains `allowedAgentPresets` so a
  manager-driven fallback dispatch can pick a role preset.
- **systemone**: both personas are in the default `swarm.personas` catalog; the
  eleven `objective_*` tools and the team tools are in the default
  `swarm.orchestratorTools`; the engine reaches Mammoth through the
  `systemone` service and publishes an `objectives` service for the sidebar
  panel. The example profile patch adds a `presets.verifier` policy and judge.
- **Host services** used with typed degradation: `agents` (authority, idle),
  `agentPresets` (preset ids), `subagents` (`startActivation` with
  `agentPreset`), `subprocess` + `workingDirectory` (commit pinning),
  `tokenMeter` (token budgets), `systemone` (classifier). Without `subagents`
  the manager dispatches with its own subagent tool and binds the child
  (`objective_dispatch external:true`, `objective_report childSessionId`), and
  an independent session records the verdict.

## What remains (Phase 2)

- Per-objective worktree isolation and a serialized merge queue (the design's
  C13/C14); today's isolation is exclusive `scope.paths` in one checkout.
- Engine-owned schedule cadence through `dsh-schedule` (opt-in periodic event
  source); today the timer is in-process and only fires while the host runs.
- A dedicated Web page for acknowledgments; today the manager asks with
  `ask_user_question` and the human records `objective_ack`.
- Cross-process leases (the `LOCK` file is single-host) and a 72 h soak with a
  mock provider.
