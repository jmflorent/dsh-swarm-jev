# Objective/Progress Agent Type for Swarm Mode — System Design

**Status:** Stage B design (decision-complete). No production code was changed. Stage A's verdict — *viable as a bounded prototype now, not viable as an always-on autonomous loop until hardened* — is treated as a design constraint, not an objection to be argued away.
**Scope:** Turn the user's idea — an orchestrator that tracks **objective** messages against **progress** messages, uses the self-hosted Mammoth/System One decision model to tell them apart, and runs indefinitely by dropping progress prompts and closing objectives when satisfied — into a real agent type inside *this* profile's swarm mode.
**Where it runs:** `DSH_PROFILE=<profile>`, profile dir `~/.dsh/profiles/<profile>`, bundles listed in that profile's `package.json` (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-experimental-agent-team-profile`, `@local/dsh-personas`, `@local/systemone`), local bundles in this repository under `packages/`.
> **Sanitized copy.** Internal hostnames, absolute paths, and deployment-specific model ids were replaced with generic placeholders. The design itself is unchanged. The objective engine it describes is a design only and is not implemented in this repository.
> **Superseded detail:** the design's C4 refers to adding `objective-manager` to `swarm.presets`. That field was removed from `@local/systemone` in 0.2.1; swarm membership is `swarm_enter` only, so no preset list is needed.

**Evidence basis:** every named primitive below was read from the installed code or the docs shipped in `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` (DSH 0.2.2-rc.1, profile team packages 0.2.2-rc.1). Appendix A lists what was verified where; Appendix B flags every proposal that is not yet shipped behavior.

---

## 0. Executive summary

The design splits the idea into three planes that are allowed to talk but not to merge:

