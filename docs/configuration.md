# Configuration reference

Everything in this repository is configured either in a bundle's
`cordis.patch.yml` or as a row override in the active profile's
`cordis.patch.yml`. The System One bundle additionally exposes the day-to-day
fields in **Settings → Decision model** (Web client only).

This page lists every field, its default, and what it does. For installation
steps see [`docs/install.md`](install.md); for the behavior behind the fields
see [`docs/decision-system.md`](decision-system.md).

---

## 1. Where configuration lives and who wins

```text
code defaults
  └─ bundle row config          packages/*/cordis.patch.yml
       └─ profile patch         ~/.dsh/profiles/<profile>/cordis.patch.yml
            └─ --patch overlays passed to the launcher
```

Rules that matter:

- **The profile patch replaces the bundle row's `config` wholesale.** It is not
  a deep merge. If you override the `systemone` row, restate every deployment
  field the row needs.
- **The Settings screen writes the profile patch.** A UI save becomes an
  ordinary row override, so it participates in the same precedence and survives
  restarts.
- **Row ids are handles.** The shipped ids are `systemone`, `objective-engine`,
  `preset-orchestrator`, `preset-architect`, `preset-writer`, `preset-reviewer`,
  `preset-researcher`.
  The profile overrides the `systemone` row by id; preset rows are declared by
  the personas bundle (edit the bundle, not the profile, to change a preset).
- **Volatile fields are live.** Fields marked `.volatile()` below are delivered
  as live references and read at the next decision; a Settings save needs no
  reload. All other fields are captured at load.
- **Bundle order** in `dsh.profile.bundles`: `@local/dsh-personas` before
  `@local/systemone`.

Inspect the composed result with:

```bash
dsh --profile <name> --dump-config
```

---

## 2. `@local/systemone` configuration

The row:

```yaml
- id: systemone
  name: '@local/systemone'
  config:
    endpoint: 'http://127.0.0.1:8008/v1/systemone'
    model: 'decision-model'
    mode: shadow
```

### 2.1 Endpoint, model, credentials, transport

| Field | Default | Volatile | Meaning |
|---|---|---|---|
| `endpoint` | `http://127.0.0.1:8008/v1/systemone` | yes | Full URL that receives `POST { state, questions, model }`. The public copy's default is a placeholder; set yours. |
| `model` | `decision-model` | yes | Model id sent with every request. The service decides which ids/aliases it accepts. |
| `apiKeyRef` | `SYSTEMONE_API_KEY` | yes | Credential reference resolved through the DSH credential service, then the environment. Empty/unresolved → no `Authorization` header. |
| `timeoutMs` | `20000` | yes | Per-call deadline for one decision request. |
| `maxStateChars` | `4000` | no | Upper bound on the task text the **decision layer** sends as `state`. The `systemone_ask` tool sends exactly what the model passes. |
| `maxArgumentChars` | `1200` | no | Upper bound on a tool call's serialized arguments in assessment payloads and loop keys. |
| `maxQuestions` | `64` | no | Maximum questions accepted in one `systemone_ask` batch. |
| `maxRequestChars` | `262144` | no | Maximum serialized JSON request size (256 KiB). |
| `maxRequestBytes` | `8388608` | no | Maximum multipart request size when images are attached (8 MiB). |
| `maxImageBytes` | `4194304` | no | Maximum size of one attached PNG/JPEG (4 MiB). |
| `maxResponseChars` | `1048576` | no | Maximum accepted response size (1 MiB). |
| `logDecisions` | `true` | no | Log each decision at info level (warnings always log). |
| `redactKeys` | `[]` | no | Argument keys replaced with `[redacted]` in loop-detection call keys. |

`apiKeyRef`, `maxStateChars`, `maxArgumentChars`, `maxCategories`,
`maxSelectedTools`, `logDecisions`, and `redactKeys` are consumed by the decision
runtime but are not declared in the generated `Config` schema (Schemastery
passes unknown keys through).

### 2.2 `mode`

| Value | Default | Volatile | Behavior |
|---|---|---|---|
| `off` | | yes | No hooks. Tools still work. |
| `shadow` | **yes** | yes | Decisions computed, logged, kept in `systemone_status.layer.recent`; behavior untouched. |
| `enforce` | | yes | Decisions narrow behavior for every session. |
| `swarm` | | yes | Inert until a session calls `swarm_enter`; that session is enforced, every other session is `off`. |

