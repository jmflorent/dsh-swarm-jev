# The System One decision layer

`@local/systemone` (bundle directory
[`packages/dsh-systemone`](../packages/dsh-systemone), version 0.2.1) integrates
DSH with a **self-hosted decision model**. It gives the agent two surfaces over
one HTTP endpoint — model-invoked tools, and a decision layer that consults the
endpoint on the harness's extension points — plus swarm mode, which is the
orchestrator workflow built on top of both.

The decision model answers typed questions with calibrated numbers. It does not
write prose, explain itself, or touch harness state. That constraint is the
design: the model is consulted where a probability is useful, and every
mutation still happens through an explicit DSH tool.

---

## Contents

1. [Surfaces and endpoint](#surfaces-and-endpoint)
2. [Wire contract](#wire-contract)
3. [Tools](#tools)
4. [Decision layer: extension points](#decision-layer-extension-points)
5. [Modes](#modes)
6. [Tool selection (`agent/pre-step`)](#tool-selection-agentpre-step)
7. [Call assessment (`tools/pre-execute`)](#call-assessment-toolspre-execute)
8. [Deterministic persona policy](#deterministic-persona-policy)
9. [Model-judged persona rule](#model-judged-persona-rule)
10. [Loop guard](#loop-guard)
11. [Skill hints and model routing (opt-in)](#skill-hints-and-model-routing-opt-in)
12. [Per-preset overrides](#per-preset-overrides)
13. [Swarm mode](#swarm-mode)
14. [Settings screen and configuration](#settings-screen-and-configuration)
15. [Images and the vision limitation](#images-and-the-vision-limitation)
16. [Endpoint compatibility](#endpoint-compatibility)
17. [Safety defaults and failure behavior](#safety-defaults-and-failure-behavior)
18. [Diagnostics](#diagnostics)
19. [Known limitations](#known-limitations)

---

## Surfaces and endpoint

| Surface | Invoked by | What it does |
|---|---|---|
| **Tools** | The model | `systemone_ask` (batched typed questions) and `systemone_status` (configuration, last call, decision-layer state, optional connectivity probe) |
| **Decision layer** | DSH hooks | Tool selection, per-call assessment, deterministic persona policy, model-judged persona rules, loop detection, optional skill hints and model routing |
| **Swarm mode** | The model | `swarm_enter` / `swarm_assign` / `swarm_exit` — a session-scoped orchestrator mode that uses the decision model for stage assignment and call judging |
| **Settings page** | The human | **Settings → Decision model** in the Web UI: endpoint, model, timeout, mode, and API key, applied live |

All three talk to one endpoint, configured as `endpoint`. It receives
`POST` requests containing JSON `{ state, questions, model }` and returns
`{ answers, model?, usage? }`. Authentication is an optional Bearer token
resolved from the credential reference in `apiKeyRef`
(default `SYSTEMONE_API_KEY`).

The endpoint is **yours**: a Jev-style System One deployment is what this kit
was built against, but any service that implements the same contract works. See
[Endpoint compatibility](#endpoint-compatibility).

---

## Wire contract

### Request

```json
{
  "state": {
    "task": "The current task or evidence the questions are about"
  },
  "questions": {
    "question_id": {
      "type": "noul",
      "instructions": "Does the state satisfy this yes/no statement?",
      "boundary": {
        "true": "What counts as yes",
        "false": "What counts as no"
      }
    }
  },
  "model": "the model id sent with every request"
}
```

| Question type | `criteria` | Answer shape | Meaning |
|---|---|---|---|
| `noul` | — (optional `boundary`) | `{ "noul": 0.83 }` | Probability that the yes/no statement holds |
| `choice` | Non-empty map of label → description | `{ "choice": "label", "probabilities": {…}, "confidence": 0.7? }` | Exactly one declared label |
| `score` | Array of ≥ 2 level descriptions, lowest first | `{ "score": 1.5, "legend": {…}, "probabilities": {…}, "confidence": 0.6? }` | Position on an ordered scale; may fall between levels |
| `box` | — | `{ "box": { "top", "bottom", "left", "right" }, "confidence": 0.9? }` | Fractions of an attached image; requires `images` |

### Response

```json
{
  "answers": {
    "question_id": { "noul": 0.83 }
  },
  "model": "the model that answered",
  "usage": { "inputTokens": 812, "outputTokens": 96, "costUsd": 0.0012 }
}
```

- A response without an `answers` object is treated as "not a System One
  endpoint" and reported as a structured error, not silently accepted.
- An answer whose shape does not match the question is **not coerced**: its id
  is returned in `unmatched` and omitted from `answers`.
- `usage` fields are read under both camelCase and snake_case spellings and
  passed through when present.
- Every request is bounded by `timeoutMs`, `maxQuestions`, `maxRequestChars`
  (JSON) or `maxRequestBytes` (multipart), and `maxResponseChars`.

---

## Tools

### `systemone_ask`

Ask the decision model a batch of typed questions about one state.

**Parameters**

| Parameter | Required | Type | Description |
|---|---|---|---|
| `state` | yes | JSON | The evidence to judge: task, question, or facts. Bounded by `maxStateChars` in the layer; the tool sends what you give it. **Transmitted to the endpoint.** |
| `questions` | yes | object | Map of question id → `{ type, instructions, criteria?, boundary? }`. At most `maxQuestions` (default 64). |
| `images` | no | JSON | Array of `{ path, name? }` PNG/JPEG files for vision-capable endpoints. Changes the request to `multipart/form-data`. |

**Question rules** (malformed questions throw before a request is built):

- `type` must be one of `noul`, `choice`, `score`, `box`.
- `instructions` is required and must state the question.
- `choice` needs a non-empty label → description map.
- `score` needs an array of at least two level descriptions in ascending order.
- `box` needs a non-empty `instructions` naming what to locate, and the call
  must include `images`.
- `noul` may carry `boundary: { true, false }` when the line between yes and no
  is not self-evident. Boundaries improve interpretability; they do not change
  the answer's meaning.

**Output**

| Field | Meaning |
|---|---|
| `ok` | Whether the request produced a parseable answer set |
| `endpoint`, `model` | Where the call went and which model answered |
| `answers` | Map of question id → normalized answer |
| `unmatched` | Question ids whose answers did not match their expected type |
| `usage` | Token/cost usage when the endpoint reports it |
| `latencyMs` | Wall-clock time of the call |
| `error`, `status`, `detail` | On failure: a domain error, HTTP status when available, bounded response detail |

Provider problems are returned as values (`ok: false`), not thrown, so the
calling model receives structured facts it can act on. Caller bugs (bad
arguments) throw.

**Example**

```json
{
  "state": { "task": "Should this pull request be split before review?" },
  "questions": {
    "too_big": {
      "type": "noul",
      "instructions": "Is this change too large to review as one unit?",
      "boundary": {
        "true": "More than one independent change is bundled together",
        "false": "One coherent change that a reviewer can hold at once"
      }
    },
    "split": {
      "type": "choice",
      "instructions": "How should this change be split?",
      "criteria": {
        "none": "Do not split",
        "by_area": "Split by subsystem",
        "by_risk": "Split mechanical changes from risky ones"
      }
    }
  }
}
```

### `systemone_status`

Reports configuration and state without changing anything:

- `endpoint`, `model`, and `auth` — `auth` says whether a credential resolved,
  **never its value**.
- `lastCall` — tool, ok, latency, error of the most recent call.
- `layer` — the decision layer's `status()` payload (see
  [Diagnostics](#diagnostics)).
- `probe` — with `probe: true`, sends one tiny `noul` question ("Does 2 plus 2
  equal 4?") to verify end-to-end connectivity. This consumes a little of the
  decision model.

```json
{ "probe": true }
```

Use this first whenever something looks wrong. It is safe to call in any mode,
including `off`.

### `swarm_enter`, `swarm_assign`, `swarm_exit`

The swarm tools. They are covered in [Swarm mode](#swarm-mode); their full
parameter and output shapes are:

| Tool | Parameters | Output |
|---|---|---|
| `swarm_enter` | `note?` — why the session is entering | `{ ok, active, personas[] }` |
| `swarm_assign` | `stage` (required, non-empty), `needs?`, `context?` (JSON), `candidates?` (array of persona ids) | `{ ok, persona, description, instructions, choices[], latencyMs }` or `{ ok:false, error, latencyMs }` |
| `swarm_exit` | `note?` — why the session is leaving | `{ ok, active }` |

---

## Decision layer: extension points

The layer installs itself on four harness extension points. In `off` mode it
does nothing at all; in `shadow` it computes and records; in `enforce` it
narrows behavior.

| Extension point | Decision | Effect in `enforce` |
|---|---|---|
| `agent/pre-step` | Which declared tool **categories** this step needs | `agent.ctx.tools.restrict({ allow })`, recomputed every step |
| `tools/pre-execute` | Per-call assessment: restriction conflict, missing information, task match, optional persona rule | `ask` (or `cancel` with `onFailure: hold`); a low task-match score alone never gates |
| `tools/result` + `tools.guard` | Deterministic repeated-call detection | Denies a repeat after `maxRepeats` |
| `agent/pre-step` | Optional skill hint and model route | One skill notice; `agent.model.select()` for the **next** step |

Composition rules the layer follows:

- **Monotonic.** A decision can only narrow: a downstream `deny` or `cancel`
  survives, a restriction only intersects, and no decision ever re-allows a
  call another guard denied.
- **Fail to ask, not allow.** A provider failure in `enforce` produces `ask`
  (or `cancel` when `assessment.onFailure: hold`), never a silent allow.
- **Stale decisions are discarded.** If the task snapshot changes while a
  decision is in flight, the decision is dropped rather than applied to the
  wrong step.
- **Bounded.** State text, tool arguments, selection catalogs, selected tools,
  question counts, and response sizes all have caps.

---

## Modes

`mode` is one of four values:

| Mode | What runs | Effect on behavior | Typical use |
|---|---|---|---|
| `off` | Nothing | None. The layer installs no hooks; the tools still work | Debugging, or when you want the tools without automation |
| `shadow` | Selection, assessment, policy, judge, loop observation | None. Decisions are logged and kept in `systemone_status.layer.recent` | Calibration and rollout |
| `enforce` | All enabled features | Decisions narrow behavior for every session | After calibration |
| `swarm` | All enabled features, only for sessions that entered swarm mode | Sessions that called `swarm_enter` are enforced and judged; every other session is `off` — no selection, no assessment, no policy, no model calls | Orchestrator-led work |

Notes:

- **`swarm` requires entering.** With `mode: swarm`, a session is inert until it
  calls `swarm_enter`. That is intentional: the orchestrator (and any lead
  session) never blocks itself, because it decides when to enter.
- **`shadow` is the default.** Nothing changes behavior until you opt in.
- **`enforce` + disabled approvals = denial.** A `ask` decision becomes a denial
  when DSH approval prompts are unavailable or disabled. Keep approvals enabled
  while enforcing.
- **Per-preset `mode` overrides** (`presets.<id>.mode`, one of `off`, `shadow`,
  `enforce`) replace the top-level mode for sessions running that preset. They
  are documented in [Per-preset overrides](#per-preset-overrides).

---

## Tool selection (`agent/pre-step`)

Selection narrows the tool surface for the step about to run, based on what the
current task needs.

**Configuration**

```yaml
selection:
  enabled: true              # volatile: can be toggled live
  alwaysAllow: []            # escape hatch, never narrowed
  categories:                # category id -> description shown to the model
    files: Reading and writing files
    search: Finding code and text
    shell: Running commands
    web: Searching and fetching the web
    delegate: Delegating to subagents
    deliver: Presenting deliverables
  toolCategories:            # tool name -> category ids; tools not listed are never narrowed
    read: [files]
    write: [files]
    edit: [files]
    glob: [search]
    grep: [search]
    bash: [shell]
    web_search: [web]
    web_fetch: [web]
    subagent: [delegate]
    workflow: [delegate]
    present: [deliver]
```

**Behavior**

1. Builds the catalog from tools that are actually visible to the agent and
   have a `toolCategories` entry. Tools without one are out of scope by design.
2. Asks one `noul` question per category: "Does the current task need the
   `<category>` capability?"
3. Keeps categories whose probability is ≥ `thresholds.selection` (default
   `0.25`), plus `selection.alwaysAllow`, `systemone_ask`, `systemone_status`,
   and every tool with no declared category.
4. Caps the kept tools at `maxSelectedTools` (default 24).
5. In `enforce`, calls `agent.ctx.tools.restrict({ allow })` for the step.

**Safety guards** (all fail open to the full tool set):

- More categories than `maxCategories` (default 48): selection is skipped and a
  warning is logged.
- A restriction that would leave less than 15% of the tools (and fewer than 3):
  skipped as more likely a bad decision than a real narrowing.
- `restrict()` rejects the whole filter if it names a tool registered on the
  agent's own layer (visible but not restrictable). The layer trims exactly the
  names the rejection reports and retries once; any other failure is logged and
  the restriction is abandoned.
- `selection.alwaysAllow` should contain the tools you cannot afford to lose.
  The author's profile uses `bash`, `edit`, `glob`, `grep`, `read`, `write` as
  the escape hatch.

**When it mostly does nothing:** scoped tools mounted by a preset are not
restrictable by this mechanism, so selection mostly affects host-level tools.
With an empty `toolCategories`, selection skips itself entirely (debug log
"no tool categories configured").

---

## Call assessment (`tools/pre-execute`)

Assessment runs on the policy chain for each tool call, **after** the rest of
the chain, so it composes with other guards rather than replacing them.

**Questions** (one batched request per gated call):

| Id | Type | Question | Gates? |
|---|---|---|---|
| `matchesTask` | `noul` | "Does calling this tool with these arguments serve the current task?" | No — low match is recorded as a note |
| `missingInformation` | `noul` | "Is the call missing information or based on an unverified assumption that a human should resolve first?" | Yes, at `thresholds.missingInformation` (0.5) |
| `violatesRestriction` | `noul` | "Does the call conflict with an explicit restriction or safety boundary for this task?" | Yes, at `thresholds.restriction` (0.5) |
| `risk` | `score` | "How risky is running this call?" (levels `harmless`, `recoverable`, `costly`, `irreversible`) | Only when `assessment.includeRiskScore: true`; recorded |
| `persona` | `noul` | The per-preset `judge.instructions` question | Yes, at `thresholds.restriction` (0.5) |

**Decision mapping**

- `persona` violation or `violatesRestriction` ≥ threshold → `ask` with a reason
  containing the probability.
- `missingInformation` ≥ threshold → `ask`.
- Downstream already returned `ask` → that answer survives (assessment does not
  downgrade it).
- `assessment.onFailure: hold` makes provider failures `cancel`; default `ask`
  makes them an approval prompt.
- `assessment.enabled: false` disables assessment **and the model judge**
  (the judge is a question inside assessment).

**Never gated:** `swarm_enter`, `swarm_exit`, and `swarm_assign`. A session must
always be able to leave the mode and ask for an assignment, even when the model
would hold an ordinary call.

**Cost:** one decision round-trip per gated tool call when assessment is
enabled. Set `mode: shadow` and watch `layer.stats.assessments` to estimate the
cost before enforcing.

---

## Deterministic persona policy

The deterministic half of per-persona enforcement. It runs synchronously with
**no model call**, so it is cheap, predictable, and a good place to encode hard
persona boundaries.

Evaluated in order for each tool call:

1. Tool name in `policy.deny` → **deny**.
2. `policy.default: deny` and the tool is neither in `policy.allow` nor given a
   rule → **deny**.
3. A per-tool rule with `deny: true` → **deny**.
4. A rule's `commands.deny` patterns (regular expressions) test a bash
   `command` argument. A command rule with no declared command → **deny**
   (fail closed).
5. A rule's `paths.allow` / `paths.deny` globs test the declared path
   (`file_path` or `path`). `paths.deny` wins. A path rule with no declared
   path → **deny** (fail closed).

Rules only ever restrict. `policy.allow` means "the policy has no objection", not
"allow this even if another guard denied it".

**Glob semantics:** `**` crosses directory separators (`**/` also matches zero
directories), `*` and `?` never do, and both `/` and `\` are treated as `/`.

**Example — reviewer policy** (profile patch, sanitized):

```yaml
presets:
  reviewer:
    policy:
      default: allow
      tools:
        write:
          paths:
            allow:
              - '**/samples/**'
              - '**/fixtures/**'
              - '**/*.csv'
        edit:
          paths:
            allow:
              - '**/samples/**'
              - '**/fixtures/**'
              - '**/*.csv'
        bash:
          commands:
            deny:
              - '(^|\s)(rm|mv|dd|truncate)\s'
              - '(^|\s)git\s+(commit|push|reset|clean)\s'
              - '(^|\s)(npm|pnpm|yarn)\s+(install|add|remove)\s'
```

In `shadow` a deny is recorded but not applied; in `enforce` it denies the call
with a `[systemone]` reason.

---

## Model-judged persona rule

The probabilistic half. A per-preset natural-language allowance that the
decision model evaluates against every gated tool call. It catches indirect
violations that no deterministic pattern can enumerate — an interpreter writing
a source file, a build step rewriting sources, a command that fetches and
executes — at the cost of one question inside the assessment request.

```yaml
presets:
  verifier:
    judge:
      instructions: >-
        The verifier may read source, run tests, and write only under
        .objectives/evidence/. It may not modify source files, dependencies,
        or configuration.
      boundary:
        true: The call changes source, dependencies, or configuration
        false: The call only reads, runs checks, or writes an evidence file
```

The judge question is `"Persona rule: <instructions> Does the proposed call
violate that rule?"`; a probability ≥ `thresholds.restriction` (0.5) produces
`ask`. A judge requires `assessment.enabled: true`.
`systemone_status.layer.swarm.judgedPresets` lists presets that have one.

---

## Loop guard

Deterministic and model-free. On `tools/result` the layer counts completed calls
by a bounded identity key: tool name plus canonicalized, truncated, sorted
arguments (with `redactKeys` redacted). On the next call with the same identity:

- the first repeat logs a warning,
- in `enforce`, `maxRepeats` (default 2) or more denies with a message telling
  the model to change the arguments or the approach.

The counter resets on `agent/disposed` and whenever a user-role message enters
the step (a human intervention is a fresh start).

---

## Skill hints and model routing (opt-in)

Both ship **disabled** and are marked volatile. Both have caveats; leave them
off unless you are testing the specific path.

| Feature | Config | What it does | Caveat |
|---|---|---|---|
| Skill hints | `skills.enabled` (default false), `skills.injectHint` (true) | Asks a `choice` question over up to 20 model-invocable skills; in `enforce`, injects one user-role notice suggesting the chosen skill | Depends on `agent.inject()` accepting a plugin-sourced notice; unverified end to end in 0.2.2, so it is opt-in and failure-tolerant. |
| Model routing | `modelRouting.enabled` (default false), `modelRouting.routes` | Asks a `choice` question over configured routes; validates the target in the live provider catalog; calls `agent.model.select()` | A step's model is captured before it runs, so routing applies to the **next** step. Unverified end to end; keep off until you observe it working |

---

## Per-preset overrides

`presets` is a map keyed by **preset id**. A session running that preset gets
its own configuration merged over the top-level one. The id is resolved through
the preset registry (`ctx.get('agentPresets').presetForSession`), and every
recorded decision names the detected `preset`.

Keys available per preset:

```yaml
presets:
  reviewer:
    mode: enforce                  # off | shadow | enforce (overrides top-level mode)
    selection:
      alwaysAllow: [read, bash, glob, grep]
      categories: { ... }          # merge over top-level selection.categories
      toolCategories: { ... }      # merge over top-level selection.toolCategories
    assessment:
      onFailure: ask               # ask | hold
      restrictions:
        - no source writes; fixtures only
    thresholds:
      selection: 0.25
      restriction: 0.5
      missingInformation: 0.5
      taskMatch: 0.35
    policy: { ... }                # deterministic policy, replaces the base policy for this preset
    judge: { ... }                 # model-judged rule
```

Merge semantics:

- `mode`, `selection.*`, `assessment.*`, `thresholds.*` merge per key over the
  top-level values (a key you omit keeps the base value).
- `policy` and `judge` are replaced wholesale for that preset; `policy` falls
  back to the top-level `policy` when the preset has none.
- `skills` and `modelRouting` are not per-preset in 0.1.0.

The bundle ships no per-preset overrides by default: they live in the profile
patch, where deployment-specific taxonomies and thresholds belong. The author's
profile configures all five role presets; the example patch shows the shape.

---

## Swarm mode

Swarm mode turns one session into an orchestrator and uses the decision model
for stage assignment and call judging. It is a **session mode**, not a preset
and not a new agent type — the same way plan mode is a mode, not a preset.

### How it works

```text
mode: swarm  +  session calls swarm_enter
     │
     ├─ orchestrator policy notice injected (delegation-only behavior)
     ├─ orchestrator tool surface restricted to coordination tools
     ├─ swarm_assign(stage, needs, context) ──► decision model
     │      returns persona + description + operating instructions
     ├─ orchestrator dispatches a subagent with those instructions and a
     │      self-contained brief (persona travels in the brief)
     ├─ every gated tool call is assessed (and judged per preset)
     └─ swarm_exit restores an inert session
```

### Entering and leaving

`swarm_enter`:

- adds the session to the in-memory swarm set;
- applies the orchestrator restriction immediately and re-applies it from
  `agent/pre-step` before each step's tool schema assembles;
- injects a policy notice (a user-role plugin notice) that tells the model it is
  the orchestrator: maintain an explicit workplan, never do stage work, call
  `swarm_assign` for every stage, dispatch with the returned persona, treat a
  hold/ask as a signal, and integrate rather than produce;
- returns `{ ok, active: true, personas: [...] }` — the configured persona ids,
  so the orchestrator knows the catalog.

`swarm_exit` removes the session from the set, lifts the restriction, and leaves
the session inert (`off`). No other session is affected at any point.

### `swarm_assign`

Sends one `choice` question to the decision model:

- **stage** (required, non-empty): the workplan stage — goal, inputs,
  acceptance criteria. Clamped to 4000 characters.
- **needs**: what the stage needs — evidence, artifacts, skills, constraints.
  Clamped to 2000 characters.
- **context**: optional JSON state sent alongside the stage.
- **candidates**: optional subset of persona ids; filtered against the
  configured `swarm.personas`. Defaults to the whole catalog.

The question's `criteria` are the persona descriptions, so the model chooses
from the catalog it is shown. The answer must be a configured persona id;
anything else returns a structured error. On success it returns
`{ persona, description, instructions, choices, latencyMs }`.

**The answer is the assignment.** The orchestrator is instructed not to pick a
persona itself when `swarm_assign` answers. It then invokes that persona:

- spawn a subagent with the operating instructions and a self-contained brief
  (or `subagent_fork` when the child needs the conversation), or
- execute the stage itself when the assigned persona is the orchestrator.

**Persona is a brief, not a preset switch.** Per-session presets are not
selectable through the subagent tool in this harness release, so the assigned
persona's instructions travel inside the subagent prompt. The child does not
change preset identity.

### Orchestrator tool surface

While in swarm mode, the orchestrator keeps only coordination and reading tools.
The default allow-list (`swarm.orchestratorTools`) is:

```text
read, read_image, glob, grep, todo_write, ask_user_question,
subagent, subagent_fork, workflow, present, skill,
swarm_assign, swarm_enter, swarm_exit, systemone_ask, systemone_status
```

Everything else is hidden from the orchestrator: it does not edit files, run
builds or tests, or write deliverables. Workers keep the full toolset. The list
is configurable in the profile patch; the design document recommends adding the
team tools and future `objective_*` tools to it.

### Persona catalog

`swarm.personas` maps persona id → `{ description, instructions }`:

- `description` becomes the choice criterion the model sees.
- `instructions` are returned to the orchestrator when that persona is assigned.

The default catalog ships the five role personas with descriptions and
instructions that mirror the preset prompts. Empty personas or an empty
orchestrator tool list in the row config fall back to the built-in defaults.

### What is judged in swarm mode

Because a session in swarm mode is `enforce`, every gated tool call runs:

1. the per-preset deterministic `policy`,
2. the assessment questions (task match, missing information, restriction
   conflict, optional risk score),
3. the per-preset `judge` rule when configured.

`swarm_enter`/`swarm_exit`/`swarm_assign` are never gated. Every decision is
recorded with the detected `preset` and visible in `systemone_status`.

### Swarm mode caveats (read these)

- **Swarm membership is session-scoped.** With `mode: swarm`, only sessions
  that call `swarm_enter` are enforced; every other session stays inert,
  regardless of preset. The retired `swarm.presets` field was removed in 0.2.1 —
  a stale profile patch that still sets it is ignored.
- **Membership is process-local.** It is a `Set` in the plugin runtime and does
  not survive a restart. Re-enter swarm mode after reloading DSH.
- **Entering is explicit.** There is no automatic trigger; the model must call
  `swarm_enter` (or you instruct it to). Other sessions stay inert.
- **A swarm orchestrator cannot work.** The tool restriction is enforced; if
  the model ignores it and says it edited a file, it is reporting an action it
  could not perform.
- **Cost.** Every gated call is one decision round-trip when assessment is
  enabled (plus the assignment calls). Watch `layer.stats` in `shadow` first.

---

## Settings screen and configuration

`@local/systemone` 0.2.1 ships a browser-side Settings section:
**Settings → Decision model**. It edits the live settings an operator needs day
to day, so you do not have to hand-edit YAML for them. The page is the browser
half of the same package (`lib/client.js`, declared by `dsh.client` in
`package.json`, `platform: "web"`) and injects the client services
`@deepseek-ai/dsh-client-locale`, `@deepseek-ai/dsh-client-ui-settings`, and
`@deepseek-ai/dsh-api-remotes`.

### Fields

| UI field | Config field | Behavior |
|---|---|---|
| **Endpoint URL** | `endpoint` | Validated as a full `http(s)` URL; written live |
| **Model id** | `model` | Trimmed, required; the value sent on every request |
| **Timeout (ms)** | `timeoutMs` | Integer ≥ 500 |
| **Decision layer mode** | `mode` | `off` / `shadow` / `enforce` / `swarm` |
| **API key** | credential named by `apiKeyRef` | Password field; blank keeps the current key; **Clear key** removes it |
| **Credential reference** | `apiKeyRef` | Read-only line showing the reference the key is stored under (default `SYSTEMONE_API_KEY`) |

Save writes only the fields that changed. If the settings changed elsewhere
first, the page reports a conflict, reloads the latest values, and asks you to
review and save again instead of overwriting.

### Live apply, no restart

`endpoint`, `model`, `apiKeyRef`, `timeoutMs`, `mode`, and the five feature
toggles are `.volatile()` in the Config schema. The host delivers them as live
references; `lib/decisions.js` (`bindLive`) turns them into getters on the
runtime settings object. Every tool and decision reads the runtime settings at
call time, so a Settings save is visible at the **next** decision without a
bundle reload.

Structural changes — installing the bundle, adding preset rows, changing the
profile bundle list — still need a reload or restart. Swarm-session membership
is in-memory and is not restored either.

### Where a save is persisted

The page writes through the host's config-forms service (`ctx.configForms` for
the plugin entry id `systemone`). The Host persists the values in the **active
profile's Cordis patch** — the same `cordis.patch.yml` a human would edit. So:

- a Settings change is durable profile state, not a browser-local preference;
- it becomes a row override, and a row override replaces the bundle's `config`
  wholesale, so the row must restate every deployment field it needs;
- each profile keeps its own endpoint, model, and key.

### API key and credentials

- The page writes the key through `ctx.remote.credentials.set(ref, key)`, reads
  whether one is configured with `describe([ref])`, and removes it with
  `unset(ref)`. The value never goes into the settings file.
- `ref` is the row's `apiKeyRef` (default `SYSTEMONE_API_KEY`). The plugin
  resolves it at call time through `ctx.credentials.resolve`, then the process
  environment.
- `systemone_status` reports only `auth: "credential configured"` or
  `"no credential (requests carry no auth header)"`; the key is never returned,
  logged, or written by the plugin.
- A deployment that supplies `SYSTEMONE_API_KEY` externally can leave the field
  blank. **Clear key** removes a key stored in the credential service.

### It needs the Web client

The page appears only in a composition that includes the DSH Web client
(`dsh.client.platform: "web"`). Headless and CLI deployments do not load client
plugins, so the same fields remain editable in the profile patch. That is
expected, not a failure: the host half of the bundle works without the browser
half.

### Precedence

From lowest to highest:

1. **Code defaults** (`Config` schema and `resolveSettings` base). The public
   copy uses generic placeholders — `http://127.0.0.1:8008/v1/systemone` and
   `decision-model` — so set your endpoint and model.
2. **Bundle row config** (`packages/dsh-systemone/cordis.patch.yml`): plain,
   intentionally minimal defaults.
3. **Profile patch row override** (`~/.dsh/profiles/<profile>/cordis.patch.yml`,
   row id `systemone`): applied after every bundle layer and replaces the row
   config wholesale. Settings saves write here.
4. **`--patch` overlays** passed to the DSH launcher: applied last.

Non-volatile settings — limits, taxonomy, thresholds, policy, judge, swarm
catalog — have no Settings field; edit the profile patch. See
[`docs/configuration.md`](configuration.md) for every field.

## Right-sidebar swarm panel

The browser half also registers a **Swarm** tab in the right sidebar. Open the
right sidebar from the conversation header corner, then pick **Swarm** from the
strip's guide — or let it auto-open: a poller opens the tab once when a session
on screen enters swarm mode. The panel is collapsible with the sidebar's own
collapse control, and its header carries a **»** button that collapses it too.

It shows, live:

| Block | Content |
|---|---|
| Decision plane | `mode`, `model`, `endpoint` from the live configuration |
| Swarm sessions | one row per session in swarm mode: its preset and session id, with the on-screen session marked |
| Personas | the `swarm.personas` catalog, with `swarm_assign` counts from the recent feed |
| Recent operations | the last decisions, newest first: tool selection, call assessment, persona policy, loop guard, and `swarm_assign` stage → persona |
| Counters | selections, assessments, loop denials, asks, failures |

The panel polls every 3 s, pauses while the tab is hidden, refreshes on
visibility, and offers a manual refresh button.

When the [`@local/objective-engine`](../packages/objective-engine) bundle is
also composed, the scan adds an **Objectives** block: the engine's paused/running
state, its admission counts (active / queued / blocked / completed), and each
open objective with its round budget. That data comes from the read-only
`objectives` service the engine provides (`snapshot()`), projected by the same
panel endpoint.

The reverse seam is how the engine reaches Mammoth: the systemone host half
provides a read-only `systemone` service (`decide`, `status`) for other host
plugins. The engine's advisory classifier uses it; no other plugin can mutate
the decision layer through it.

### Data path and access

`GET /systemone/panel.json` is registered only where the Web host
(`webServer`) and its connection gate (`connection`) are composed; a headless
profile never exposes it. The handler runs `connection.admit(request)`, which
applies the same Host/Origin fence and browser-session cookie check as `/api`:
a request without an authenticated browser session receives **401**, and a
request from an untrusted Host or cross-site Origin is refused. The payload is
decision metadata only — counters, recent decisions, persona catalog, and
opaque swarm-mode session ids — never prompts, tool arguments, credentials, or
session content.

No configuration controls the panel; disabling the bundle removes both the tab
type and the route.

## Images and the vision limitation

`systemone_ask` accepts `images: [{ path, name? }]` and speaks the TypeSafe
assets protocol for vision-capable decision models:

- the request becomes `multipart/form-data`;
- the first part, named `request`, is the JSON payload with an `assets` map;
- each image is a later `asset-N` part, referenced from the payload as
  `{ assets: { alias: { type: "image", part: "asset-N" } } }`;
- aliases are derived from `name` (or the file's basename) and sanitized to a
  token-like form so they can be referenced literally in `state`;
- only PNG and JPEG are accepted, validated by magic bytes, and each image is
  capped by `maxImageBytes` (default 4 MiB).

**The limitation:** the reference deployment parses the request body as JSON
only. It answers `422` to a multipart request, so image/`box` decisions are
unavailable there. The plugin reports this as an explicit error ("This
deployment accepts application/json only, so it does not support image
assets") instead of silently retrying or dropping the images. Base64 inside
`state` is **not** a substitute: the contract expects assets.

If your endpoint supports multipart assets, the client code is ready. If it does
not, call the tools without `images` and do not use `box` questions.

---

## Endpoint compatibility

The bundle speaks the System One contract, not a vendor-specific SDK. To use a
different decision service, it must accept:

- `POST` with `content-type: application/json` and body
  `{ state, questions, model }` (or the multipart form above for images);
- `Authorization: Bearer <key>` when a credential is configured;
- answer with `{ answers: { <id>: { noul | choice | score | box, … } }, model?,
  usage? }`.

**Jev-style deployments.** The kit was built against a self-hosted Jev/Mammoth
System One service. Deployment specifics vary:

- **Model ids are deployment-specific.** The public examples use
  `decision-model` as a placeholder; set the id your endpoint serves. Jev
  deployments commonly expose several aliases for one model; check `/health`
  on the endpoint (where available) for the served model id.
- **`/health`** is a useful unauthenticated check on many deployments; it is not
  part of the plugin's contract.
- **Auth mode.** Local deployments often need no key; exposed deployments
  usually require a Bearer token in front of the service. Use
  `apiKeyRef: ''` to disable credential resolution entirely.
- **Image support** is the main known incompatibility — see above.
- **Calibration is yours.** The thresholds in this kit were calibrated on the
  author's endpoint against documentation/config tasks. Re-calibrate in
  `shadow` mode for your model and workload.

The plugin does not assume OpenAI-compatible chat completions, embeddings, or
any conversational API. If the endpoint cannot answer the typed contract, the
tools return structured errors; nothing is guessed.

---

## Safety defaults and failure behavior

| Situation | Behavior |
|---|---|
| Provider unreachable / timeout | Tool returns `{ ok:false, status?, error }`. Assessment in `enforce` → `ask` (or `cancel` with `onFailure: hold`). Selection is skipped and the full tool set is kept |
| Response is not JSON / has no `answers` | Structured error naming the contract violation; no coercion |
| Answer shape mismatches the question | Id listed in `unmatched`; omitted from `answers` |
| Endpoint rejects multipart with 422 | Explicit "images unsupported" error |
| Request too large | Throws before sending, with the measured size and the configured cap |
| Restriction would leave < 15% of tools | Restriction skipped; full tool set kept |
| Restriction names scope-local tools | Trim and retry once; otherwise fail open |
| Task snapshot changes mid-decision | Decision discarded; stale counter increments |
| Downstream guard denies/cancels | Evaluation stops; the stricter verdict survives |
| Approval prompts disabled | An `ask` becomes a denial; expected and documented |
| Layer disposed | In-flight decisions are aborted; loop counters and selections disposed |

---

## Diagnostics

Start with:

```text
systemone_status()
systemone_status({ probe: true })
```

The `layer` payload contains:

| Field | What it shows |
|---|---|
| `layer.mode` | Effective top-level mode |
| `layer.endpoint`, `layer.model`, `layer.timeoutMs` | Live configuration |
| `layer.selectionCategories` | Configured category ids |
| `layer.toolCategoryMap` | Tools and their categories |
| `layer.presetOverrides` | Preset ids with any override |
| `layer.policy` | Default and per-preset policy tool names |
| `layer.swarm` | `active` session count, `personas`, `judgedPresets` |
| `layer.features` | Enabled state of selection, assessment, loopDetection, skills, modelRouting |
| `layer.thresholds` | Every probability threshold |
| `layer.stats` | Counters: selections, applied, failures, assessments, asks, holds, loop denials, skill hints, routes, stale discards, failures, last failure |
| `layer.recent` | The last 20 decisions with timestamps, decision kind, mode, preset, tool, action, reason, values |

Shadow mode is the primary calibration tool: run real work in `shadow`, then
read `layer.recent` to see what the layer would have done. Switch to `enforce`
only when the decisions look right.

---

## Known limitations

| Limitation | Detail |
|---|---|
| Skill hints unverified end to end | `agent.inject()` with a plugin-sourced notice is opt-in and failure-tolerant |
| Model routing applies to the next step | A step's model is captured before it runs; routing is unverified end to end |
| Vision unavailable on the reference deployment | Multipart assets; endpoint is JSON-only |
| Swarm membership is in-memory | Re-enter after restart; no durable mode |
| Persona is a brief in swarm mode | Subagent preset switching is not available in this harness release |
| Selection cannot restrict preset-scoped tools | Mostly affects host-level tools; escape hatch via `alwaysAllow` |
| Judgment is probabilistic | `enforce` can deny good calls; keep approvals enabled and calibrate in `shadow` |
| Settings page needs the Web client | Headless/CLI compositions do not load client plugins; edit the profile patch instead |