1. **Control plane — new host plugin `@local/objective-engine`** (bundle id `objective-engine`, service `objectives`). It owns the durable registry, admission, budgets, scheduling/wakeups, verification gate, kill switch, and the journal. It is the only writer of objective/work-item/verification state.
2. **Data plane — ordinary DSH sessions**: a new `objective-manager` preset session (the new agent type's home), the existing role presets (`architect`, `writer`, `researcher`, `reviewer`, `orchestrator`) as stage workers, and a `verifier` preset child. Workers and verifiers do the work and produce evidence; they cannot change objective state.
3. **Decision plane — Mammoth via `@local/systemone`** (`http://127.0.0.1:8008/v1/systemone`, model `<decision-model-id>`, typed `noul`/`choice`/`score`/`box`). It is used for exactly one thing in this design: producing a **journaled, non-authoritative proposal** for ambiguous unstructured human input. It is never consulted on a control-path transition.

The new agent type is therefore **not** a new model persona that runs the loop in its prompt, and it is **not** a replacement for `swarm_assign`. It is:

- a **plugin** (`@local/objective-engine`) that is the control loop,
- two **persona entries** in `systemone.swarm.personas` (`objective-manager`, `verifier`) so `swarm_assign` can route stages to those roles,
- two **presets** (`objective-manager`, `verifier`) that define the capability envelopes,
- one **small, tested seam** in `@local/systemone` (`ctx.provide('systemone', …)`) so the engine can ask Mammoth without duplicating the client or touching the decision layer's state.

`swarm_assign` keeps its current meaning — *which persona executes this stage* — and is explicitly forbidden from becoming a message classifier or a completion judge. The engine's `objective_dispatch` tool consumes the persona that `swarm_assign` returned, records it on the work item, and starts the child with that preset; the assignment authority stays where the user already has it.

The classifier never sits in the control path. The deterministic type boundary is **tool identity + an explicit `kind` field + execution-time authority**. Mammoth may *propose* "this human message looks like a new objective / belongs to objective X / is progress / is not work" through `objective_classify`; that proposal is written to a separate journal table with `applied: false` and can never create, attach, close, pause, or budget anything. The manager (or the human) must call an explicit mutating tool for anything to change.

Stage A's nine conditions are each realized by a named mechanism and a named test (Section 10 matrix). The phasing is deliberate: **Phase 0** is a bounded, supervised prototype built only from existing primitives (swarm session + team board registry + human/schedule ticks + `reviewer` verifier + hard caps, no plugin). **Phase 1** adds the control-plane plugin and enforces all nine conditions in a single-process host. **Phase 2** is the always-on hardening (decision-plane circuit breaker, durable cadence, worktree isolation and a serialized merge queue, ack surface, metrics/quotas) and is gated on Phase 1 evidence plus a soak test.

---

## 1. Architecture overview and boundaries

### 1.1 Three planes

| Plane | What lives there | What it may write | What it may never do |
|---|---|---|---|
| **Control plane** — `@local/objective-engine` (new host plugin) | Objective / WorkItem / Verification records, event journal, admission queue, budgets, wakeup pump, completion gate, kill switch, status tool | Every registry mutation, via `objectives.*` service methods or the `objective_*` tools, after authority checks | Run model turns of its own; call Mammoth on a control path; treat a proposal as a command; complete an objective without verifier + human gate |
| **Data plane** — sessions/presets | `objective-manager` (root session, new preset), role workers (`architect`/`writer`/`researcher`/`reviewer`/`orchestrator` presets), `verifier` child (new preset) | Workspace files, commits, evidence in tool results; work-item reports and verifier verdicts through `objective_*` tools | Mutate objective state directly; mark its own work complete; create/close objectives from a child session; choose its own verifier |
| **Decision plane** — Mammoth via `@local/systemone` | Calibrated `noul` probabilities, `choice` labels, `score` values, response `model` id and optional `usage` | Nothing (no DSH state) | Gate, create, attach, close, retry, or budget anything |

The plugin is a **host plugin**, not a preset-scoped row, for three reasons: (a) the registry must outlive any one session and be readable from the `objective_status` tool; (b) wakeups must be host-driven (`agent.followup`) rather than a model self-calling its next turn; (c) `@local/systemone` is already a host plugin and provides the decision-plane seam. Tool visibility is host-plane with **execution-time authority checks**, mirroring the verified `dsh-tool-goal` pattern ("authority at execution") rather than preset-scoped rows; Phase 2 may move the `objective_*` tools into the two presets if the always-visible schema cost matters (open decision 11.8).

### 1.2 Which state is authoritative where

| State | Sole authority | Durability | Notes |
|---|---|---|---|
| Objective record (statement, criteria, budget, owner, priority, state, revision) | `objective-engine` journal | Journal + snapshot (Phase 1); team board (Phase 0) | Never session-log custom events: a non-ignorable unknown event type makes the session log unreadable by this build (`dsh-session` known-event-types policy). Never `dsh-goal`: one current goal per session, and objectives are many. |
| WorkItem (work-order / status-report / heartbeat) | `objective-engine` journal | same | Produced under one objective; produced-by / assigned-to session ids recorded |
| Verification record (criteria subset, pinned commit, evidence, verdict, ack) | `objective-engine` journal; evidence authored by the verifier child and by the human | same | Producer cannot write it; engine refuses self-verification |
| Queue / admission decisions | `objective-engine` journal | same | Typed rejections are durable, not thrown away |
| Wakeup reservations / admissions | `objective-engine` journal | same | Idempotency keys prevent duplicate model turns |
| Swarm membership (`swarm_enter`/`swarm_exit`) | `@local/systemone` decisions.js, **process-local `Set`** | **not durable** | The engine treats swarm membership as an ephemeral gate; it re-requires `swarm_enter` after restart instead of pretending membership survives |
| Team roster/task board | `@deepseek-ai/dsh-experimental-agent-team` Lead session log | durable, CAS | Phase 0 registry only; not the Phase 1 registry |
| Schedule tasks | `@deepseek-ai/dsh-schedule` | durable, at-least-once delivery | Engine may use the schedule **service** for cadence in Phase 2; deliveries are events, never authority |
| Goal | `@deepseek-ai/dsh-goal` session log | durable | Deliberately unused by the engine (Section 5.6) |

### 1.3 Where the two record types live (and why not elsewhere)

The user's two message types become **two record types in one registry**, not two queues:

- an **Objective** is created once, owns criteria/budget/priority, and is closed only by the verifier-gated, human-acknowledged completion transition;
- a **WorkItem** is progress: either a dispatchable `work-order` under an objective, a non-dispatchable `status-report` (with evidence), or a `heartbeat` (liveness only, never progress evidence).

They cannot live in the goal service because `dsh-goal` intentionally keeps **one current goal per session**, its completion authority is the calling model, and its round driver is same-session only (verified: `dsh-goal` README "One current goal"; `dsh-tool-goal` README "No independent evaluator"). They cannot live only on the team board because the board has four statuses, advisory write scopes, no budgets and no verification model (verified: `dsh-experimental-agent-team` README "Experimental prototype"; `dsh-tool-agent-team` README). They cannot live in the session log because plugin custom events are experimental-package-only (`appendPluginRecord` is experimental-subtree gated) and unknown non-ignorable event types are refused on read. So the registry is the engine's own durable journal; Phase 0 approximates it on the team board with explicit, documented loss of enforcement.

### 1.4 What `swarm_assign` is and is not

`swarm_assign(stage, needs?, context?, candidates?)` is implemented in `systemone-plugin/index.js` (tool) and `systemone-plugin/lib/decisions.js` (`swarm.assign`, lines 1003–1049): it sends one `choice` question over the configured persona catalog (`swarm.personas`) and returns `{ persona, description, instructions, choices, latencyMs }`. **Its role is unchanged by this design.**

- It **is** the stage-assignment authority: the manager calls it for every stage and passes the returned persona to `objective_dispatch` (or to a `subagent` call in Phase 0/fallback).
- It **is not** a message classifier. No code in the engine or the manager routes human input through `swarm_assign`; `objective_classify` is a separate Mammoth question over the fixed `[new_objective, attach:<id>, progress, not_work, none_fit]` catalog (Section 3).
- It **is not** a completion judge. The engine's completion gate never reads a `swarm_assign` answer; only verification records and human acks.
- Its persona catalog is extended (not replaced) with `objective-manager` and `verifier` entries so it can route replanning and verification stages; the five existing personas stay untouched.

### 1.5 What "new agent type" means concretely

| Piece | Artifact | Why it is needed |
|---|---|---|
| Control loop | `objective-engine/` new local bundle + `objective-engine/cordis.patch.yml` row `objective-engine` | The loop must be a plugin/host service (the `dsh-goal-round-driver` pattern: idle-only rounds, cap, human resume, race fences, fail-closed teardown), not a persona prompt and not the scheduler alone |
| Role identity | `systemone.swarm.personas.objective-manager` and `.verifier` in the profile patch row `systemone` | `swarm_assign` can route stages to these roles; the manager prompt is injected by the preset, not by this catalog |
| Capability envelope | `preset-objective-manager` and `preset-verifier` rows in `dsh-personas/cordis.patch.yml` | A session is the only thing that can own a turn; presets are the only owner of scoped tool rows; the manager must be a runtime root to receive human authority |
| Decision seam | `ctx.provide('systemone', …)` added in `systemone-plugin/index.js` | The engine calls `decide()` without duplicating the client, and without the decision layer writing anything |
| Deployment config | profile patch row `objective-engine`, plus additions to row `systemone` (`swarm.orchestratorTools`, `swarm.personas`, `swarm.presets`) | This profile replaces row config wholesale; deployment values belong in the profile patch (existing pattern documented in `systemone-plugin/README.md` and the row's own comments) |

---

## 2. Data model and wire format

All records are plain lossless JSON. The journal is the source of truth; every view is a fold. Timestamps are ISO-8601 UTC strings; ids are lower-kebab `obj-<26-char-base32>`, `itm-<…>`, `ver-<…>`, `wake-<…>`, `evt-<seq>`; revisions are positive integers starting at 1. Schema tag is `opm/v1` on every record and event.

### 2.1 Objective record

```json
{
  "schema": "opm/v1",
  "id": "obj-01jqk3m9f4t7w2x8b6c5d1e0rz",
  "revision": 3,
  "createdAt": "2026-11-07T16:02:11.184Z",
  "updatedAt": "2026-11-07T17:14:02.009Z",
  "statement": "Ship the objective-engine Phase 1 bundle with the nine Stage A conditions enforced.",
  "criteria": [
    {
      "id": "c1", "statement": "Plugin loads in the desktop profile and registers the eleven tools",
      "check": { "kind": "command", "command": "pnpm test", "cwd": "objective-engine", "expectedExitCode": 0 },
      "requiresHumanAck": false
    },
    {
      "id": "c2", "statement": "Human approves the operator runbook",
      "check": { "kind": "human-ack", "prompt": "Approve the runbook?" },
      "requiresHumanAck": true
    }
  ],
  "criteriaVersion": 1,
  "owner": { "kind": "agent", "sessionId": "<root session id>", "presetId": "objective-manager" },
  "creator": { "kind": "human", "via": "objective_create", "rootSessionId": "<root session id>" },
  "priority": 2,
  "scope": { "kind": "paths", "paths": ["objective-engine/", "plugin-selftest/"] },
  "budget": {
    "rounds": { "used": 2, "max": 12 },
    "tokens": { "used": 182000, "max": 2000000 },
    "wallTimeMs": { "used": 4311000, "max": 86400000 },
    "items": { "used": 1, "max": 16 },
    "verifierRuns": { "used": 0, "max": 6 },
    "concurrency": { "used": 0, "max": 2 }
  },
  "state": "active",
  "blockedReason": null,
  "armed": true,
  "lastEventSeq": 41
}
```

Field rules:

| Field | Rule |
|---|---|
| `statement` | non-empty, ≤ 4000 chars; must name an end state, not an activity ("ship X", not "work on X") |
| `criteria` | non-empty array, 1–12 entries; each has `id` (`c1`…), `statement`, `check`, `requiresHumanAck`; **creation is rejected** when `criteria` is missing, empty, or has no mechanical check and no human-ack check |
| `check.kind` | `command` (`command`, `cwd`, `expectedExitCode`, optional `timeoutMs`), `artifact` (`path`, optional `sha256`), `human-ack` (`prompt`). This is the closed vocabulary in `opm/v1`; a new kind is a schema version bump |
| `owner` | exactly one runtime-root agent session; `owner.sessionId` cannot change except by a human-authorized `objective_control reassign` (Phase 2, default off) |
| `creator` | `{kind:'human'}` or `{kind:'agent', sessionId}` (agent-proposed only behind a config flag, Section 6.3) |
| `priority` | 0 (human-urgent) … 9 (background); default 5; queue ordering is priority then age |
| `scope` | `{kind:'paths', paths:[…]}` (Phase 1) or `{kind:'worktree', path, branch, baseCommit}` (Phase 2); used for isolation admission |
| `budget` | six counters as above; `max` values are fixed at creation except a human-authorized `budget-raise` command (Section 4.1) |
| `state` / `blockedReason` | Section 4; `blockedReason` is `{code, detail, at}` or null; codes are stable lower-kebab |
| `armed` | false after restart / any pause; dispatch requires true; only explicit human resume sets true |
| `lastEventSeq` | last journal event applied to this record (diagnostics; not authority) |

Criteria edits: `objective_control edit-criteria` creates a **new objective revision** with `criteria.version` incremented (`criteriaVersion` field, default 1); it resets every verification record for that objective to `superseded`, sets `armed=false`, and requires explicit resume — an edit can never preserve an old "verified" claim.

### 2.2 WorkItem record

```json
{
  "schema": "opm/v1",
  "id": "itm-01jqk4aa7q0m3n5v9x2c8b1dft",
  "revision": 4,
  "objectiveId": "obj-01jqk3m9f4t7w2x8b6c5d1e0rz",
  "kind": "work-order",
  "createdAt": "2026-11-07T16:10:00.000Z",
  "createdBy": { "sessionId": "<manager session>", "tool": "objective_plan" },
  "title": "Load the plugin in the desktop profile",
  "detail": "Install the bundle, add the row, verify the tools register.",
  "assignedPersona": "architect",
  "assignedChild": { "sessionId": "<child session>", "presetId": "architect", "dispatchedAt": "…" },
  "acceptance": ["tool list contains objective_create", "no loader error in the host log"],
  "evidence": [
    { "kind": "command", "command": "dsh --profile desktop …", "exitCode": 0, "stdoutSha256": "…", "at": "…" }
  ],
  "state": "dispatched",
  "attempt": 1,
  "link": { "criterionIds": ["c1"] }
}
```

Kinds and validity:

| `kind` | Dispatchable | May carry evidence | Counts toward objective progress | Notes |
|---|---|---|---|---|
| `work-order` | yes | yes (on completion) | yes | the only kind the engine dispatches; must have `acceptance` and `link.criterionIds` |
| `status-report` | no | yes | only when linked to a criterion by a verifier/manager | filed by a worker or verifier; cannot create a work order; body is evidence, not a command |
| `heartbeat` | no | no | never | liveness only; if only heartbeats arrive for `stallTimeoutMs`, the item is `failed` (stall), never "progressing" |

Rules: one child session per work-order (`assignedChild.sessionId` unique across the journal); `attempt` increments on reassignment (a failed item is terminal and a **new** item id is created — ids are never reused); a `status-report` referencing an objective that is `verifying|awaiting-human|completed|cancelled|blocked` is rejected with `objective-closed` except in `verifying` where it is appended as extra evidence and marked `late-evidence` (never reopens the objective by itself).

### 2.3 Verification record

```json
{
  "schema": "opm/v1",
  "id": "ver-01jqk5cc1r8p4s6w0y3d9e2ghv",
  "revision": 2,
  "objectiveId": "obj-01jqk3m9f4t7w2x8b6c5d1e0rz",
  "criteriaVersion": 1,
  "criterionIds": ["c1", "c2"],
  "commit": "9f2c1d4e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d",
  "workspaceClean": true,
  "requestedBy": { "sessionId": "<manager session>", "tool": "objective_verify" },
  "requestedAt": "…",
  "verifier": { "sessionId": "<verifier child>", "presetId": "verifier", "parentSessionId": "<manager session>" },
  "evidence": [
    {
      "criterionId": "c1",
      "kind": "command",
      "command": "pnpm test",
      "cwd": "objective-engine",
      "exitCode": 0,
      "stdoutSha256": "…",
      "stdoutExcerpt": "…",
      "at": "…"
    }
  ],
  "verdict": { "kind": "approve", "reason": "All mechanical criteria pass at the pinned commit", "at": "…" },
  "ack": null,
  "state": "approved"
}
```

Rules: `commit` is the resolved full commit object name recorded **before** verification starts; the verifier may only test that commit (fresh worktree in Phase 2; clean checkout in Phase 1); every `criterionIds` entry needs exactly one evidence entry with matching `criterionId` (mechanical) or an ack flag (judgment); `verdict.kind` ∈ `approve | reject | inconclusive`; `ack` is `{by:'human', rootSessionId, at, messageId}` and is only recorded through `objective_ack` in a root session whose current turn contains a direct human message. A record whose `criterionIds` is a strict subset of the objective's criteria is an **advisory verification**: it can produce feedback and reopen work, but it can never complete the objective; completion requires a final record covering every criterion (guard O6). A `reject` verdict reopens the objective (`state=active`) with the item(s) reopened as **new** work; `inconclusive` (verifier died, wrong commit, dirty workspace, missing evidence) leaves the objective in `verifying` for one re-request within budget, then blocks with `verification-failed`.

### 2.4 Event journal schema

One JSON object per line, append-only. The fold accepts a line only when `seq` is exactly the previous `seq + 1`, `schema` is `opm/v1`, and `type` is in the closed vocabulary.

```json
{
  "seq": 42,
  "schema": "opm/v1",
  "type": "item/dispatched",
  "at": "2026-11-07T17:20:00.000Z",
  "actor": { "kind": "agent", "sessionId": "<manager session>", "presetId": "objective-manager" },
  "idempotencyKey": "opm:v1:dispatch:obj-…:itm-…:1",
  "expectedRevision": { "objective": 3, "item": 2 },
  "resultRevision": { "objective": 3, "item": 3 },
  "payload": { "assignedChild": { "sessionId": "…", "presetId": "architect" } },
  "hash": "sha256(prev.hash || canonical-json-without-hash)"
}
```

Closed event vocabulary (`opm/v1`):

| Family | Types |
|---|---|
| Engine | `engine/started`, `engine/paused`, `engine/resumed`, `engine/degraded`, `engine/overloaded`, `engine/recovered` |
| Objective | `objective/created`, `objective/edited`, `objective/state-changed`, `objective/budget-changed`, `objective/verification-requested`, `objective/verification-verdict`, `objective/ack-recorded`, `objective/closed` |
| Item | `item/created`, `item/dispatched`, `item/reported`, `item/accepted`, `item/rejected`, `item/failed`, `item/cancelled` |
| Verification | `verification/requested`, `verification/evidence`, `verification/verdict`, `verification/superseded` |
| Wakeup | `wakeup/reserved`, `wakeup/admitted`, `wakeup/expired`, `wakeup/superseded` |
| Classification (advisory only) | `classification/proposed` (always `payload.applied:false`; never a command) |
| Admission | `admission/rejected`, `admission/queued`, `admission/dequeued` |

`actor.kind` ∈ `human | agent | engine`. The fold rejects an event whose `actor.kind` is not permitted for that type (Section 4) and any event whose `expectedRevision` does not equal the derived revision. **Proposal-typed events (`classification/proposed`) are stored in a separate in-memory/journal-served advisory table and are not part of the command fold**; a replay can ignore them entirely.

### 2.5 Idempotency key scheme

Every mutating command carries `idempotencyKey`; the engine derives one when the caller omits it, and the derivation is deterministic:

| Command | Key |
|---|---|
| create | `opm:v1:create:{objectiveId}` (the objective id is minted once per command attempt and returned on retry) |
| plan/add item | `opm:v1:item:{objectiveId}:{itemId}` |
| dispatch | `opm:v1:dispatch:{objectiveId}:{itemId}:{attempt}` |
| report | `opm:v1:report:{objectiveId}:{itemId}:{childSessionId}:{evidenceDigest}` |
| verdict | `opm:v1:verdict:{verificationId}` |
| ack | `opm:v1:ack:{objectiveId}:{criteriaVersion}` |
| wakeup prompt | `opm:v1:wake:{objectiveId}:{itemId}:{occurrence}` (`occurrence` is a monotonic integer kept in the journal) |
| schedule delivery (Phase 2) | `opm:v1:schedule:{taskId}:{occurrenceAtISO}` |

Rules: the journal keeps a `seen` index by key. Replay of a key with an **identical canonical payload** returns the original result and appends nothing. Replay with a **different payload** fails typed `idempotency-conflict`, appends `admission/rejected`, and never mutates. The key is committed before any acknowledgement is returned (`commit-before-ack`).

### 2.6 Durability, CAS, and restart

- **Commit-before-ack:** append line → `fsync` → apply to in-memory fold → return the tool result. A failed `fsync` returns `persistence-failed`, makes the engine `degraded` (read-only), and does not apply the mutation.
- **Snapshot:** every 128 events or on graceful dispose, write `snapshot.json` atomically (temp + fsync + rename) with `{lastSeq, hash, records}`; on load, replay `journal.jsonl` from `lastSeq+1`. A torn last line (JSON parse/CRC failure) is truncated and logged; if the snapshot hash is invalid or a gap precedes the tail, the engine refuses to serve (`corrupt-registry`) and exposes status — it never guesses.
- **CAS:** every command names `expectedRevision` for the records it touches; stale revisions are rejected `stale-revision` with the current view. The in-memory write chain is serialized (one mutation at a time), matching the `storageDomain` "one write chain per domain" discipline.
- **Single process:** the journal directory contains a `LOCK` file with pid/start time; a second engine instance refuses to start (`engine-locked`). Cross-process coordination is out of scope for Phase 1 and explicitly listed as a Phase 2 hardening item.
- **Restart reconstruction:** fold the journal; all `dispatched` items become `failed` with `reason: process-restart`; all `verifying` objectives return to `active` and their verification records are `inconclusive`; every non-terminal objective becomes `paused` with `blockedReason: process-restart` and `armed=false`; pending wakeups expire; the engine starts in `paused`, and only an explicit human `objective_system resume` followed by per-objective resume re-arms work (Section 5.5).

### 2.7 Storage layout (Phase 1)

```
$DSH_HOME/storages/objective-engine/
  journal.jsonl        # append-only commands, one canonical JSON object per line
  snapshot.json        # periodic full fold + hash
  PAUSED               # optional operator sentinel; existence forces paused on boot
  LOCK                 # pid + startedAt, single-writer guard
  evidence/<objectiveId>/<verificationId>/   # verifier evidence files (Phase 2)
```

Why not `ctx.storageDomain` in Phase 1: the domain form is the right long-term substrate (schema-validated, durable writes, `domain/changed`; it is what `dsh-schedule` uses), but it needs `@deepseek-ai/dsh-storage-domain` + `zod` imports vendored into the new linked bundle, which is an install-time risk in this offline profile. The journal above needs only `node:fs` and the two packages the existing local bundle already vendors (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`). **Decision:** Phase 1 ships the journal behind an `ObjectiveStore` interface (`append(events)`, `fold()`, `close()`); Phase 2 may swap in a `storageDomain` implementation without touching the service API. (Flagged as an implementation risk, not an invented DSH API.)

---

## 3. Message-type protocol

### 3.1 Deterministic boundary

A message becomes an **Objective** or a **WorkItem** only through an explicit tool call with an explicit `kind`, by an actor whose authority permits it. There is no prompt-prefix parser, no regex over human text, and no Mammoth call in the transition path.

| Input source | Deterministic path | Resulting record | Authority required |
|---|---|---|---|
| Human message in the owner (root) session, structured request | `objective_create` | Objective | exact runtime-root agent + a direct human message in the current turn (the `dsh-tool-goal` authority pattern) |
| Human message, follow-up on an existing objective | `objective_report {kind:'status-report'}` or `objective_plan` | WorkItem | same as above, or manager for `objective_plan` |
| Manager decomposing an objective | `objective_plan {action:'add'}` | `work-order` item | manager preset session that owns the objective |
| Worker/verifier finishing work | `objective_report` / `objective_verdict` | `status-report` / Verification | exact assigned child session, objective active |
| Heartbeat / liveness | `objective_report {kind:'heartbeat'}` | `heartbeat` item | assigned child |
| External producer (Phase 2 only) | `objective_intake` RPC with `producerId` + `kind` | Objective or item | configured producer allowlist |
| Human message, ambiguous/unstructured | `objective_classify` → proposal → the human or manager **then** uses one of the tool paths above | none by itself | proposal is advisory |

The manager prompt (injected by the `objective-manager` persona) states the rule plainly: *"You never decide that a message is an objective. You call `objective_classify` only to get a proposal, then either call `objective_create` (requires a human request) or attach the message as a status report; when the proposal is `ambiguous` or `none_fit`, ask the human. A classifier answer never changes anything."*

### 3.2 The Mammoth questions (exact)

`objective_classify` (manager tool, advisory) sends **one batched request** to the System One endpoint through the `systemone` service. State is bounded to 4000 chars (same `maxStateChars` discipline as the existing decision layer):

```json
{
  "state": {
    "channel": "human-message",
    "message": "<bounded text>",
    "active_objectives": [
      { "id": "obj-…", "statement": "<bounded 300 chars>", "state": "active", "criteriaCount": 2 }
    ]
  },
  "questions": {
    "message_type": {
      "type": "choice",
      "instructions": "Classify this human message for an objective-tracking system. new_objective means it states a new end state with completion criteria; progress means it advances or reports on an existing objective; objective_update changes an existing objective; not_work is unrelated to any tracked objective; none_fit means none of the labels describes it.",
      "criteria": {
        "new_objective": "States a new end state that needs its own acceptance criteria",
        "progress": "Reports or advances work already tracked under an objective",
        "objective_update": "Changes the statement, criteria, priority, or budget of an existing objective",
        "not_work": "Unrelated to any tracked objective",
        "none_fit": "The message does not fit any of these categories"
      }
    },
    "target_objective": {
      "type": "choice",
      "instructions": "If this message is progress or an objective_update, which objective does it target? Choose none when it targets a new objective or is not_work.",
      "criteria": {
        "obj-…": "<statement, bounded>",
        "obj-…": "<statement, bounded>",
        "none": "No existing objective applies"
      }
    },
    "is_objective": {
      "type": "noul",
      "instructions": "Is this message stating a new end state (a goal that can be completed and checked), as opposed to a step toward one? Answer with the probability that it is an objective.",
      "boundary": {
        "true": "The message states a new end state with an implied or stated completion check",
        "false": "The message only asks for a step, a question, or a fact within existing work"
      }
    }
  },
  "model": "<configured model id>"
}
```

(Choice labels are exactly the option ids the model returns; `target_objective` omits the label when only one objective is active or when the message type cannot target one. `active_objectives` is capped at 5 by priority; if more are active, the engine adds `"none"` and requires manual attach.)

**Decision rule** (implementation-side, deterministic given the answers; recorded in the classification journal):

| Observed | Proposal |
|---|---|
| `message_type == new_objective` and `noul.is_objective ≥ 0.70` and `target_objective == none` | `new_objective` |
| `message_type == progress` or `objective_update`, `target_objective` is a known active objective, and `noul.is_objective < 0.60` | `attach:<objectiveId>` (with `update` flag when `objective_update`) |
| `message_type == not_work` and `noul.is_objective ≤ 0.30` | `not_work` |
| `noul.is_objective` in `[0.40, 0.70)`, or `message_type` conflicts with the noul, or the chosen label's probability < `classification.choiceFloor` (0.35), or the response's optional `confidence` < `classification.confidenceFloor` (0.30) | `ambiguous` |
| `message_type == none_fit`, or no label reaches the floor | `none_fit` |

Thresholds live in the row config (`objective-engine` row): `objectiveProbability` 0.70, `progressProbability` 0.60, `choiceFloor` 0.35, `confidenceFloor` 0.30, `margin` 0.10 (top-2 label probability must differ by at least this, else `ambiguous`). They are **proposal** thresholds; the manager still chooses the action.

**Journal fields for proposals** (`classification/proposed` event body; stored verbatim):

```json
{
  "kind": "advisory",
  "applied": false,
  "at": "…",
  "requestId": "cls-…",
  "input": { "messageSha256": "…", "messageChars": 412, "activeObjectiveIds": ["obj-…"] },
  "decisionPlane": {
    "endpoint": "http://127.0.0.1:8008/v1/systemone",
    "modelRequested": "<decision-model-id>",
    "modelAnswered": "<served-model-id>",
    "latencyMs": 190,
    "answers": {
      "message_type": { "choice": "new_objective", "probabilities": { "new_objective": 0.81, "progress": 0.12 }, "confidence": 0.72 },
      "target_objective": { "choice": "none", "probabilities": { "none": 0.88 } },
      "is_objective": { "noul": 0.77 }
    },
    "unmatched": []
  },
  "thresholds": { "objectiveProbability": 0.7, "progressProbability": 0.6, "choiceFloor": 0.35, "confidenceFloor": 0.3, "margin": 0.1 },
  "proposal": { "kind": "new_objective", "targetObjectiveId": null, "reason": "choice+noul agree" },
  "ambiguity": null
}
```

**Hysteresis and "none fits":** the manager may call `objective_classify` at most twice per human message. If both calls propose the same `kind`/target, the manager may act on it; if they disagree, the proposal is `ambiguous`. `none_fit`/`ambiguous` always resolves to `ask_user_question` (root session; the only context where a human interaction is admitted — verified `dsh-user-questions`: "A live child cannot open a human interaction") or, in headless deployments with no answerer, to `not_work` with a durable journal note. **Never** does an absent classifier answer default to `new_objective`.

### 3.3 Invariants and the tests that pin them

1. **No journaled answer can mutate state.** The only code that writes the command journal is the service's mutation methods; the classification path calls `appendAdvisory()` on the advisory table only. Architecture test: `lib/transition.js` must not import `lib/classify.js`, and `objective_classify` must not share a module with any `append()` call (enforced by a test that scans imports).
2. **Contradictory replay gives identical state.** Replay a journal whose classification entries are replaced by contradictory answers: all nine condition tests still pass; the command fold's hash is identical (test T1.1).
3. **Outage does not block deterministic work.** With the decision endpoint unreachable, `objective_create`, `objective_plan`, `objective_dispatch`, `objective_report`, `objective_verify`, `objective_ack` all work; only `objective_classify` returns a structured `classifier-unavailable` and journals it (test T1.2). The manager's rule is: if the human's intent is explicit, do not classify at all.
4. **Duplicate delivery executes once.** Delivering the same tool call or wakeup twice (same idempotency key) yields one event and the same result (test T1.3).
5. **No proposal can create or close a record.** `classification/proposed` events are ignored by the fold; a forged one cannot be used to synthesize a command (test T1.4).

---

## 4. State machine

Three state machines share one fold. Every transition is an event with a closed actor set; the table below is the executable specification for `lib/transition.js` (one function per command; no transition is reachable from any other path).

### 4.1 Objective lifecycle

States: `active`, `paused`, `verifying`, `awaiting-human`, `blocked`, `completed`, `cancelled`.

| # | From → To | Trigger event | Actors allowed | Guards (all must hold) | On violation |
|---|---|---|---|---|---|
| O1 | ∅ → `active` | `objective/created` | human (root turn) | complete record, criteria non-empty and well-formed, budget ≥ minimum, admission pass, idempotency new | typed `admission-rejected` / `record-incomplete`; nothing created |
| O2 | `active` → `paused` | `objective/state-changed` | human; engine (kill/overload/restart) | none beyond CAS | `stale-revision` / `unauthorized` |
| O3 | `paused` → `active` | `objective/state-changed` | **human only** (explicit resume) | budget not exhausted; `armed` set true; swarm re-entered by owner session | `budget-exhausted` (must raise budget first); `owner-offline` |
| O4 | `active` → `verifying` | `objective/verification-requested` | manager (root session owning objective); engine (auto-request when all linked items accepted and `autoVerify` true) | ≥1 criterion; all work-order items linked to the requested criteria are `accepted` (a request naming a strict subset creates an **advisory** verification record that cannot complete the objective); budget permits a verifier run; commit recorded; producer ≠ verifier (by construction, engine starts verifier) | `not-ready` (lists open items), `budget-exhausted` |
| O5 | `verifying` → `active` | `objective/verification-verdict` (reject) | engine only (from a verifier verdict) | verdict `reject`; retry count < `maxVerificationRejects` (2) | at the limit → `blocked: verification-failed` |
| O6 | `verifying` → `awaiting-human` | `objective/verification-verdict` (approve) | engine only | verdict `approve`, commit matches, workspace clean, the record covers **all** criteria with evidence, and ≥1 criterion `requiresHumanAck`; a record covering only a subset is advisory and cannot use O6 | subset record → advisory only; missing ack criterion → `inconclusive` |
| O6b | `verifying` → `completed` | `objective/verification-verdict` (approve) | engine only | verdict `approve`, commit matches, workspace clean, all criteria covered with evidence, and **no** criterion `requiresHumanAck` (purely mechanical objective) | any judgment criterion present → O6 instead; missing evidence → `inconclusive` |
| O7 | `verifying` → `blocked` | `objective/state-changed` | engine only | verdict `inconclusive` twice, verifier died, wrong commit, dirty workspace, or evidence missing | — |
| O8 | `awaiting-human` → `completed` | `objective/ack-recorded` | human (root turn, direct human message) | every `requiresHumanAck` criterion has an ack with matching `criteriaVersion`; no other ack outstanding; objective armed | `ack-incomplete`, `unauthorized` |
| O9 | `awaiting-human` → `active` | `objective/ack-recorded` (send-back) | human | reason provided; verification records for criteria reset to `superseded`; `armed=false` until resume | — |
| O10 | `active` → `blocked` | `objective/state-changed` | engine only | one of: budget exhausted; `stallTimeoutMs` with no progress event; `maxConsecutiveWorkerFailures` (3); `overload` with no dispatch for `maxQueueAgeMs` | reason code recorded |
| O11 | `blocked` → `active` | `objective/state-changed` | **human only** | reason was `budget-exhausted` → budget raised in the same or prior human command; reason was `process-restart` → explicit resume; reason was `verification-failed` → criteria edited or attempts reset by human | `budget-exhausted` stays until raised; never auto-retried |
| O12 | any non-terminal → `cancelled` | `objective/closed` | human only (manager may request, engine converts to `requested` note; human confirms) | none | `unauthorized` |
| O13 | `completed` → anything | — | **no actors** | terminal | always `objective-terminal` |
| O14 | `cancelled` → anything | — | **no actors** | terminal | always `objective-terminal` |

Procedure for criteria edits: `objective_control edit` with `criteria` produces `objective/edited` (`criteriaVersion++`), marks all verification records `superseded`, sets `armed=false`, state `paused` if it was `verifying|awaiting-human`; a human resume is required. Old evidence is retained for audit but cannot satisfy the new criteria.

### 4.2 WorkItem lifecycle

States: `queued`, `dispatched`, `reported`, `accepted`, `rejected`, `failed`, `cancelled`.

| # | From → To | Trigger | Actors | Guards |
|---|---|---|---|---|
| I1 | ∅ → `queued` | `item/created` | manager | objective `active`, admission pass, `items.used < max`; a work-order must link ≥1 criterion and carry `acceptance` |
| I2 | `queued` → `dispatched` | `item/dispatched` | manager (via `objective_dispatch`) | admission: global in-flight < `maxInFlightItems`, per-objective concurrency < `maxConcurrency`, budget ok, scope admission (no conflicting writer), `assignedPersona` in configured catalog, `armed` |
| I3 | `dispatched` → `reported` | `item/reported` | **assigned child session only** | child session id == `assignedChild.sessionId`; objective `active`; expected revision; evidence ≤ 3 items |
| I4 | `reported` → `accepted` | `item/accepted` | manager **or** engine | manager ≠ reporting session and manager ≠ reporting child (producer cannot accept its own work); report summary non-empty; report evidence present; every entry of the item's `acceptance` list is addressed (a partial acceptance must state which entries are deferred). Item acceptance is the **plan-level** judgment; the objective-level criterion gate is the verifier record, never this transition |
| I5 | `reported` → `rejected` | `item/rejected` | manager | reason non-empty; budget `rounds` increments; a rejected item is terminal |
| I6 | `dispatched` → `failed` | `item/failed` | engine | `subagent/end` stopReason ∈ `{error, aborted, max-tokens, refusal}` OR watchdog `stallTimeoutMs` OR process restart |
| I7 | `queued` → `cancelled` | `item/cancelled` | manager, human, engine | objective paused/blocked/cancelled/kill |
| I8 | `dispatched` → `cancelled` | `item/cancelled` | engine | kill/pause; engine additionally cancels the child with `{kind:'hook', reason:'objective-engine: pause'}` (verified closed cancel-cause union) |
| I9 | `reported` → `cancelled` | `item/cancelled` | human, engine | objective closed/kill |
| I10 | `failed|rejected|accepted|cancelled` → anything | — | none | terminal; reassignment creates a **new item id**, never reuses |

### 4.3 Verification lifecycle

`requested → evidence → verdict → (ack)`. The record is immutable except by the listed events; `state` is derived: `requested | approved | rejected | inconclusive | superseded | acked`.

- `objective/verification-requested` creates a `requested` record, resolves commit (`git rev-parse HEAD` via `ctx.subprocess` in the owner working directory; for non-repo scope, a manifest digest computed by the verifier), and starts the verifier child (Section 7.3). Only the engine can start a verifier; the manager cannot pass a verifier session id.
- `verification/evidence` is accepted only from the verifier child registered on the record, only for that record's criteria/commit, and only while state is `requested`.
- `verification/verdict` is accepted only from the same verifier child; `approve` requires evidence for every criterion and `workspaceClean=true`; `reject` requires at least one failed criterion with evidence; otherwise `inconclusive`.
- `objective/ack-recorded` is accepted only from a runtime-root session whose current turn contains a **direct human message** (`turnBoundaryOf(session)` + admitted `{kind:'user'}` source, the `dsh-tool-goal` authority pattern).
- A producer session id, producer preset id, or producer-parented child cannot be the verifier on the same record; the engine asserts `verifier.sessionId !== any(producerSessionIds)` and `verifier.presetId !== producerPresetId` and records the comparison in the event.

### 4.4 Engine lifecycle

`recovering → paused → running → paused|degraded`. Boot always ends in `paused` (fail-closed, even when the previous process was running). `running → paused` on human `objective_system pause`, kill sentinel, overload invariant breach, or journal write failure (`degraded` is terminal until restart). `paused → running` only by human `objective_system resume` in a root-turn with a direct human message. The engine never resumes itself.

### 4.5 Forbidden transitions (enforced at the transition function, with tests)

| Forbidden | Enforced because |
|---|---|
| Producer → `completed` | no command from a producer actor reaches O8; completion requires `ack-recorded` + `verification-verdict` |
| Verifier → create / complete / pause / cancel / budget-change | verifier's only allowed mutation is `verification/evidence|verdict` on its own record |
| Classifier/proposal → any state change | proposals are not command events; the transition dispatcher rejects unknown or advisory types |
| Worker → `accepted` on its own item | I4 actor check (`actor.sessionId !== producedBy.sessionId`) |
| Cancelled objective accepts progress | `objective-terminal` guard on I1/I3/I5 |
| Blocked objective dispatches work | I2 requires objective `active` and `armed` |
| Retry after budget exhaustion | O11 requires a human budget-raise event before resume; no timer path calls it |
| Auto-completion on verifier approve without ack | O8 requires all `requiresHumanAck` criteria |
| Auto-resume after restart | boot sets `paused` + `armed=false`; only human commands change them |
| Same item id re-dispatched | I2 accepts only `queued` items; failed terminal items are never reopened |

---

## 5. Scheduling and wakeups

### 5.1 Event sources (the complete list)

Work starts **only** on one of these events. There is no timer that spends tokens on a schedule by itself, and the agent never schedules its own next turn.

| Source | Mechanism | Verified? |
|---|---|---|
| Human message in the owner session | normal turn; if it is a tool call, the engine mutation runs inside it | yes |
| Child settlement | `ctx.on('subagent/end', (identity, parent) => …)` — emitted by `@deepseek-ai/dsh-subagent` for every tracked activation (`subagent/start`/`subagent/end`; `stopReason` ∈ `completed/error/aborted/max-tokens/refusal`) | yes (lib/index.js lifecycle emitter; README "Lifecycle events are observe-only") |
| Child/owner idle | `agent/status` event + `agent.status === 'idle'` check before a wakeup; `whenIdle()` is used only in teardown, not for polling | yes (dsh-agent README) |
| Engine deadline sweep | one coarse timer (default 60 s) that evaluates **budget/wall-clock/stall/queue-age** deadlines and emits at most the due transitions; it makes no model call unless an item is dispatchable and the owner is idle; all counters come from the fold/tokenMeter (no model calls) | yes (cordis timer available; design-side code) |
| Human/schedule tick for cadence | Phase 2: engine creates a `dsh-schedule` task via the **service** (not the model tool) for a per-objective cadence; delivery enters the target session as a user-role message with producer kind `schedule` | yes (dsh-schedule README/API) |
| Explicit resume / pause / ack | `objective_system`, `objective_control`, `objective_ack` tool calls | yes |
| Restart | journal fold (never wakes anything; ends paused) | yes |

Not an event source: `dsh-goal-round-driver` rounds. The engine does not mount goal tools, does not create goals, and does not rely on the goal driver. This is deliberate (Section 5.6).

### 5.2 The pump

One serialized `pump()` runs on every event (and on the sweep); concurrent calls coalesce to at most one extra run. Each run:

1. Reads the fold at the current revision.
2. Selects at most one action by priority: (a) human ack pending → remind once; (b) verifier verdict to process → engine-only transition; (c) failed item → manager wakeup with the failure summary; (d) ready work-order + owner idle + admission free → dispatch wakeup (the manager must call `objective_dispatch` itself; the engine never dispatches without the manager's tool call); (e) due deadline → block/expire; (f) nothing → return without touching the model.
3. Reserves a wakeup: append `wakeup/reserved` with a fresh `occurrence` and idempotency key, CAS on the objective revision.
4. If the owner agent is idle, calls `agent.followup({content:[…engine prompt…], source:{kind:'objective-engine', form:'wakeup', objectiveId, itemId, occurrence}})`. `followup` is documented to queue a next-turn prompt **and wake the driver** (dsh-agent README). If the owner is running, the reservation stays pending and is attempted at the next idle edge; it is never queued twice.
5. On the owner's next admitted step, the engine's `agent/pre-step` fence sees the claimed messages. It verifies the wakeup key has not been admitted before and the objective revision still matches; otherwise it returns `{kind:'reject'}` for that step (the goal-round-driver race-fence pattern). Human messages in the same batch always win: if a human message is present, the fence does not reject; it marks the wakeup `superseded`.

**Coalescing:** at most one pending wakeup per objective and one per owner session; a newer event for the same objective replaces the pending prompt (the older reservation is `wakeup/superseded`, key never re-used). This is why a burst of child completions produces one model turn, not one per child.

### 5.3 Prompt templates (deterministic, JSON-quoted)

All engine prompts are one text block, prefixed with an idempotency header so a duplicate delivery is detectable, and include no free-form history:

```
[OBJECTIVE ENGINE WAKEUP occurrence=17 objective=obj-… revision=3]
Objective: "…" (state=active, rounds 2/12, tokens 182000/2000000)
Ready work: item itm-… "…" (persona=architect, criterion c1)
Do this in order: (1) call swarm_assign for the stage and use its persona; (2) call
objective_dispatch with the item id and that persona; (3) do not work on files yourself.
If this wakeup is a duplicate (occurrence already acknowledged), reply "duplicate" and stop.
```

Other templates: `VERIFICATION RESULT` (verdict + failing criteria + next action: replan or re-request within budget), `ACK PENDING` (criteria needing human ack; ask the human in this root session), `OBJECTIVE BLOCKED` (reason code; resume requires a human command), `ENGINE PAUSED` (no work; do not call objective tools except status). Templates live in `lib/prompts.js`, are versioned (`template:1`), and are covered by snapshot tests so a template change cannot silently alter protocol semantics.

### 5.4 Dedupe, missed occurrences, late deliveries

- Wakeup key includes `occurrence`; `wakeup/admitted` is written by the pre-step fence when the engine-authored message actually enters a model step. A duplicate `subagent/end` or a duplicated `followup` with the same key cannot produce a second admitted step.
- Schedule deliveries (Phase 2) are at-least-once and, after downtime, only the latest missed occurrence is delivered (verified `dsh-schedule` README). The engine treats a delivery whose `occurrence_at + maxLatenessMs` < now as expired (`wakeup/expired`), and a duplicate `(taskId, occurrence_at)` as one event. Delivery is an **event**, never authority.
- Audit: the journal keeps one line per reservation/admission/expiry; `objective_status` shows the last 20.

### 5.5 Restart and re-arm

On load: fold → any torn tail truncated → `engine/started` (process mode `recovering`) → transition to `paused`; every active objective gets `armed=false` and, for `dispatched` items, a terminal `failed:process-restart`; pending wakeups expire. The engine **never** enqueues a model prompt at boot. The human can then run `objective_system resume` (engine `running`) and `objective_control resume` per objective (or `resume all` with an explicit `confirmAll:true` in a root turn with a direct human message). This is the concrete implementation of Stage A condition 6 ("re-arm only on explicit resume") and it matches the goal driver's own rule: mounting/reloading never arms a goal; only a human resume does.

The owner session must also re-enter swarm mode after a restart (`swarm_enter`), because `@local/systemone` keeps swarm membership only in an in-process `Set` (`decisions.js`: `const swarmSessions = new Set()`). The engine does not treat membership as durable and does not attempt to restore it; the `OBJECTIVE ENGINE PAUSED` prompt tells the manager to call `swarm_enter` before resuming.

### 5.6 The one-goal-per-session limit

The engine does not use `dsh-goal`. `dsh-goal`'s one-current-goal rule is a package constraint, not a design target: objectives are many, long-lived, and owned by the registry. Consequences and how each is handled:

- The manager preset does **not** mount `tool-goal` (it currently mounts nothing goal-related; the host `tool-goal` row is disabled by the Web layer, and the custom presets don't mount it). So the manager cannot accidentally create a competing goal.
- The engine's own `objective_status` is the source of truth for "what am I working on"; `/goal` remains available in sessions that mount it, for ordinary long tasks, unrelated to the registry.
- Phase 2 optional, default **off**: a display-only "primary objective mirror" can create at most one `dsh-goal` per manager session for the UI goal bar; it is written by a separate consumer, never read by the engine, and never counts as completion authority. If this confuses the completion gate in practice, drop it (open decision 11.5).

### 5.7 Goal-round-driver pattern compliance checklist

The engine is modeled on `dsh-goal-round-driver` (verified README): idle-only starts; a reservation before the prompt; race fences before/after downstream `agent/pre-step`; a durability checkpoint (engine appends the wakeup event and `await` its fsync before following up); fail-closed teardown (close admission, cancel active work with `hook` cause, await quiescence); no auto-retry on abnormal failure; leader/follower one-at-a-time. Deviations (documented): the engine owns many objectives rather than one goal; its wakeups are host-driven `followup`s rather than goal-message rounds; it caps by budget and admission instead of a single round number.

---

## 6. Admission control and overload model

### 6.1 The correction Stage A demands

**Objective count is an admission bound, not a load bound.** One objective can generate unbounded work (many items, huge token spend, many verifier runs). Load is therefore measured and enforced from independent signals; the active-objective cap only keeps the human/manager UI tractable and the queue bounded. The overload answer is the tuple `(active objectives, in-flight items, verifier backlog, token rate, dispatch rate)` — not `count(objectives)`.

### 6.2 Limits (deployment defaults; all in row `objective-engine` config)

| Limit | Default | Meaning |
|---|---|---|
| `maxActiveObjectives` | 3 | objectives in `active|verifying|awaiting-human` (not queued, not blocked) |
| `maxQueuedObjectives` | 32 | durable admission queue depth; rejection is typed and durable |
| `maxObjectivesPerOwnerSession` | 3 | fairness / one session cannot monopolize |
| `maxItemsPerObjective` | 16 | item creation gate |
| `maxActiveItemsPerObjective` | 2 | concurrent dispatches under one objective |
| `maxInFlightItemsGlobal` | 4 | host-wide dispatch concurrency |
| `maxConcurrentVerifierRuns` | 1 | verifier is a scarce, expensive resource; backlog is explicit |
| `maxVerifierRunsPerObjective` | 6 | budget counter (also per day: 6) |
| `maxVerifierRunsPerObjectivePerDay` | 6 | rate cap |
| `maxDispatchesPerHour` | 12 | dispatch rate, host-wide |
| `maxRoundsPerObjective` | 12 | admitted engine prompts; the model-turn budget |
| `maxTokensPerObjective` | 2,000,000 | `tokenMeter.measure(session).totalTokens` delta across owner+children baseline at creation (verified `ctx.tokenMeter`) |
| `maxWallTimePerObjective` | 86,400,000 ms | creation → completion/blocked |
| `stallTimeoutMs` | 1,800,000 ms | no evidence/heartbeat while dispatched |
| `maxConsecutiveWorkerFailures` | 3 | objective blocked `worker-failures` |
| `maxVerificationRejects` | 2 | objective blocked `verification-failed` |
| `maxQueueAgeMs` | 7 days | queued objective expires `queue-expired` |
| `classificationCallsPerHour` | 60 | advisory calls only; not on the control path |

The budget object in the Objective record is the enforcement source; limits above are the maxima that creation/admission accept. Any command that would exceed a max fails typed `admission-rejected` with `{limit, current}`.

### 6.3 Admission gates

Every creation path — human `objective_create`, agent-proposed (behind `allowAgentProposedObjectives`, default **false**), and external `objective_intake` (Phase 2, configured producers only) — passes the same gate:

1. **Authority:** human-authorized root turn (or allowlisted external producer with `producerId`); self-proposed objectives are admitted only as `proposed` records requiring a human approve command, never as `active`.
2. **Completeness:** statement, criteria (≥1 checkable), priority, owner, scope, budget — missing → `record-incomplete` (durable rejection).
3. **Capacity:** active/queued/per-owner caps; classify rate; engine not paused/degraded.
4. **Duplicates:** normalized statement hash + owner within 24h → `duplicate-objective` unless `allowDuplicate:true`.
5. **Scope conflict:** two *active* objectives claiming overlapping `scope.paths` are rejected `scope-conflict` (Phase 1's isolation admission; Phase 2 replaces this with worktree isolation, where overlapping scopes are allowed and merge serialization handles conflicts).

Rejection behavior: append `admission/rejected` with code/detail; return a typed error; **queue** the request only for the capacity case (`admission/queued`, durable) — the caller can retry with the same idempotency key later. A self-proposed objective that is rejected stays rejected (no retry loop).

### 6.4 Measured load, backpressure, fairness

- **Load snapshot** (recomputed on each pump, cheap): `inFlightItems`, `verifierQueueDepth`, `pendingWakeups`, `tokenRate15m` (delta of tokenMeter totals over a 15-min ring), `dispatchRate1h`, `pumpDurationMs`, `journalBytes`.
- **Backpressure:** when `inFlightItems >= maxInFlightItemsGlobal` or `verifierQueueDepth >= maxConcurrentVerifierRuns` or token rate exceeds `tokenRateSoftLimit` (default: 80% of the objective budget per hour), the engine stops emitting work-order wakeups (no dispatch) but keeps verification-result, failure, and ack handling; running children are not killed (the human can pause). `objective_dispatch` returns `admission-busy` with `retryAfterMs`; the engine does not wake the manager just to say "busy".
- **Overload alarm:** if a signal stays above 90% for two consecutive sweeps, append `engine/overloaded` (once per hour max) and expose it in status; no automatic model call.
- **Fairness:** ready work is ordered by objective `priority` (0 first), then `createdAt`, with aging: a queued objective gains one priority level every 6h up to 0. Within one objective, items are FIFO. No starvation: the oldest ready objective wins over a newer higher-priority one if it has waited ≥ `agingCapMs` (24h).
- **Kill switch:** `objective_system pause` (human, root turn) or the `PAUSED` sentinel or `objectives.pauseAll(reason)` service call: one journal append, engine `running → paused`, pump stops, every pending wakeup expires, every tracked child is cancelled with `{kind:'hook', reason:'objective-engine: pause all'}`, all tools except `objective_status` return `engine-paused`. The state is durable and the engine boots paused. `objective_system resume` is the only way back. This is "one action pauses all within one step and survives restart."

---

## 7. Execution and verification

### 7.1 Stage assignment (unchanged) and dispatch

1. The manager (root `objective-manager` session) receives a wakeup or a human request and decides the next stage.
2. It calls **`swarm_assign(stage, needs, context?)`** exactly as today. The answer is the assignment; the manager does not choose the persona itself.
3. It calls **`objective_dispatch(itemId, persona, brief, expectedRevision)`**:
   - engine verifies the objective/item are dispatchable, persona is in the configured persona catalog and matches the item's `assignedPersona` (or records it if unset), admission passes, and the item's `link.criterionIds` are covered by the brief's acceptance text;
   - engine resolves the pinned base commit (Phase 2: objective worktree base; Phase 1: current HEAD of the owner workspace) and records it on the item;
   - engine starts the child with `ctx.subagents.startActivation({ provider: 'spawn', label: item.title, request: { parent: managerAgent, prompt: [text block], agentPreset: persona, maxDepth: <worker cap> }, delivery: 'parent' })` (verified service signature and `request.agentPreset` in `dsh-subagent` lib; the tool-level documented equivalent is `agentPreset`/`allowedAgentPresets` in `dsh-tool-subagent` 0.2.2-rc.1). The engine records the returned `childId` on the item and journals `item/dispatched`.
4. The child works in the data plane. It is one child per work-order; it cannot dispatch further children (engine passes the worker delegation cap) and it cannot mutate objective state.
5. On `subagent/end` for a tracked child, the engine maps `childId → item`, reads `stopReason` and `lastAssistantMessage`, and records `item/reported` (completed/reported) or `item/failed`. If the child reported through `objective_report` before ending, that report is authoritative and the `subagent/end` only closes the item state.

**Fallback (required for Phase 0 and Phase 1 contingency):** if `ctx.subagents.startActivation` with `request.agentPreset` is unavailable or rejects, the manager dispatches through its mounted `tool-subagent` (configured with `allowedAgentPresets` and a neutral `agentPreset`, Section 8), and confirms the assignment with `objective_report {kind:'status-report', payload:{dispatchConfirm:{itemId, childId}}}`. The engine matches by parent and the child brief's idempotency header (it can read the child's first user message from the live session if needed). This path is documented as a fallback, not the default, because it costs one extra model round-trip and relies on the manager following instructions.

### 7.2 Worker sessions and presets

| Persona (from `swarm_assign`) | Preset used for the child | Capability envelope |
|---|---|---|
| `architect` | `architect` | repo reading, bash, writes/edits (no apply_patch), docs; no delegation |
| `writer` | `writer` | docs/prose, present; no bash; no delegation |
| `researcher` | `researcher` | web + primary sources; no source writes; no delegation |
| `reviewer` | `reviewer` | read-only source; runs checks; fixtures only |
| `orchestrator` | `orchestrator` | only for stages that themselves coordinate; no nested objective mutation; bounded by `maxDepth` |
| `objective-manager` | `objective-manager` | replanning/coordination stages; never verifies; never closes an objective |
| `verifier` | `verifier` | verification only; read-only source + evidence write; never creates work |

The five existing presets are unchanged except the optional `allowedAgentPresets`/`agentPreset` additions on `preset-orchestrator` (Section 8). The `objective-manager` preset does **not** mount `tool-subagent`: dispatch is through `objective_dispatch`, so the manager cannot bypass the engine's provenance record or the engine's verifier choice.

### 7.3 Verifier wiring

- The manager requests verification with `objective_verify(objectiveId, criterionIds?, expectedRevision)`. The engine (not the manager) starts the verifier child: `request.agentPreset = 'verifier'`, parent = manager, brief = objective statement, criteria, pinned commit, evidence format, and the rule "you may only read and run checks; write nothing except the evidence file under the evidence directory (Phase 2) / return evidence in `objective_verdict` (Phase 1)".
- Phase 1 uses the existing `reviewer` preset if the new `verifier` preset is not yet installed (Stage A allows a different agent/preset; reviewer ≠ producer preset is the minimum). Phase 1 ships the `verifier` preset anyway because it needs (a) a stable preset id for the engine's self-verification check, (b) evidence-file write allowance, (c) its own persona instructions.
- The verifier returns structured output through `objective_verdict(verificationId, criterionId, evidence, verdict, reason)` while it runs; the engine validates authority (`exec.agent.sessionId == record.verifier.sessionId`, preset id `verifier`), commit, and criterion coverage, then journals `verification/verdict`. If the verifier ends without a verdict, the engine records `inconclusive` and applies the retry/block rule.
- Commit pinning: the engine resolves the full commit object name itself (`git rev-parse HEAD` through `ctx.subprocess`, or the owner workspace manifest digest for non-repo scopes) **before** starting the verifier; the verifier must report that exact commit; a mismatch (`wrong-commit`) is `inconclusive`. Phase 1 additionally requires `git status --porcelain` empty for committed code (the verifier reports it; the engine rejects `dirty-workspace`). Phase 2 runs the verifier in a fresh worktree checked out at that exact commit, so a producer cannot move the ground under it.
- Human ack: `objective_ack(objectiveId, criteriaIds, decision:'ack'|'send-back', note, expectedRevision)` is accepted only from a runtime-root session in a turn containing a direct human message. The manager asks the human with `ask_user_question` (root session; live child cannot open a human interaction — verified) and then records the ack. In headless deployments with no answerer, the objective stays in `awaiting-human` indefinitely; it never auto-approves.
- Producer cannot verify: the verifier is always a child started by the engine with a distinct preset; the manager cannot choose a verifier session; the producer's own `objective_report` can never satisfy a criterion without a verification record.

### 7.4 Per-criterion evidence — what counts

| `check.kind` | Evidence that counts | Produced by |
|---|---|---|
| `command` | `{criterionId, kind:'command', command, cwd, exitCode, stdoutSha256, stdoutExcerpt≤2KB, at}`; command must be the one in the criterion (or an explicitly allowed equivalent recorded in the verification request); exit code must equal `expectedExitCode`; run from the pinned commit/clean workspace | verifier child via `objective_verdict` (the verifier runs it with its bash tool); engine hashes the excerpt |
| `artifact` | `{criterionId, kind:'artifact', path, sha256, at}`; path must be inside the objective's `scope.paths`; sha256 verified by the engine against the file on disk (Phase 1) or the worktree (Phase 2) | verifier child |
| `human-ack` | `{criterionId, kind:'human', note, by:'human', at, rootSessionId, messageId}` via `objective_ack` | human |
| anything else | not accepted (`evidence-kind-unsupported`); new kinds are a schema version bump | — |

Evidence is stored in the Verification record and (Phase 2) as files under `$DSH_HOME/storages/objective-engine/evidence/<objectiveId>/<verificationId>/`, content-addressed by sha256. Evidence is never accepted from the manager or the producer.

### 7.5 Workspace isolation and merge serialization

**Phase 1 (default): exclusive scopes, serialized by the engine.**
- Every objective declares `scope.paths`; admission rejects overlapping active objectives (`scope-conflict`).
- The engine's dispatch gate is global (`maxInFlightItemsGlobal`), and one objective's concurrent writers are capped (`maxActiveItemsPerObjective`), so no two workers write the same scope concurrently. `writeScopes` on the team board (Phase 0) are advisory only; the Phase 1 enforcement is the scope gate above.
- The owner commits before requesting verification; verification pins the commit; a rejected/dirty workspace is `inconclusive`.
- Merge serialization in Phase 1 is trivial: work happens in the single owner workspace, and the verifier checks the committed state; there is no branch to merge.

**Phase 2 (opt-in): per-objective git worktrees + a merge queue.**
- Add `@deepseek-ai/dsh-experimental-worktree` (service `ctx.worktrees`) and, if managers should create checkouts themselves, `@deepseek-ai/dsh-experimental-tool-worktree` (`create_worktree`) to the profile bundles.
- On objective activation, the engine creates a worktree from a base commit: `ctx.worktrees.create(ownerAgent, { name: objId, from: baseCommit })` → `{path, branch, baseCommit, repositoryRoot}` recorded as `scope.worktree`. Workers are started with `cwd = worktree.path` (the subagent request carries `cwd`); the verifier is started with the same `cwd` at the pinned commit.
- Merging is **not** provided by the shipped worktree package ("inspection, merging, and checkout or branch removal are outside this tool/runtime"). The engine implements a **merge queue** in new code: one global lock; on `objective/completed`, run `git merge --no-ff <objective-branch>` in the main checkout via `ctx.subprocess`, in priority order; a conflict yields `blocked: merge-conflict` and requires a human/manager conflict item. The merge runner is a custom control-plane component (flagged as proposal, not shipped API) and is gated behind Phase 2 + a test that a conflicting merge cannot lose another objective's committed work.
- Worktree limitations are documented: local revisions only, no dependency install, retained artifacts, no checkout/branch deletion — the engine never deletes branches; a human cleans them.

### 7.6 What the manager may and may not do

| Action | Manager | Worker | Verifier | Human (root turn) |
|---|---|---|---|---|
| create objective | only as a human-authorized call in a root turn | no | no | yes |
| plan work orders | yes | no | no | yes (through manager) |
| dispatch work | yes (via engine tool) | no | no | no |
| report progress | yes (status reports about the objective) | yes (own item only) | no | no |
| request verification | yes | no | no | yes |
| record verdict/evidence | no | no | yes (own record only) | no (ack is separate) |
| ack judgment criteria / resume / cancel | no (asks human) | no | no | yes |
| pause all | no (asks human) | no | no | yes |

---

## 8. Composition plan against this repo/profile

Everything below points at a real file or row id. **Required** = needed for Phase 1 acceptance. **Optional** = useful, not on the critical path. **Risky** = behavioral change with a fallback/rollback.

### 8.1 New local bundle: `objective-engine/`

Location: `/path/to/objective-engine/` (in this repository it would be `packages/objective-engine/`). A sibling of `systemone-plugin` and `dsh-personas`, linked into the profile the same way those are (`"@local/objective-engine": "link:…"` in the profile `package.json`).

```
objective-engine/
  package.json              # name @local/objective-engine, type module, dsh.bundle.patch: ./cordis.patch.yml
  cordis.patch.yml          # insert row { id: objective-engine, name: @local/objective-engine, config: … }
  index.js                  # plugin entry: service, tools, hooks, timer; ~no business logic
  lib/
    store.js                # append-only journal + snapshot + LOCK (ObjectiveStore interface)
    fold.js                 # pure fold: events -> {objectives, items, verifications, engine, queue, wakeups}
    transition.js           # command handlers O1–O14, I1–I10, verification rules (no classifier import)
    admission.js            # limits, queue, fairness, overload signals
    pump.js                 # serialized wakeup pump + deadline sweep + pre-step fence
    dispatch.js             # startActivation wrapper, child tracking, subagent/end handler
    verify.js               # commit pinning, verifier start, verdict validation, evidence checks
    classify.js             # objective_classify: exact questions, thresholds, advisory journal only
    prompts.js              # wakeup/ack/blocked templates, versioned
    status.js               # objective_status payload
  README.md                 # operator runbook + protocol reference
  test/                     # node:test + fake ctx (same pattern as plugin-selftest)
```

`package.json` dependencies follow the existing local-bundle pattern (`systemone-plugin/package.json`): `@deepseek-ai/dsh-tools` (defineTool), `@deepseek-ai/schemastery` (Config), plus `node:fs`/`node:crypto`/`node:path`. No `@deepseek-ai/dsh-storage-domain`/`zod` in Phase 1 (see Section 2.7); the store interface keeps that migration open.

### 8.2 Interface signatures (implementation contract, not code)

```js
// cordis: ctx.provide('objectives', api)  (verified: cordis ctx.provide(name, value, check))
const api = {
  create(actor, input):  Promise<Result<ObjectiveView>>,      // O1
  plan(actor, input):    Promise<Result<ItemView>>,           // I1 (+cancel/edit item)
  dispatch(actor, input):Promise<Result<DispatchView>>,       // I2 + startActivation
  report(actor, input):  Promise<Result<ItemView>>,           // I3
  requestVerification(actor, input): Promise<Result<VerificationView>>, // O4
  recordVerdict(actor, input): Promise<Result<VerificationView>>,       // O5/O6/O7
  ack(actor, input):     Promise<Result<ObjectiveView>>,      // O8/O9, human-root only
  control(actor, input): Promise<Result<ObjectiveView>>,      // pause/resume/cancel/edit
  status(actor?, input?): EngineStatus,                       // read-only, any member
  pauseAll(reason):      Promise<void>,                       // kill switch, service-level
  pump():                Promise<void>,                       // internal + tests
}
// Result<T> = { ok:true, value:T } | { ok:false, code, message, current?:unknown }
```

Model-facing tools registered on the host plane (names are new; no collision with existing tools): `objective_create`, `objective_status`, `objective_plan`, `objective_dispatch`, `objective_report`, `objective_verify`, `objective_verdict`, `objective_ack`, `objective_control`, `objective_system`, `objective_classify`. Each tool declares a JSON output schema and renders compact JSON; each `execute` re-checks authority (root/child identity, preset id, turn boundary, direct-human-message) before touching the service — the `dsh-tool-goal` execution-time-authority pattern, not a prompt-only rule. `objective_status` is read-only for any live member (workers can see the objective they serve; it returns a redacted view without budgets of other objectives).

Plugin service dependencies: **required** — `tools` (register), `agents` (resolve owner/root, `isOwnedBy`, `get`), `sessions` (turn boundaries / event access), `subagents` (dispatch + `subagent/start|end`). **Optional, via `ctx.get` with typed degradation** — `schedule` (Phase 2 cadence only; absent = no cadence, creation still works), `systemone` (classifier; absent = `objective_classify` returns `classifier-unavailable`), `tokenMeter` (token budget measurement; absent = objectives may not declare a token budget), `subprocess` (commit pinning / merge queue; absent = verification cannot pin a commit, so `objective_verify` returns `commit-unavailable`), `workingDirectory`/`fs` (evidence hashes; absent = artifact evidence unsupported), `userQuestions` (ack prompt convenience only; the engine never depends on an answerer). Required services are declared so the loader orders activation; optional ones never block the plugin from loading.

Hooks used: `agent/pre-step` (wakeup fence + `agent.inject` context notices), `agent/disposed` (drop tracking), `agent/created` (track roots), `subagent/start` / `subagent/end` (dispatch/settlement), `agent/status` (idle), `session/event` (turn boundary checks only where needed), cordis timer (sweep). `tools/pre-execute` is **not** used to gate the engine's own tools: the authority checks live inside each tool, which is simpler and matches the goal-tool precedent; a `tools/pre-execute` composition would also be vulnerable to the approval-disabled environment (Stage A condition 9).

### 8.3 Concrete changes by file and row

| # | File / row | Change | Class | Notes |
|---|---|---|---|---|
| C1 | NEW `objective-engine/` (all files listed 8.1) | The control-plane plugin, service, tools, journal, pump, tests | **required** (Phase 1) | Phase 0 has no plugin |
| C2 | `~/.dsh/profiles/<profile>/package.json` | Add `"@local/objective-engine": "link:<path-to-objective-engine>"` to `dependencies`, and add `"@local/objective-engine"` after `"@local/systemone"` in `dsh.profile.bundles` | **required** (Phase 1) | Keeps it last so its profile row override wins; loader order is service-availability-driven |
| C3 | `~/.dsh/profiles/<profile>/cordis.patch.yml` — **new row** `objective-engine` | Full config: limits (Section 6.2), classification thresholds, store path, evidence dir, worker delegation cap, `allowAgentProposedObjectives:false`, `autoVerify:false` | **required** | Profile patch replaces row config wholesale (documented in the existing row comments) so all deployment values go here |
| C4 | same file — row `systemone` config | Add `swarm.presets` list = the current five + `objective-manager`; add `swarm.personas.objective-manager` / `swarm.personas.verifier` entries (description + instructions text, Section 8.4); extend `swarm.orchestratorTools` with `objective_create`, `objective_status`, `objective_plan`, `objective_dispatch`, `objective_report`, `objective_verify`, `objective_verdict`, `objective_ack`, `objective_control`, `objective_system`, `objective_classify`, plus `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_create`, `team_task_list`, `team_task_get`, `team_task_update` (Phase 0 board; harmless in Phase 1) | **required** | Today `swarm.orchestratorTools` (defaults in `lib/decisions.js` lines 129–146) hides team/schedule/goal tools from a swarm orchestrator — Stage A's gap; the profile patch is the authoritative place for this deployment |
| C5 | `systemone-plugin/index.js` (`apply`, after `createDecisionRuntime`) | Register a decision-plane service: `ctx.provide('systemone', { decide(state, questions, signal), status(), swarmActive(agent) })`, backed by the existing `decide` closure and `swarmSessions` set; no behavior change to existing decisions | **required** (Phase 1) | `ctx.provide` verified in cordis; service name `systemone` does not collide with `ctx.get('agentPresets')` etc. Fallback if rejected: engine duplicates the ~60-line `decide` client and reads `settings.endpoint` from its own config (documented duplicate risk) |
| C6 | `systemone-plugin/lib/decisions.js` — `resolveSettings` defaults | Add `objective-manager` and `verifier` personas to the built-in `swarm.personas` catalog, and objective/team tools to the built-in `swarm.orchestratorTools` | **optional** | Profile patch C4 is what actually applies; plugin defaults make other profiles sane and keep the selftest's defaults coherent |
| C7 | `dsh-personas/cordis.patch.yml` — **new** `preset-objective-manager` (row id `preset-objective-manager`, order 15) | Rows: `persona` (prefix = manager policy, Section 8.4), `agent-instructions`, `time-context`, `tool-fs` (`applyPatch:false`), `tool-fs-search`, `tool-bash`, `tool-web`, `tool-todo`, `tool-ask-user`, `skill-filesystem`, `tool-skill`, `present`, compaction group (`compaction-basic`, `command-compact`) | **required** (Phase 1) | No `tool-subagent`/`tool-workflow` on purpose: dispatch goes through `objective_dispatch`; the host-plane `objective_*`/`systemone_*`/`swarm_*` tools are visible without preset rows |
| C8 | same file — **new** `preset-verifier` (row id `preset-verifier`, order 16) | Rows: `persona` (verifier policy), `agent-instructions`, `time-context`, `tool-fs` (`read:true, readImage:true, write:true, edit:false, applyPatch:false`), `tool-fs-search`, `tool-bash`, `tool-web`, `tool-todo`, `tool-ask-user`, `skill-filesystem`, `tool-skill`, compaction | **required** (Phase 1) | Read-only on source is enforced by the persona policy as well: add `presets.verifier.policy` to the `systemone` row (allow writes only under `**/.objectives/evidence/**`), mirroring the existing `presets.reviewer.policy` blocks |
| C9 | same file — `preset-orchestrator` row `tool-subagent` config | Add `allowedAgentPresets: [architect, writer, researcher, reviewer, verifier, objective-manager]` and `agentPreset: architect`; optionally `maxDepth: 1` | **optional Phase 0 enabler / required for the Phase 1 fallback**; **risky** | Today omitting `agent_preset` makes the child inherit the orchestrator preset (tool-subagent README: "Omit to inherit the parent agent's current preset"), which permits nested delegation; setting a default is a behavioral change for every orchestrator session. Rollback: remove the two fields; existing sessions keep their composition |
| C10 | `dsh-personas/README.md` | Document the two new presets and the `allowedAgentPresets` note (the README's "subagents only select a model, not a persona" line is stale for 0.2.2-rc.1) | **optional** | Documentation only |
| C11 | `plugin-selftest/run-objective.mjs` (new) + extend `plugin-selftest/run.mjs` | Fake-ctx tests for the engine (nine-condition suite, duplicate-replay, classifier contradiction) and a service test that the systemone `systemone` service exists | **required** (Phase 1) | Reuses the existing fake-Cordis/mock-server pattern; mock Mammoth server already exists (`mock-server.mjs`) |
| C12 | NEW `objective-engine/README.md` | Operator runbook: create/resume/pause, budget errors, journal repair, kill switch, evidence layout | **required** (Phase 1) | Deliverable of Phase 1 |
| C13 | profile bundles — add `@deepseek-ai/dsh-experimental-worktree` + `@deepseek-ai/dsh-experimental-tool-worktree` | Phase 2 worktree isolation | **optional / risky** (Phase 2) | Worktree runtime changes session working directory only for tool calls; no merge support shipped; merge queue is new code (Section 7.5) |
| C14 | `objective-engine/lib/merge.js` (Phase 2) | Serialized `git merge` queue via `ctx.subprocess` | **risky** (Phase 2) | Not a shipped API; must be covered by conflict/no-data-loss tests |

**Explicitly unchanged:** `swarm_assign` implementation and schema (`systemone-plugin/index.js` lines 794–858, `lib/decisions.js` `swarm.assign` lines 1003–1049); `swarm_enter`/`swarm_exit`; the five existing presets' tool rows (except C9); the team/schedule/goal services; the decision layer's `off|shadow|enforce` semantics.

### 8.4 Persona text (goes in C4 and C7/C8)

`swarm.personas.objective-manager` (routing catalog description + instructions):
> **Description:** Tracks objectives and progress; files work orders and status reports, and never declares its own objective complete.
> **Instructions:** You are the objective manager. You own an objective's plan, not its completion: decompose it into work orders, ask `swarm_assign` which persona executes each stage, dispatch with `objective_dispatch`, and file progress through `objective_report`. You never decide that an incoming message is an objective or progress — use `objective_classify` only for a proposal and act through explicit tools. You never verify your own objective, never record a verdict, and never mark an objective complete; ask the human to acknowledge judgment criteria. When work is blocked, budget-exhausted, or the engine is paused, report the typed reason and stop.

`swarm.personas.verifier`:
> **Description:** Independently verifies one pinned commit against an objective's criteria and reports per-criterion evidence.
> **Instructions:** You are an independent verifier. Read the actual commit and run the checks yourself; cite command, exit code, and file hash for every criterion. You may not edit source, create objectives, or declare an objective complete — only report approve/reject/inconclusive per criterion to `objective_verdict`. If the workspace is dirty, the commit differs from the pinned one, or evidence is missing, report inconclusive rather than guessing.

The `objective-manager` preset persona prefix (C7) is the longer manager policy: never do stage work yourself, keep one stage in flight per child, treat engine prompts as work orders not suggestions, escalate ambiguity to the human, and never route around an engine denial. The `verifier` preset persona prefix (C8) is the reviewer-like policy with the evidence-only allowance.

### 8.5 Swarm-mode changes required (summary)

1. **Orchestrator allow-list** (C4): add the objective + team tools to `swarm.orchestratorTools`; without this a swarm session cannot call them at all (they are restricted out by `applyOrchestratorRestriction`).
2. **Persona catalog** (C4/C6): add `objective-manager`/`verifier` so `swarm_assign` can route to them; do not remove or re-order existing personas.
3. **Preset membership** (C4): add `objective-manager` to `swarm.presets` so a manager session that calls `swarm_enter` is enforced/judged like the other orchestration sessions. `verifier` is intentionally **not** in `swarm.presets`: a verifier child is never a swarm orchestrator and must never enter the mode.
4. **Preset wiring** (C7/C8/C9): the new presets are ordinary preset rows; the existing orchestrator preset gains `allowedAgentPresets` only.
5. **`agent.inject` reality check:** `agent.inject()` exists in `dsh-agent` 0.2.2-rc.1 ("adds model-facing context without waking the driver") and session format v4 accepts producer-owned source kinds other than `plugin`; the engine uses `inject` with `source.kind:'objective-engine'` for context-only notices and `followup` for wakeups. The `systemone-plugin/README.md` warning ("unverified in 0.2.2") was about its own skill-hint notice shape; the engine still treats an `inject` rejection as non-fatal (log + continue) so an unverified admission path cannot break the pump.
6. **No change to `swarm_assign`.** No message classification, no completion judging, no new candidates argument semantics.

---

## 9. Failure policy and operations

### 9.1 Failure policy table

| Failure | Detection | Automatic action | Human-visible | Why fail-closed |
|---|---|---|---|---|
| Decision-plane outage / timeout | `objective_classify` `decide()` returns `{ok:false}` within `timeoutMs` | journal `classification/proposed` with `error`, return `classifier-unavailable`; **no state change**; deterministic tools keep working; if a proposal was required, the manager asks the human or files `not_work` | typed tool error + status `classifier.lastFailure` | Uncertain classification cannot create/attach/close anything |
| Classifier returns contradictory/no-fit | decision rule → `ambiguous|none_fit` | proposal journaled; manager must ask human; headless → `not_work` note | tool result + `objective_status.classifier.recent` | No silent default to "new objective" |
| Worker crash/error/max-tokens | `subagent/end` stopReason, or stall sweep | item `failed`; objective counts consecutive failures; at 3 → `blocked: worker-failures`; no auto-retry | journal + status + next manager wakeup | Retry only by an explicit manager/human decision with budget |
| Verifier crash / wrong commit / dirty workspace | `subagent/end` without verdict; verifier evidence mismatch | verification `inconclusive`; one re-request within budget; second → `blocked: verification-failed` | journal + status | Completion needs a positive verdict; absence blocks |
| Duplicate `subagent/end` / duplicate wakeup / duplicate tool call | idempotency key already seen | return prior result / no new event; duplicate admitted step is fence-rejected | status counters | Duplicate delivery must not spend budget or double-transition |
| Duplicate schedule delivery (Phase 2) | `(taskId, occurrenceAt)` seen | one event; stale occurrence → `wakeup/expired` | journal | Delivery is an event, never authority |
| Stale revision on a tool call | CAS check | typed `stale-revision` + current view; **no write** | tool error | Two writers cannot silently overwrite |
| Journal write/fsync failure | append throws | engine `degraded` (read-only); all mutations return `persistence-failed` | status `degraded`, log error | Never acknowledge what is not durable |
| Journal corruption / torn tail | load validation | truncate torn tail with a warning; invalid snapshot/gap → `corrupt-registry`, serve nothing, no mutations | status + log; runbook | Never guess state from a damaged log |
| Engine crash mid-command | restart fold | idempotency replay; in-flight items `failed:process-restart`; objectives `paused`, `armed=false` | boot paused + status | No auto-resume, no duplicate side effects |
| Budget exhaustion (any counter) | budget check before every transition | state `blocked`, `blockedReason.code='budget-exhausted'`; no wakeup; **never retried** | status + `OBJECTIVE BLOCKED` prompt | Resuming requires a human budget-raise command |
| Blocked objective | state | all item dispatch/acceptance rejected; only resume/cancel/ack paths open | `OBJECTIVE BLOCKED` wakeup once | Prevents silent infinite retry loops |
| Human never answers ack | time in `awaiting-human` | stays `awaiting-human`; reminder after 24h (one per 24h); never auto-complete; at `maxAckAgeMs` (7d) → `blocked: human-ack-timeout` | status + ack prompt | Completion of judgment criteria is a human act |
| Kill switch | `objective_system pause` / `PAUSED` / service | all engine behavior checks `paused` synchronously; in-flight children cancelled with `hook` cause; pending wakeups expire; boots paused | status + log | One action, durable, survives restart |
| Host restart | process start | see above; also requires `swarm_enter` again because systemone membership is in-memory | `ENGINE PAUSED` / resume flow | Re-arm is explicit only |
| Admission capacity | gate | `admission/queued` durable or typed `admission-rejected`; no spinning | tool result + status queue | Bounded active set; no self-retry loops |
| Overload signal | sweep | stop work-order wakeups until below threshold; alarm event once/hour | status `overloaded` | Backpressure instead of burst |
| Scope conflict (Phase 1 isolation) | admission | creation rejected `scope-conflict` | tool error | No concurrent overlapping writers |
| Merge conflict (Phase 2) | merge runner | `blocked: merge-conflict`; no partial merge; branch retained | blocked prompt + runbook | A conflict cannot lose another objective's commits |
| Worktree creation failure (Phase 2) | `ctx.worktrees.create` error | objective stays `active`, dispatch denied `worktree-unavailable`, one retry per sweep; repeated → blocked | status | No fallback to writing outside the isolation scope silently |

### 9.2 Observability

- `objective_status` (read-only) returns: `engine: {mode: paused|running|degraded|recovering, pausedReason, startedAt, lastPumpAt, counts:{active,queued,blocked,verifying}, limits, load:{inFlightItems, verifierQueueDepth, tokenRate15m, dispatchRate1h, journalBytes}}`, `objectives: [redacted views with budgets and blockedReason]`, `classifier: {lastRequestId, lastProposal, lastFailure, journalTail: last 10}`, `wakeups: {pending, lastAdmitted, lastExpired}`, `recentEvents: [last 20 journal entries, bounded]`. Never includes credentials or full evidence bodies.
- `systemone_status` continues to report the decision layer (`layer.mode`, `layer.stats`, `layer.recent`, `layer.swarm.active/personas`); the engine's classifier calls go through the same endpoint and are visible there when `logDecisions` is on.
- Logging: `[objective-engine]` prefix, structured `{event, objectiveId, itemId, revision, code}`; never log full human message text or evidence bodies (bounded hashes/excerpts only). The journal itself is the audit trail.
- Operator runbook (C12): how to read status; pause everything; inspect a blocked objective; raise a budget (human command); resume; repair a torn journal (stop host, back up `journal.jsonl`, keep `snapshot.json`, restart — a truncated last line is safe); reset a corrupted engine (rename the directory, mark objectives cancelled by hand in a new journal — documented as destructive); where evidence lives; how to remove the bundle (rollback).

---

## 10. Phasing and prototype

### 10.1 Phase 0 — bounded prototype, no plugin (now)

**Purpose:** prove the *workflow* and the operator experience without any new control plane; expose the places where discipline fails so Phase 1's enforcement is justified. Bounded means: one owner session, one active objective at a time, ≤4 items, short horizon, human present for verification/ack decisions.

**Composition (existing primitives only):**
- One session using the existing `orchestrator` preset, which calls `swarm_enter` and acts as objective manager (the `objective-manager` preset is not needed yet).
- **Registry:** team board tasks (durable, CAS). One task per objective, title `OBJ-<n>` with a JSON description following the `opm/v1` field list (statement, criteria, owner, budget counters, priority, state); one task per work item, title `ITEM-<n.m>`, description with `kind`/`acceptance`/`link`. `team_task_update` with `expectedRevision` provides CAS; `team_task_list` is the registry view. Explicitly documented losses: four statuses only, no budget enforcement, no verification model, advisory `writeScopes`.
- **Deterministic type boundary:** every objective is a human-confirmed `team_task_create`; every progress report is a task update/comment with `kind:'status-report'`. No Mammoth call in the control path; the operator may ask a separate session to run `systemone_ask` for a second opinion, but the answer is pasted into the description and never acted on automatically.
- **Verifier:** a child spawned from the manager through the `subagent` tool with `agent_preset: reviewer`. This needs the **Phase 0 enabler** C9 (add `allowedAgentPresets` to `preset-orchestrator`'s `tool-subagent` row) — a config-only, reversible change. If C9 is not applied, verification is performed by a second human-driven `reviewer` session and the acceptance tests are marked "human-verified".
- **Ticks:** human messages or a human-created Automation task (Web Automation page → recurring reminder to the manager session, at-least-once understood); no model-created schedules because `tool-schedule` is not mounted in the custom presets.
- **Completion:** reviewer child returns a verdict; the human acks judgment criteria in the manager session; the manager updates the task to `completed`. Producer and verifier are distinct presets by construction (orchestrator vs reviewer).
- **Budgets / caps:** a hard checklist the operator enforces (rounds counted in the description; items ≤4; verifier runs ≤2; wall time ≤1 day). The team service's `maxTasks: 256`, `maxMembers: 8` are the only hard limits.
- **Kill:** human says stop; manager archives tasks (`team_task_update` deleted); no durable global pause beyond a designated `PAUSED` task and human discipline.

**Entry criteria:** user approval; profile config backed up; C9 reviewed; a written operator script for the scenario; a fresh team board.
**Deliverables:** this design; a Phase 0 runbook in `objective-engine/README.md` (or a standalone `objective-progress-phase0.md` if the bundle doesn't exist yet); the board template; a log of every bypass observed (material for Phase 1 acceptance).
**Acceptance tests (manual, each mapped in the matrix below):** P0-1…P0-9 executed by two people (manager + verifier) on three scenarios (small code change; research note; document). Pass = no objective completed without a distinct verifier and a human ack; no progress task created as an objective; a restart of the host does not resume work without a human message; a duplicate automation tick does not produce a second work item.
**Rollback/kill:** stop using the manager session; archive the board; revert C9; delete nothing else. No plugin installed, so rollback is a session/board operation.

### 10.2 Phase 1 — plugin control plane, single process

**Purpose:** make all nine conditions enforcement, not discipline; single host, single process; a human still in the loop for ack and resume.

**Entry criteria:** Phase 0 completed on ≥10 supervised objectives with zero completion-gate bypasses and a written bypass log; C1–C11 reviewed; the profile patch changes backed up; a decision on open questions 11.1–11.4 (defaults apply if the user says "defaults").
**Deliverables:** `objective-engine` bundle (C1), profile wiring (C2/C3), systemone service (C5), profiles presets (C7/C8), persona entries and allow-list (C4), tests C11, runbook C12, `plugin-selftest/run-objective.mjs` green, `plugin-selftest/run.mjs` extended for the service and still green.
**Acceptance tests:** the nine-condition matrix below (P1-1…P1-9), plus regression tests: existing `systemone` selftests pass unchanged; a session outside swarm mode cannot mutate objectives (authority test); the manager cannot complete its own objective (forbidden-transition test); duplicate journal replay yields identical fold hash.
**Rollback/kill:** `objective_system pause` (durable), then remove the bundle from the profile and reload; if needed, remove C1/C2 and keep the journal for audit. The `PAUSED` sentinel plus starting in `paused` means a re-installed engine never resumes on its own.

### 10.3 Phase 2 — always-on hardening

**Purpose:** unattended operation for bounded windows, not unbounded autonomy: durable cadence, decision-plane circuit breaker, workspace isolation with a merge queue, ack surface, metrics, and a 72h soak.

**Entry criteria:** Phase 1 acceptance green; at least two weeks of supervised use with zero engine-bypass events and no lost evidence; a written incident review of every `blocked`, `degraded`, and classifier failure; the user has decided open questions 5–7; a cost ceiling for model tokens per day is agreed.
**Deliverables:** circuit breaker around `objective_classify` (open after N consecutive failures, deterministic pause of classification-only paths, no model calls while open); engine-owned `dsh-schedule` cadence with restart reconciliation (tasks deactivated while paused); worktree isolation + merge queue (C13/C14); a root-session ack surface (`ask_user_question` prompt + `/objective` command, Phase 2 optional command plugin); per-objective sessions only if context pressure triggers the threshold; metrics/OTel counters; cross-process writer lock; soak test (mock provider, 72h, synthetic events) proving zero duplicate turns, zero auto-completions, bounded journal growth, and restart safety.
**Acceptance tests (P2):** outage drill (endpoint down 30 min → no state change, status deterministic, recovery resumes classification proposal flow); duplicate-delivery storm (100 duplicate ticks → 1 event); crash/restart drill (kill -9 during a turn → no objective auto-resumes; journal fold valid; no lost evidence); kill-switch drill (one command pauses all within one step; survives restart); merge-conflict drill; 72h soak.
**Rollback/kill:** as Phase 1, plus deactivating engine-owned schedule tasks (the engine does this on boot when paused), and reverting C13/C14 (worktrees are retained; branches are not deleted).

### 10.4 Nine-condition acceptance matrix

Legend: **P0** = manual/advisory in the Phase 0 prototype; **P1** = automated enforcement in Phase 1; **P2** = added hardening in Phase 2.

| # | Stage A condition | Designed mechanism (section) | P0 test | P1 test | P2 test |
|---|---|---|---|---|---|
| 1 | Deterministic type boundary; Mammoth proposes only for unstructured human input; journaled; no proposal can mutate | §3.1–3.3 | P0-1: board shows every objective created by an explicit human-confirmed `team_task_create`; a classifier opinion logged but not acted on | P1-1: `test/classify-paradox` — replay with contradictory answers → fold hash identical; `lib/transition.js` import scan; forged `classification/proposed` cannot transition | P2-1: outage drill: classifier down, deterministic tools unaffected; classifier proposals still never applied |
| 2 | Complete objective record; missing criteria rejected; criteria edits versioned and force re-verification | §2.1, §4.1, O1 | P0-2: a task missing criteria is rejected by the operator checklist and re-created | P1-2: `objective_create` with no criteria / bad check → `record-incomplete`, journaled; edit criteria → `criteriaVersion++`, verifications `superseded`, `armed=false` | P2-2: edit during verification → old verdict cannot complete; soak test proves no stale ack |
| 3 | Verifier-gated completion; different agent/preset; pinned commit; per-criterion evidence; producer self-completion rejected; human ack for non-mechanical | §4.1 O4–O8, §7.3, §7.4 | P0-3: reviewer child ≠ orchestrator manager; human ack recorded in board; attempt by manager to self-complete is refused by the operator | P1-3: engine refuses producer verdict; verifier preset mismatch → `unauthorized`; commit mismatch/dirty workspace → `inconclusive`; completion of a judgment criterion without ack → `ack-incomplete`; purely mechanical objective completes on approve without ack (O6b) | P2-3: fresh-worktree verification at pinned commit; replayed producer evidence cannot satisfy a criterion |
| 4 | Per-objective and global budgets; exhaustion → blocked: budget-exhausted, never retried | §2.1 `budget`, §6.2, O10/O11 | P0-4: counters in the description; operator blocks at the cap | P1-4: each counter exhausts → `blocked` + `budget-exhausted`; notification fires once; no timer path resumes; resume without budget-raise still blocked; `tokenMeter` delta test | P2-4: rate limits under load; soak proves no budget drift |
| 5 | External admission control; bounded active set + durable queue; self-proposed goes through same gate; typed durable rejection | §6.3–6.4 | P0-5: second objective refused by operator rule until the first completes | P1-5: 4th active objective → `admission/queued` durable; self-proposed with flag off → `admission/unauthorized`; enable flag → `proposed` requiring human approve; overload stops dispatch but keeps verdicts | P2-5: queue fairness/aging test; external `objective_intake` rejection typed |
| 6 | Durable registry + idempotency; event-sourced; CAS; commit-before-ack; restart reconstruction; duplicate executes once; re-arm only on explicit resume | §2.4–2.7, §5.5 | P0-6: board is the durable log; task id = idempotency key; restart of the host requires a human message to resume | P1-6: kill -9 during a turn → fold valid, in-flight items failed, all objectives paused/armed=false; replay same key identical; conflicting key → `idempotency-conflict`; second engine instance → `engine-locked` | P2-6: duplicate-delivery storm; 72h soak restart; journal growth bounded |
| 7 | Event-driven wakeups; zero idle spend; never a self-calling turn | §5.1–5.3 | P0-7: ticks come from human or Automation reminders; idle session makes no model calls (verified by transcript timestamps) | P1-7: idle for 30 min with no events → zero engine prompts and zero tokens; one wakeup per child-completion burst; fence rejects duplicate stale prompt; no model-created followup | P2-7: 72h soak: event-only wakeups, no self-calls, coalescing under storm |
| 8 | Isolation + kill switch; per-objective context/workspace; verifier on exact commit; one action pauses all within one step and survives restart | §6.4 kill, §7.5 | P0-8: write scopes + one writer; human stop request; manager archives work | P1-8: overlapping scope rejected; kill switch pauses dispatch, cancels children with `hook` cause, expires wakeups; engine boots paused after restart | P2-8: worktree per objective, serialized merge, conflict blocks; kill-switch drill under load |
| 9 | Decision-plane failure policy; outage pauses/notifies deterministically; bounded retries; model version recorded; no reliance on approval `ask` | §3.3, §9.1 | P0-9: classifier outage changes nothing (there is no classifier in the control path) | P1-9: endpoint down → `classifier-unavailable`, no state change, bounded retries (`classificationCallsPerHour`), `modelAnswered` recorded; no `ask` approval path exists in the engine | P2-9: circuit breaker open/close drill; deterministic pause/notify; recovery |

**Coverage statement:** each of the nine conditions has a designed mechanism and at least three tests; conditions 2, 3, 4, 5, 6, 8 are enforced only from Phase 1 (Phase 0 is explicitly advisory). Condition 1, 7, 9 are structurally true even in Phase 0 because the prototype has no classifier in the control path and no plugin loop.

---

## 11. Open decisions for the user (each with a recommended default)

| # | Decision | Options | Recommended default | Why |
|---|---|---|---|---|
| 11.1 | Who produces each message type? | (a) human creates objectives, manager/work items progress; (b) manager creates both; (c) agents self-propose objectives | **(a)** | Matches the verified authority pattern (`dsh-tool-goal`: creation requires a direct human turn) and the user's wording ("it runs by dropping progress prompts") |
| 11.2 | External vs self-generated objectives | (a) human/allowlisted external only; (b) agent-proposed with approval; (c) unrestricted | **(a) in Phase 0/1; (b) behind `allowAgentProposedObjectives:false` (Phase 2)** | Always-on self-proposed objectives are the failure mode Stage A warned about; the gate exists, the default is closed |
| 11.3 | Work-order vs status-report | (a) both kinds, only `work-order` dispatchable; (b) all progress is a report; (c) report-only registry | **(a)** | Keeps dispatch auditable and prevents chat reports from silently becoming work |
| 11.4 | What "satisfied" means / who declares it | (a) engine gate: verifier verdict covering all criteria + human ack for judgment criteria; (b) manager declares; (c) verifier only | **(a)** | Stage A condition 3; the producer judges nothing, and purely mechanical objectives complete on the verifier's approve (O6b) |
| 11.5 | Idle vs continuous forever | (a) idle/event-driven only (zero idle spend); (b) periodic self-ticking regardless of events; (c) per-objective opt-in cadence | **(a) default; (c) Phase 2 opt-in, off by default** | The user's "runs indefinitely" must not mean a token-burning spin; a cadence is just a periodic event source and never a self-call |
| 11.6 | Registry substrate | (a) own append-only journal (Phase 1), `storageDomain` later; (b) `storageDomain` now; (c) team board | **(a)**, with (b) as a Phase 2 swap behind the same interface | Zero new package-resolution risk now; the interface keeps the blessed substrate open |
| 11.7 | Is the new type the swarm orchestrator or a sixth persona? | (a) new preset + plugin role that uses swarm mode; (b) replace the orchestrator; (c) a sixth persona only | **(a)** | `swarm_assign`'s role stays unchanged; the orchestrator preset keeps working; the manager is a new session type, not a mutation of the existing one |
| 11.8 | Verifier preset source | (a) new `verifier` preset; (b) reuse `reviewer` | **(a) in Phase 1; (b) is the Phase 0/fallback stopgap** | A stable preset id is needed for the self-verification check; reviewer stays the human's independent reviewer |
| 11.9 | Tool visibility | (a) host-plane tools with execution-time authority; (b) preset-scoped tools in the two presets | **(a) Phase 1; consider (b) Phase 2** if schema tokens matter | Mirrors `systemone` and `dsh-tool-goal` authority patterns; workers/verifiers need `objective_report`/`objective_verdict` without editing five presets |
| 11.10 | Manager topology | (a) one manager session multiplexing objectives; (b) one session per objective | **(a) Phase 1; (b) only if context pressure crosses the threshold** | (b) multiplies sessions, resets, and roster state; engine state is already per-objective |
| 11.11 | Human-ack surface | (a) `ask_user_question` in the root session + engine record; (b) approval prompts; (c) Web UI page | **(a)**, (c) in Phase 2 if needed; never (b) | Approvals are disabled in unattended profiles and `ask` denial is environment-dependent (Stage A condition 9) |
| 11.12 | Autonomy envelope | (a) bounded supervised windows now; (b) always-on after Phase 1; (c) never beyond prototype | **(a)** | Stage A's verdict: viable bounded prototype now, always-on only after Phase 2 hardening |

---

## 12. Risks, highest-risk decision, and what Stage C should attack

### 12.1 Highest-risk design decision

**Channeling every objective's progress through one engine-driven owner session** (host `followup` wakeups + a single manager context), with the verifier dispatched by the engine. It is the decision that makes the design coherent — one place to enforce the gate, one place to serialize wakeups, no self-calling turns — but it concentrates risk: context growth and turn serialization across all objectives; one bad wakeup can cost a model turn; and the engine's dispatch relies on `ctx.subagents.startActivation` + `request.agentPreset` (verified in the shipped library but **not documented in its README**). Mitigations: per-objective worktrees and context isolation (Phase 2); one pending wakeup per objective; coalescing; the documented fallback dispatch path (manager's `tool-subagent` + `objective_report dispatch-confirm`); per-objective sessions only if the context threshold is crossed (open decision 11.10). If Stage C finds this decision unsound, the alternative is per-objective manager sessions with the engine as a pure gate — more sessions, but a smaller blast radius.

### 12.2 Additional risks

- **Verifier independence is only as strong as the workspace isolation.** Phase 1's verifier runs in the same checkout; a producer that leaves uncommitted changes can make `workspaceClean` fail (safe) but cannot be prevented from touching files while the verifier runs. Phase 2's fresh worktree closes this.
- **`startActivation`/`agentPreset` and `subagent/start|end` are verified in the 0.2.2-rc.1 library but only partially documented**; the fallback path exists, but it costs a round-trip and depends on manager compliance.
- **Team bundle experimentality**: Phase 0 relies on the experimental team package; its contracts can change (README says so). It is not on the Phase 1 critical path.
- **Journal implementation is bespoke**: append-only + snapshot + lock is simple but must be tested for torn writes, fsync failure, and replay determinism; the Phase 2 `storageDomain` swap should be evaluated before long-running use.
- **One-wakeup cost is real**: a wakeup that reaches the manager but finds nothing actionable still spends a model turn. The pump only wakes when an action exists, but race conditions can produce an empty turn; the prompt tells the manager to reply "duplicate/no action" cheaply.
- **Authority checks are process-local**: a second host process writing the same journal is refused by the lock, but there is no cross-process lease; Phase 2 item.
- **Tool schema cost**: eleven always-visible host tools in every session; acceptable at DSH's token scale but a candidate for preset scoping if it shows up in token telemetry.

### 12.3 What Stage C should attack hardest

1. **Wakeup correctness vs condition 7.** Prove or refute that `agent.followup` from a host plugin on `subagent/end` cannot produce a self-calling turn, a duplicate turn under a settlement burst, or a lost turn when the owner is mid-turn; check the race fence against the goal-round-driver's "verify before and after downstream listeners" pattern.
2. **The completion gate.** Try to complete an objective through every tool path (manager, producer child, verifier child, forged journal event, contradictory classifier, stale revision, replayed ack, criteria edit after verdict, duplicate `subagent/end`). The design must fail closed in every case.
3. **Verifier independence.** Attack the preset check (reviewer vs producer), the commit pinning (dirty workspace, commit moved after request, two objectives sharing a checkout), and evidence provenance (can the manager fabricate command evidence?).
4. **Restart and durability.** Kill the process at every mutation point; prove the fold, idempotency index, wakeups, and `armed` flags reconstruct safely; prove no objective auto-resumes and no journal corruption path is silently tolerated.
5. **Admission/overload honesty.** Show that the caps measure real load (in-flight items, verifier backlog, token rate), not objective count; find the unbounded path (e.g. one objective generating 16 items each spawning verifier runs) and check budget accounting.
6. **Composition reality.** Verify C4/C5/C7/C8/C9 against the actual loader: does `ctx.provide('systemone', …)` work from the existing function plugin, does `@local/objective-engine` link/load in this profile, does the orchestrator restriction allow the new tools, does `allowedAgentPresets` on the preset-scoped `tool-subagent` row behave as documented, and does the manager preset load without the host-disabled subagent rows.
7. **Phase 0/1 boundary.** Check that Phase 0 really needs no plugin and that its documented losses are honest (especially completion enforcement and budget accounting), so the "viable bounded prototype" claim is not overstated.

---

## Appendix A — evidence inspected (verified, DSH 0.2.2-rc.1 / profile packages 0.2.2-rc.1)

Local workspace: `systemone-plugin/README.md`; `systemone-plugin/index.js` (swarm tools lines 736–860, Config schema 66–207, `apply` 863–886); `systemone-plugin/lib/decisions.js` (settings/defaults 97–191, `decide` 337–399, `viewFor` 437–457, hooks 691–848, `swarm` object 929–1050, status 1058–1091); `dsh-personas/cordis.patch.yml` (preset rows `preset-orchestrator` … `preset-researcher`, tool rows incl. `tool-subagent` at preset-orchestrator lines 63–76); `dsh-personas/README.md`; `plugin-selftest/run.mjs` (fake Cordis context, mock endpoint, swarm-mode tests); `plugin-selftest/mock-server.mjs`.

Profile: `~/.dsh/profiles/<profile>/package.json` (bundle list, linked local packages, team bundle 0.2.2-rc.1); `cordis.patch.yml` (row `systemone`; `mode: swarm`; per-preset policy/judge; orchestrator tool categories); `cordis.yml`.

Shipped packages read from `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` (`dsh/node_modules/@deepseek-ai/…`): `dsh-agent` README (Agent handle: `followup`, `steer`, `inject`, `cancel`, `whenIdle`; `agent/*` events; scope registrations; initiator scope); `dsh-agent-loop` lib (closed cancel-cause union user/parent/hook/disposed); `dsh-goal` README (one current goal per session; event-sourced `goal/change`; activation process-local; round cap only); `dsh-tool-goal` README (creation/editing requires a direct human turn; completion/blocked authority; no independent evaluator); `dsh-goal-round-driver` README (idle-only rounds, reservation/admission, race fences, durability checkpoint, fail-closed teardown, no abnormal auto-retry); `dsh-schedule` README (service API, RRULE/Cron, at-least-once delivery, latest missed occurrence after restart, 60s floor, model tools refuse delegated callers, session target must be unarchived/non-delegated); `dsh-tool-subagent` README (`agentPreset`/`allowedAgentPresets`, in-process spawn as prerequisite, omit-to-inherit behavior, activation result); `dsh-subagent` README + lib (`startActivation({provider,label,request,signal,delivery})`, `request.parent` + `request.agentPreset`, exact-live-parent check, `subagent/start|end` lifecycle emitter, `subagent/descriptor|catalog` log events); `dsh-experimental-agent-team` README (durable lead log; roster; CAS task board; four statuses; shared checkout; advisory write scopes; no automatic ownership release); `dsh-experimental-tool-agent-team` README (nine tool names: `spawn_teammate`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_create/list/get/update`); `dsh-user-questions` README (live child cannot open human interaction; agentless requests need a local answerer; approval intent); `dsh-storage-domain` README (`ctx.storageDomain`, `defineDomain`/`domainTable`, commit-before-ack, single-process change visibility); `dsh-token-meter` README (`ctx.tokenMeter.measure(session).totalTokens`, replay-based); `dsh-experimental-worktree` + `dsh-experimental-tool-worktree` READMEs (`ctx.worktrees.create(agent,{name?,from?},…)` → `{path,branch,baseCommit,repositoryRoot}`; `create_worktree` tool; no merge support; local revisions only); `dsh-persona`, `dsh-agent-preset`, `dsh-agent-preset-registry` READMEs (preset rows, `presetForSession`, patches/inserts); `dsh-session` README + lib (`session.append`, known-event-type policy, surface events, event log as authority, plugin-record limitation); `cordis` lib (`ctx.provide(name, value, check)`); `dsh-base` patch (row ids `goal`, `goal-round-driver`, `command-goal`, `tool-goal`, `tool-subagent*`, `storage-domain`, `token-meter`, `subprocess`, `schedule`); `dsh-web-app` patch (host-plane vs preset-plane rows; `schedule` host service; `tool-goal`/`tool-schedule` behind presets; custom presets not mounting them); `dsh-experimental-agent-team-profile` patch (host `tool-subagent*` disabled; team rows `agent-team`, `tool-agent-team`, `ui-agent-team`).

## Appendix B — proposals vs shipped behavior (read before implementation)

| Proposal | Status | Fallback |
|---|---|---|
| `@local/objective-engine` plugin/service/tools (`ctx.provide('objectives')`, `objective_*` tool names, journal) | **new code**, not shipped | Phase 0 prototype |
| `ctx.provide('systemone', …)` in the existing local plugin | **new code** using a verified Cordis API (`ctx.provide`) | duplicate the small `decide` client in the engine; record the duplication |
| Engine starting verifier/worker children with `request.agentPreset` via `ctx.subagents.startActivation` | API verified in `dsh-subagent` lib, **not documented** in its README | manager `tool-subagent` dispatch + `objective_report dispatch-confirm` (requires C9) |
| `objective_*`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_*` added to `swarm.orchestratorTools` | config change against a verified restriction list | none; without it a swarm session cannot call them |
| New presets `objective-manager`, `verifier`; row ids `preset-objective-manager`, `preset-verifier` | new rows in an existing bundle; ordinary preset schema | reuse `orchestrator`/`reviewer` presets in Phase 0 only |
| `objective-manager`/`verifier` persona entries in `systemone.swarm.personas` | config only | Phase 0 uses existing personas |
| Own append-only JSON journal (rather than `storageDomain`) | **new code**; DSH-legal but bespoke | swap to `storageDomain` in Phase 2 behind the same interface |
| `objective_intake` RPC / external producer allowlist (Phase 2) | **new code** inside the engine; there is no shipped external-intake primitive | no external producers in Phase 0/1; humans only |
| Phase 2 worktree isolation + `lib/merge.js` merge queue | worktree creation is shipped; **merge is new code** | Phase 1 exclusive scopes, single checkout |
| `PAUSED` sentinel file in the engine storage dir | **new code** (simple operator convenience) | `objective_system pause` alone still survives restart via the journal |
| Display-only goal mirror (Phase 2, default off) | proposal; depends on `dsh-goal` + a mounted `tool-goal` | do not use; engine status is the source of truth |
| Eleven host-plane tools visible in all sessions | design choice; token cost unmeasured | preset-scope them in Phase 2 (open decision 11.9) |

**Not invented / verified as existing behavior:** swarm mode and its in-memory membership; `swarm_assign` semantics; agent hooks/events used; `followup`/`inject`/`cancel`/`whenIdle`; `subagent/start|end`; schedule service/delivery semantics; goal service/driver semantics; team tools/task board; `ctx.storageDomain`; `ctx.tokenMeter`; `ctx.worktrees`; `ctx.subprocess`; `ctx.userQuestions` constraints; Cordis `ctx.provide`; preset rows and `presetForSession`; session-log event policy (why the registry is not in the session log).

## Appendix C — glossary

- **Objective** — the top record: a state of the world with checkable acceptance criteria, an owner, a budget, and a revision.
- **WorkItem** — progress record: `work-order` (dispatchable), `status-report` (evidence/report), `heartbeat` (liveness).
- **Verification** — a pinned-commit, per-criterion evidence bundle and verdict; the only path to completion besides a human ack.
- **Ack** — a human decision on judgment criteria, recorded from a root turn with a direct human message.
- **Wakeup** — a reserved, idempotent engine prompt to the owner session; the only way the model gets another turn on its own.
- **Pump** — the serialized engine routine that observes events, applies transitions, and emits at most one wakeup.
- **Admission** — the capacity/authority/completeness gate every objective passes; rejections are typed and durable.
- **Kill switch** — one durable command that pauses the engine, cancels engine-caused work, expires wakeups, and survives restart.
