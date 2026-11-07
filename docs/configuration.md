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
- **Row ids are handles.** The shipped ids are `systemone`, `preset-orchestrator`,
  `preset-architect`, `preset-writer`, `preset-reviewer`, `preset-researcher`.
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
| `orchestratorTools` | 16 coordination tools (see below) | Tools the orchestrator keeps while in swarm mode; everything else is hidden from it. |
| `personas` | five role personas | Persona catalog for `swarm_assign`: id → `{ description, instructions }`. An empty map falls back to the built-in catalog. |

Swarm membership is a per-session mode: `mode: swarm` affects only sessions
that entered with `swarm_enter`. There is no preset list; the retired
`swarm.presets` field was removed in 0.2.1 and is ignored if an old patch sets
it.

Default `orchestratorTools`:

```text
read, read_image, glob, grep, todo_write, ask_user_question,
subagent, subagent_fork, workflow, present, skill,
swarm_assign, swarm_enter, swarm_exit, systemone_ask, systemone_status
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

The bundle has no top-level config. It declares five preset rows. Each row is an
`@deepseek-ai/dsh-agent-preset` instance whose `config.plugins` is the session's
whole capability set.

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

### 3.2 Row types used by the five presets

| Row `name` | Config keys used | Notes |
|---|---|---|
| `@deepseek-ai/dsh-persona` | `prefix` | Role instructions; keep `complete: false` semantics (the default) so tool guidance and runtime context remain |
| `@deepseek-ai/dsh-agent-instructions` | `maxBytes: 65536` | Loads workspace instruction files; absent in writer/researcher |
| `@deepseek-ai/dsh-time-context` | — | Date/time context |
| `@deepseek-ai/dsh-tool-fs` | `read`, `readImage`, `write`, `edit`, `applyPatch` | All presets set `applyPatch: false`; reviewer enables read/write/edit without patch |
| `@deepseek-ai/dsh-tool-fs-search` | — | `glob`/`grep` |
| `@deepseek-ai/dsh-tool-bash` | — | Shell; absent in writer |
| `@deepseek-ai/dsh-tool-web` | `fetch`, `searchTimeoutMs` | Writer/researcher set a 60 s search timeout |
| `@deepseek-ai/dsh-tool-todo` | `allowParallelInProgress` | Orchestrator/researcher allow parallel in-progress items |
| `@deepseek-ai/dsh-tool-ask-user` | — | Human interaction |
| `@deepseek-ai/dsh-tool-present` | — | Deliverable presentation; absent in orchestrator/reviewer |
| `@deepseek-ai/dsh-skill-filesystem` + `@deepseek-ai/dsh-tool-skill` | — | Skill catalog and tool |
| `@deepseek-ai/dsh-tool-subagent-control` | — | Subagent inspection/control |
| `@deepseek-ai/dsh-tool-subagent` | `provider`, `toolName`, `modelSelection`, `modelDiscovery` | Orchestrator only; `provider: spawn` and `provider: fork` on two rows |
| `@deepseek-ai/dsh-workflow-ptc` + `@deepseek-ai/dsh-tool-workflow` | `provider: spawn` | Inside the `delegation` group (orchestrator only) |
| `cordis:group` + compaction rows | `isolate.compaction: true` | Every preset has one; `compaction-basic` + `command-compact` |

The underlying `tool-subagent` supports `agentPreset` and
`allowedAgentPresets` in 0.2.2-rc.1. The bundle leaves them unset, so a child
inherits its parent's preset. Set them on the orchestrator's subagent rows if
you want specialized children without swarm mode.

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