### 2.3 `selection` — per-step tool preselection

| Field | Default | Volatile | Meaning |
|---|---|---|---|
| `enabled` | `true` | yes | Run selection on `agent/pre-step`. |
| `alwaysAllow` | `[]` | no | Tool names never narrowed (escape hatch). |
| `categories` | `{}` | no | Category id → description shown to the decision model. Empty → selection skips itself. |
| `toolCategories` | `{}` | no | Tool name → array of category ids. Tools not listed are never narrowed. |
| `maxCategories` | `48` | no | Above this many categories selection is skipped (fail open). |
| `maxSelectedTools` | `24` | no | Cap on tools kept per step. |

Example:

```yaml
selection:
  enabled: true
  alwaysAllow: [bash, edit, glob, grep, read, write]
  categories:
    files: 'Reading and writing files'
    search: 'Finding code and text'
    shell: 'Running commands'
    web: 'Searching and fetching the web'
    delegate: 'Delegating to subagents and workflows'
    deliver: 'Presenting deliverables'
    plan: 'Maintaining a todo list and asking the user'
  toolCategories:
    read: [files]
    write: [files]
    edit: [files]
    glob: [search]
    grep: [search]
    bash: [shell]
    web_search: [web]
    web_fetch: [web]
    subagent: [delegate]
    subagent_fork: [delegate]
    workflow: [delegate]
    present: [deliver]
    todo_write: [plan]
    ask_user_question: [plan]
```

### 2.4 `assessment` — per-call assessment

| Field | Default | Volatile | Meaning |
|---|---|---|---|
| `enabled` | `true` | yes | Run assessment on `tools/pre-execute` (also gates the model judge). |
| `onFailure` | `ask` | no | Provider failure behavior: `ask` (approval) or `hold` (cancel). |
| `includeRiskScore` | `false` | no | Ask an extra `score` question (`harmless`…`irreversible`); recorded, not gated. |
| `restrictions` | `[]` | no | Free-text restrictions included in the assessment state for the model. |

### 2.5 `loopDetection`

| Field | Default | Volatile | Meaning |
|---|---|---|---|
| `enabled` | `true` | yes | Observe `tools/result` and install the guard. |
| `maxRepeats` | `2` | no | Identical calls at or above this count are denied in `enforce`. |

### 2.6 `skills` and `modelRouting` (opt-in)

| Field | Default | Volatile | Meaning |
|---|---|---|---|
| `skills.enabled` | `false` | yes | Ask for a skill hint on each step. |
| `skills.injectHint` | `true` | no | In `enforce`, inject the chosen skill as a notice. |
| `modelRouting.enabled` | `false` | yes | Ask for a model route on each step. |
| `modelRouting.routes` | `{}` | no | Route name → `{ provider, model }`; the target must exist in the live provider catalog. Applies to the next step. |

### 2.7 `thresholds`

| Field | Default | Gates |
|---|---|---|
| `selection` | `0.25` | Category is kept when the `noul` probability is ≥ this. |
| `restriction` | `0.5` | Restriction conflict or persona-rule violation at or above this → `ask`. |
| `missingInformation` | `0.5` | Missing-information probability at or above this → `ask`. |
| `taskMatch` | `0.35` | Below this, a note is recorded; the call is **not** gated. |
| `skill` | `0.5` | Reserved for skill-hint calibration. |
| `modelRoute` | `0.4` | Reserved for model-route calibration. |

### 2.8 `swarm`

| Field | Default | Meaning |
|---|---|---|
| `orchestratorTools` | 35 names (see below) | Tools the orchestrator keeps while in swarm mode; everything else is hidden from it. Names the registry cannot resolve are filtered out before the restriction is applied. |
| `personas` | seven personas | Persona catalog for `swarm_assign`: id → `{ description, instructions }`. The five role personas plus `objective-manager` and `verifier`. An empty map falls back to the built-in catalog. |

