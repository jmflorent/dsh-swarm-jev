# Phase-1 acceptance report

**Status: accepted** — the Phase-1 control plane passed its in-harness acceptance
drill on 2026-11-08 against the deployed bundles (`@local/objective-engine`
0.2.0, `@local/systemone` 0.2.4, `@local/dsh-personas` 1.1.0, DSH 0.2.2-rc.1).
Phase 2 is not started; its entry conditions are listed at the end.

## Method

The drill ran in a **real top-level session** using the one-shot headless
composition in an isolated `DSH_HOME`:

```bash
DSH_HOME=/tmp/dsh-phase1-accept dsh --profile headless --approval-policy never - < task.txt
```

The headless CLI delivers the task as a `user/message` with `source.kind:
"user"` in a top-level session, so the engine's execution-time authority treats
it exactly like a human turn. The profile composed `dsh-base` + `dsh-headless`,
the three local bundles, an explicit `agent-preset-registry` (the headless
template does not ship one), and a model provider pointing at the self-hosted
endpoint. The engine used a throwaway `dataDir`; the live profile was untouched
by the drill.

The task drove the full loop through the model-facing tools only:
`resume → create → plan → dispatch → worker report → accept → verify →
verifier child → verdict → close`, with polling between asynchronous steps.

## Result

| Gate | Evidence |
|---|---|
| Human authority | `objective_create` / `objective_system resume` / `objective_plan accept` / `objective_verify` all succeeded when the turn contained a direct human message; a separate non-human probe was rejected with `unauthorized` |
| Objective lifecycle | `obj-1cc66183a91e4ef5a4d8` created (`active`), one item (`itm-...`), accepted, verified, **completed**; final engine counts `completed: 1`, all other states 0 |
| Engine-started worker | child started with preset `architect`; item recorded `assignedChild` provenance and the worker's `objective_report` landed as `item/reported` (agent actor) |
| Independent verification | verifier child (preset `verifier`) ran the command criterion `true`, recorded `approve` with the pinned commit `1b65516812af59f3432f01154a77ac28fe5d5389` and `workspaceClean: true`, criterion `c1` PASS |
| Commit pinning / clean tree | verification request pinned the repository HEAD; the verifier refused an earlier run in a dirty worktree as inconclusive, which is the intended fail-closed behavior |
| Event-driven operation | the whole loop was driven by tool calls and engine wakeups; no self-calling prompt loop |
| Kill switch / restart | covered by the automated suite and the live authority probe; not re-run in this drill |
| Transient overload | one `engine/overloaded` event during verification, resolved by `engine/recovered`; final `backpressure: false` |
| Automated matrix | `objective-engine selftests passed (16 sections)`; systemone and personas selftests pass; self-contained systemone install validated in this fresh profile (no registry resolution) |

## Defects found and fixed by this drill

1. **Workers could never start.** The dispatcher passed `maxDepth: 0` to
   `ctx.subagents.startActivation`; the subagent service interprets that value
   as an **absolute** child-depth cap, so every depth-1 worker (and the
   verifier) failed with `subagent depth 1 exceeds maxDepth 0`. The dispatcher
   now caps at the owner's delegation depth + 1 (`workerMaxDepth` default 1),
   which allows a root or nested owner to start its worker and still forbids
   grandchildren. Pinned by a unit regression for both root (cap 1) and nested
   (cap 2) owners.
2. **Human-owner dispatch did not fold.** A dispatch issued from a turn with a
   direct human message was journaled with `actor.kind: "human"`, but the fold's
   allow-list for `item/dispatched` (and the `verification/` family) accepted
   only `agent`/`engine`; the engine then reported `fold rejected a freshly
   written event: item/dispatched` while the child had already started. Both
   now allow human owners, with a regression pinning the human-owner dispatch
   path.

The drill also confirmed that a dirty worktree makes verification
**inconclusive** rather than silently passing — the acceptance run was rerun
after committing the fixes.

## What this does not cover (Phase-2 entry conditions)

- Two weeks of supervised use of the deployed Phase-1 engine, with at least one
  human-acknowledged objective.
- A written incident review for every `blocked`/`degraded`/classifier failure
  observed during that period.
- Decisions on the design's open questions 5–7 and an agreed token-cost ceiling.
- Phase-2 hardening itself: durable `dsh-schedule` cadence, per-objective
  worktrees + serialized merge queue, acknowledgment page/command surface,
  metrics/OTel, cross-process leases, the P2 drills, and the 72 h soak.


## Post-acceptance checker evolution (0.3.0)

After Phase 1 was accepted, the checker was hardened along the lines of
[Ringer](https://github.com/NateBJones-Projects/ringer): the engine now executes
`command`/`artifact` criteria itself, fails verification before spending a
verifier run, reports exact exit/output evidence, exposes check lint and a
baseline through `objective_lint`, and tells workers which checks will be
executed. The verifier remains mandatory for semantic review. The comparison,
trust model, and the deliberate non-adoptions are in
[`docs/checker.md`](../checker.md).

An isolated headless acceptance run re-ran the Phase-1 end-to-end drill against
0.3.0 and recorded the executed-check results in the verification record; the
twenty-two-section suite covers both the passing path and the preflight-failure path
(no verifier child is started). The live deployment was upgraded to 0.3.0 and
remains paused by default.