Swarm membership is a per-session mode: `mode: swarm` affects only sessions
that entered with `swarm_enter`. There is no preset list; the retired
`swarm.presets` field was removed in 0.2.1 and is ignored if an old patch sets
it.

Default `orchestratorTools`:

```text
read, read_image, glob, grep, todo_write, ask_user_question,
subagent, subagent_fork, workflow, present, skill,
swarm_assign, swarm_enter, swarm_exit, systemone_ask, systemone_status,
objective_create, objective_status, objective_plan, objective_dispatch,
objective_report, objective_verify, objective_verdict, objective_ack,
objective_control, objective_system, objective_classify,
send_message, list_agents, wait_agent, interrupt_agent,
team_task_create, team_task_list, team_task_get, team_task_update
```

Customizing the catalog:

```yaml
swarm:
  orchestratorTools:
    - read
    - read_image
    - glob
    - grep
    - todo_write
    - ask_user_question
    - subagent
    - subagent_fork
    - workflow
    - present
    - skill
    - swarm_assign
    - swarm_enter
    - swarm_exit
    - systemone_ask
    - systemone_status
    - team_task_create
    - team_task_list
    - team_task_get
    - team_task_update
  personas:
    operator:
      description: 'Runs a documented procedure step by step and records the evidence'
      instructions: >-
        You run a documented procedure. Follow the runbook in order, stop at the
        first unexpected result, and record the evidence.
```

### 2.9 `presets` — per-preset overrides

Keyed by **preset id**. Merge rules: `mode`, `selection.*`, `assessment.*`, and
`thresholds.*` merge per key over the top level; `policy` and `judge` replace
wholesale for that preset (`policy` falls back to the top-level policy when the
preset has none); `skills`/`modelRouting` are not per-preset.

| Key | Values | Meaning |
|---|---|---|
| `mode` | `off` / `shadow` / `enforce` | Overrides the top-level mode for sessions running this preset. |
| `selection.alwaysAllow` | string[] | Extra never-narrowed tools. |
| `selection.categories` | dict | Category id → description merged over the top level. |
| `selection.toolCategories` | dict | Tool → category ids merged over the top level. |
| `assessment.onFailure` | `ask` / `hold` | Per-preset failure behavior. |
| `assessment.restrictions` | string[] | Per-preset restriction text. |
| `thresholds` | `selection`, `restriction`, `missingInformation`, `taskMatch` | Per-preset thresholds. |
| `policy` | policy object | Deterministic persona policy (see 2.10). |
| `judge` | judge object | Model-judged persona rule (see 2.11). |

Example (a reviewer that can only write fixtures and must not commit):

```yaml
presets:
  reviewer:
    mode: enforce
    selection:
      alwaysAllow: [read, bash, glob, grep]
    thresholds:
      restriction: 0.45
    policy:
      default: allow
      tools:
        write:
          paths:
            allow: ['**/samples/**', '**/fixtures/**', '**/*.csv']
        edit:
          paths:
            allow: ['**/samples/**', '**/fixtures/**', '**/*.csv']
        bash:
          commands:
            deny:
              - '(^|\s)(rm|mv|dd|truncate)\s'
              - '(^|\s)git\s+(commit|push|reset|clean)\s'
    judge:
      instructions: >-
        The reviewer may read source, run checks, and write only fixtures under
        samples/, fixtures/, or *.csv files. It may not modify source,
        dependencies, or configuration.
      boundary:
        true: The call changes source, dependencies, or configuration
        false: The call only reads, runs checks, or writes a fixture file
```

### 2.10 `policy` — deterministic persona policy

| Field | Default | Meaning |
|---|---|---|
| `default` | `allow` | `deny` makes every tool not in `allow` and not given a rule denied. |
| `allow` | `[]` | Tool names exempt from `default: deny`. |
| `deny` | `[]` | Tool names always denied. |
| `tools` | `{}` | Per-tool rules: `{ deny?, paths?: { allow?, deny? }, commands?: { deny? } }`. |

`paths` globs: `**` crosses `/`, `*` and `?` do not; `file_path` and `path`
arguments are checked. `commands.deny` entries are JavaScript regular
expressions tested against `command`. A path or command rule with no matching
argument **fails closed**. Evaluation order and semantics:
[`docs/decision-system.md`](decision-system.md#deterministic-persona-policy).

### 2.11 `judge` — model-judged persona rule

| Field | Default | Meaning |
|---|---|---|
| `instructions` | unset | Natural-language allowance the model evaluates on every gated call. Empty/unset → no judge question. |
| `boundary.true` | unset | What counts as a violation (improves interpretability). |
| `boundary.false` | unset | What stays within the allowance. |

The judge is a question inside assessment, so it requires
`assessment.enabled: true` (or the per-preset equivalent). A probability ≥
`thresholds.restriction` produces `ask` in `enforce`.

### 2.12 Settings-screen fields

The browser page **Settings → Decision model** edits this subset live:

| UI field | Config field | Validation |
|---|---|---|
| Endpoint URL | `endpoint` | Full `http(s)` URL |
| Model id | `model` | Non-empty |
| Timeout (ms) | `timeoutMs` | Integer ≥ 500 |
| Decision layer mode | `mode` | One of the four modes |
| API key | credential under `apiKeyRef` | Password; blank keeps, Clear removes |

The page also displays the credential reference read-only. `apiKeyRef` itself is
volatile and can be changed in the profile patch; the page follows it.
Everything not in the table above is profile-patch-only. See
[`docs/decision-system.md`](decision-system.md#settings-screen-and-configuration).

---

## 3. `@local/dsh-personas` configuration

The bundle has no top-level config. It declares seven preset rows — the five
role presets plus `objective-manager` and `verifier` for the objective engine.
Each row is an `@deepseek-ai/dsh-agent-preset` instance whose `config.plugins`
is the session's whole capability set.

### 3.1 Preset row schema

```yaml
- id: preset-<id>
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: <id>              # stable id used by the picker, logs, swarm, overrides
    name: <Display Name>
    description: <one line shown in the picker>
    order: <number>       # position after the shipped presets
    plugins: [...]
```

### 3.2 Row types used by the seven presets

| Row `name` | Config keys used | Notes |
|---|---|---|
| `@deepseek-ai/dsh-persona` | `prefix` | Role instructions; keep `complete: false` semantics (the default) so tool guidance and runtime context remain |
| `@deepseek-ai/dsh-agent-instructions` | `maxBytes: 65536` | Loads workspace instruction files; absent in writer/researcher |
| `@deepseek-ai/dsh-time-context` | — | Date/time context |
| `@deepseek-ai/dsh-tool-fs` | `read`, `readImage`, `write`, `edit`, `applyPatch` | All presets set `applyPatch: false`; reviewer enables read/write/edit without patch; verifier sets `edit: false` |
| `@deepseek-ai/dsh-tool-fs-search` | — | `glob`/`grep` |
| `@deepseek-ai/dsh-tool-bash` | — | Shell; absent in writer |
| `@deepseek-ai/dsh-tool-web` | `fetch`, `searchTimeoutMs` | Writer/researcher set a 60 s search timeout |
| `@deepseek-ai/dsh-tool-todo` | `allowParallelInProgress` | Orchestrator/researcher allow parallel in-progress items |
| `@deepseek-ai/dsh-tool-ask-user` | — | Human interaction |
| `@deepseek-ai/dsh-tool-present` | — | Deliverable presentation; absent in orchestrator/reviewer/verifier |
| `@deepseek-ai/dsh-skill-filesystem` + `@deepseek-ai/dsh-tool-skill` | — | Skill catalog and tool |
| `@deepseek-ai/dsh-tool-subagent-control` | — | Subagent inspection/control |
| `@deepseek-ai/dsh-tool-subagent` | `provider`, `toolName`, `modelSelection`, `modelDiscovery`, `allowedAgentPresets` | Orchestrator only; `provider: spawn` and `provider: fork` on two rows. The spawn row allows `agent_preset` ∈ architect, writer, researcher, reviewer, verifier, objective-manager (no default: omission still inherits) |
| `@deepseek-ai/dsh-workflow-ptc` + `@deepseek-ai/dsh-tool-workflow` | `provider: spawn` | Inside the `delegation` group (orchestrator only) |
| `cordis:group` + compaction rows | `isolate.compaction: true` | Every preset has one; `compaction-basic` + `command-compact` |

The underlying `tool-subagent` supports `agentPreset` and
`allowedAgentPresets` in 0.2.2-rc.1. The bundle sets `allowedAgentPresets` on
the orchestrator's spawn row (the objective engine's manager-driven fallback
dispatch needs it) and leaves `agentPreset` unset, so a child still inherits
its parent's preset unless the model names one. The `objective-manager` preset
mounts no subagent tools at all: its dispatches go through `objective_dispatch`.

### 3.3 Changing a preset

- **Prompt/tool change:** edit
  [`packages/dsh-personas/cordis.patch.yml`](../packages/dsh-personas/cordis.patch.yml),
  keep the `preset-<id>` row id, reinstall the bundle, start a **new** session.
- **Display change:** edit `name`/`description`/`order` only.
- **Rename:** changing `config.id` changes the id the systemone per-preset
  overrides must use. Update them.
- **Add/remove:** append or delete a whole `preset-<id>` row. Removing from the
  bundle removes it from the picker; sessions already using it keep their
  composition until they end.

A complete sixth-preset example is in
[`docs/personas.md`](personas.md#add-a-sixth-preset).

---

## 4. Credentials model

| Question | Answer |
|---|---|
| Where is the key stored? | DSH credential service, under the reference named by `apiKeyRef` (default `SYSTEMONE_API_KEY`); fallback is the environment variable of the same name |
| Who writes it? | The Settings page (`ctx.remote.credentials.set`), the credential service's own UI/API, or the environment |
| Is it in the profile patch? | **No.** The plugin never writes it there; the Settings page never writes it there |
| How is it sent? | `Authorization: Bearer <key>` on every decision request; no header when unresolved/empty |
| Is it ever returned? | No. `systemone_status` reports only whether one is configured |
| Is it logged? | No |
| How do I disable auth? | Set `apiKeyRef: ''`; requests carry no `Authorization` header |
| Why does a GUI-launched DSH not see my shell variable? | GUI processes may not inherit your shell environment — use the credential service (Settings) for persistent keys |

---

## 5. Recipes

### 5.1 Minimal shadow install

```yaml
- id: systemone
  name: '@local/systemone'
  config:
    endpoint: 'http://127.0.0.1:8008/v1/systemone'
    model: 'decision-model'
    timeoutMs: 20000
    mode: shadow
```

Nothing is enforced. Watch `systemone_status.layer.recent` and `layer.stats`.

### 5.2 Enforce with a taxonomy and safe escape hatch

Add to the same row:

```yaml
    selection:
      alwaysAllow: [bash, edit, glob, grep, read, write]
      categories: { files: 'Files', search: 'Search', shell: 'Shell', web: 'Web', delegate: 'Delegation', deliver: 'Deliverables', plan: 'Planning' }
      toolCategories:
        read: [files]
        write: [files]
        edit: [files]
        glob: [search]
        grep: [search]
        bash: [shell]
        web_search: [web]
        web_fetch: [web]
        subagent: [delegate]
        subagent_fork: [delegate]
        workflow: [delegate]
        present: [deliver]
        todo_write: [plan]
        ask_user_question: [plan]
    assessment:
      enabled: true
      onFailure: ask
    loopDetection:
      enabled: true
      maxRepeats: 2
```

Keep approval prompts enabled: an `ask` in `enforce` is a denial when approvals
are unavailable.

### 5.3 Swarm mode with a custom persona

```yaml
    mode: swarm
    swarm:
      presets: [orchestrator, architect, writer, reviewer, researcher, operator]
      personas:
        operator:
          description: 'Runs a documented procedure and records the evidence'
          instructions: >-
            You run a documented procedure. Follow the runbook in order and
            record the evidence; stop at the first unexpected result.
```

Start a session with a preset, call `swarm_enter`, then `swarm_assign` can route
to `operator`.

### 5.4 Per-preset policy only

```yaml
    mode: enforce
    presets:
      reviewer:
        policy:
          default: deny
          allow: [read, glob, grep, bash, todo_write, ask_user_question, skill]
```

The reviewer keeps read/check tools and loses every write/network/delegation
tool that is not allow-listed. Deterministic, no model round-trip.

### 5.5 Change nothing but the endpoint from Settings

Use **Settings → Decision model**; the save writes the profile row. If you also
hand-edit the profile patch later, restate the fields the row needs — the
override is wholesale.

---

## 6. Validate and apply

| Step | Command / place |
|---|---|
| Composed tree | `dsh --profile <name> --dump-config` |
| Live config and behavior | `systemone_status()` and `systemone_status({ probe: true })` |
| Settings page (Web) | Settings → Decision model |
| Feature toggles and recent decisions | `systemone_status().layer` |
| Bundle tests | `cd packages/dsh-systemone && pnpm install && pnpm test` (or `node test/run.mjs` with dependencies available) |

Reload requirements:

| Change | Apply |
|---|---|
| Volatile field via Settings or profile patch | Next decision, no reload |
| Non-volatile field in profile patch | Reload the app (or restart) |
| Preset rows / bundle list / install/remove | Reload or restart |
| `apiKeyRef` change | Next decision (volatile); the Settings page follows the updated config snapshot |

---

## 7. `@local/objective-engine` configuration

The row (every field optional; the engine runs on defaults without a profile
row; a profile row replaces the bundle row's config wholesale):

```yaml
- id: objective-engine
  name: '@local/objective-engine'
  config:
    maxActiveObjectives: 3
    maxRoundsPerObjective: 12
    verifierPresets: [verifier, reviewer]
```

### 7.1 Authority and admission

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | When false every tool returns `engine-disabled`; the registry still loads. |
| `dataDir` | `$DSH_HOME/storages/objective-engine` | Journal, advisory log, snapshot, `LOCK`, optional `PAUSED`. |
| `requireHumanAuthority` | `true` | Creation, control, ack, and resume need a direct human message in a top-level session. Only turn it off for test harnesses. |
| `allowAgentProposedObjectives` | `false` | An agent turn may create a `proposed` objective that a human approves with `objective_control`. |
| `maxActiveObjectives` | `3` | Objectives in `active`, `verifying`, or `awaiting-human`; more queue. |
| `maxQueuedObjectives` | `32` | Durable queue depth; beyond it creation is `admission-rejected`. |
| `maxObjectivesPerOwnerSession` | `3` | Open objectives one session may own. |
| `maxQueueAgeMs` | 7 days | A queued objective older than this blocks `queue-expired`. |
| `duplicateWindowMs` | 24 h | Same owner + normalized statement within the window is `duplicate-objective` (pass `allowDuplicate`). |

### 7.2 Measured load

| Field | Default | Meaning |
|---|---|---|
| `maxItemsPerObjective` | `16` | Item creation gate (also the `items` budget maximum). |
| `maxActiveItemsPerObjective` | `2` | Concurrent dispatched items per objective (`concurrency` budget). |
| `maxInFlightItemsGlobal` | `4` | Host-wide dispatch concurrency; beyond it `objective_dispatch` is `admission-busy` and work wakeups pause. |
| `maxConcurrentVerifierRuns` | `1` | Verifier backlog cap. |
| `maxVerifierRunsPerObjective` | `6` | `verifierRuns` budget maximum. |
| `maxVerifierRunsPerObjectivePerDay` | `6` | Rate cap per objective. |
| `maxDispatchesPerHour` | `12` | Host-wide dispatch rate. |

### 7.3 Per-objective budgets and deadlines

| Field | Default | Meaning |
|---|---|---|
| `maxRoundsPerObjective` | `12` | Admitted engine prompts (`rounds`); exhaustion blocks `budget-exhausted`. |
| `maxTokensPerObjective` | `2000000` | `tokens` budget, measured as the owner session's `ctx.tokenMeter` delta since creation when the meter is composed. |
| `maxWallTimePerObjective` | 24 h | `wallTimeMs` from activation. |
| `stallTimeoutMs` | 30 min | A dispatched item with no report or heartbeat fails `stall`. |
| `maxConsecutiveWorkerFailures` | `3` | Then the objective blocks `worker-failures`. |
| `maxVerificationRejects` / `maxVerificationInconclusives` | `2` / `2` | Then the objective blocks `verification-failed`. |
| `maxAckAgeMs` | 7 days | `awaiting-human` longer than this blocks `human-ack-timeout`. |
| `ackReminderMs` | 24 h | One ack reminder per interval. |

A budget set at creation (`objective_create { budget: {…} }`) may be lower
than these maxima, never higher. `objective_control budget-raise` raises it.

### 7.4 Driver timing

| Field | Default | Meaning |
|---|---|---|
| `progressIntervalMs` | `45000` | A "plan the next step" prompt is due this long after the last wakeup when nothing is open. |
| `minWakeGapMs` | `8000` | Minimum gap between two prompts to one session. |
| `tickMs` | `20000` | Sweep resolution (deadlines, queue promotion, timer prompts). |

### 7.5 Dispatch and verification

| Field | Default | Meaning |
|---|---|---|
| `subagentProvider` | `spawn` | Provider name the engine passes to `startActivation`. |
| `workerMaxDepth` | `1` | Extra delegation levels allowed below the owner (the subagent service treats `maxDepth` as an absolute depth: a root owner may start a depth-1 worker; `0` would forbid the worker itself). |
| `verifierPresets` | `[verifier, reviewer]` | Tried in order; a candidate equal to the producer's preset is skipped. |
| `requireCommitPin` | `false` | When true `objective_verify` fails `commit-unavailable` outside a git checkout. |
| `snapshotEvery` | `128` | Events between snapshots. |

### 7.6 Deterministic checks (the checker)

The engine executes `command` and `artifact` criteria itself before starting a
verifier child. A failing check returns `mechanical-check-failed` with the exit
code and bounded output and consumes no verifier run. See [`checker.md`](checker.md).

| Field | Default | Meaning |
|---|---|---|
| `checkerExecute` | `true` | Run command/artifact criteria in the engine. Set `false` to fall back to verifier-run evidence when no host subprocess service is available. |
| `checkerTimeoutMs` | `120000` | Default per-check timeout (a criterion may set a lower/higher `timeoutMs`, capped by the ceiling). |
| `checkerMaxTimeoutMs` | `3600000` | Ceiling for a per-check timeout. |
| `checkerMaxOutputBytes` | `65536` | Bounded stdout/stderr captured for each check (`stdoutExcerpt`/`stderrExcerpt` are tail-limited too). |

### 7.7 Advisory classifier

| Field | Default | Meaning |
|---|---|---|
| `classificationCallsPerHour` | `60` | Rate cap on `objective_classify` + auto-tags. |
| `classification.enabled` | `true` | Master switch. |
| `classification.autoTag` | `true` | Tag incoming human messages in owner sessions. |
| `classification.objectiveProbability` | `0.7` | `is_objective` needed for `new_objective`. |
| `classification.progressProbability` | `0.6` | `is_objective` must be below this for `attach`. |
| `classification.choiceFloor` / `confidenceFloor` / `margin` | `0.35` / `0.3` / `0.1` | Otherwise `ambiguous`. |
| `classification.breakerFailures` / `breakerCooldownMs` | `3` / `300000` | Circuit breaker after consecutive failures. |
| `classification.maxActiveObjectivesInPrompt` | `5` | Objectives listed in the question. |

Tools: `objective_create`, `objective_status`, `objective_plan`,
`objective_dispatch`, `objective_report`, `objective_verify`,
`objective_verdict`, `objective_ack`, `objective_control`, `objective_system`,
`objective_classify`.

Notes:

- **The engine boots paused** on every host start, and objectives that were
  active are paused and disarmed. `objective_system { action: "resume" }` from
  a human turn in a top-level session arms the driver; `resumeAll: true` also
  resumes the objectives the restart paused. No field overrides this.
- **The journal is hash-chained** (`opm/v1`), fsynced per event, torn-tail
  repaired, and validated from genesis on every load. A gap or mismatch makes
  the engine `degraded` (read-only). Back the directory up before any manual
  repair; the engine never deletes it.
- **`PAUSED`** in the data directory forces a paused boot and refuses resume
  until removed; **`LOCK`** keeps a second host process on the same directory
  degraded.
- The row needs no Web client. When the systemone browser half is composed, its
  Swarm panel renders the engine snapshot as an **Objectives** block.
- Applying a config change reloads the row; journal state is preserved and the
  engine returns paused.
