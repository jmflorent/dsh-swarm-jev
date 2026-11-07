# Role personas

The [`dsh-personas`](../packages/dsh-personas) bundle (`@local/dsh-personas`
1.0.0) adds five **agent presets** to DSH. A preset is a named capability
composition: the New-session picker offers it, the Settings roster lists it, and
the sessions that select it mount exactly the tool rows the preset declares.

The bundle does not modify or replace the shipped `standard`, `ptc`, `minimal`,
or `cordis` presets. It inserts five role-shaped presets **after** them with
orders 10–14, so the built-ins keep their positions.

| Preset id | Name | Order | One line |
|---|---|---|---|
| `orchestrator` | Orchestrator | 10 | Breaks a goal into delegable workstreams, runs them as subagents, integrates the results |
| `architect` | Architect | 11 | Designs systems from the actual repository and writes decision-complete design documents |
| `writer` | Writer | 12 | Writes and edits prose and documents, matching audience and house style |
| `reviewer` | Reviewer | 13 | Independently validates a change, runs the checks, reports blocking defects with evidence |
| `researcher` | Researcher | 14 | Gathers evidence from primary sources, separates fact from inference, reports with citations |

---

## The five presets

### `orchestrator` — Orchestrator

**Use it when** the goal is larger than one turn and decomposes into independent
workstreams: a migration, a multi-file feature, an audit with parallel angles.
The orchestrator is a manager. It investigates only enough to write precise
briefs, delegates one subagent per independent piece, keeps a todo list of
what is running/done/blocked, verifies claims against the workspace, and
integrates the results.

**Capabilities.** Filesystem read/write/edit, search, bash, web, todo, ask-user,
skills, `present`, subagent control, `subagent` (spawn), `subagent_fork`, and a
scripted `workflow` engine. It is the only preset with delegation rows.

**Not mounted.** `present`; the orchestrator does not produce deliverables, it
integrates them. (It can still write files with `write`/`edit` when it needs to
record the integrated result.)

**Watch out for.** Subagents inherit the session's preset unless the
`tool-subagent` row is configured with `agentPreset`/`allowedAgentPresets`
(0.2.2-rc.1 supports both). The bundle leaves those unset, so a child of an
orchestrator is another orchestrator. If you want role-specialized children, use
swarm mode with `swarm_assign` (the persona travels as the brief's operating
instructions), run roles in separate sessions, or install the official
`@deepseek-ai/dsh-experimental-agent-team-profile` bundle.

### `architect` — Architect

**Use it when** you need a design another engineer can implement without
re-deriving your decisions: module boundaries, APIs, data flow, failure modes,
migration, tests. Grounded in the repository, not in generic advice.

**Capabilities.** Filesystem read/write/edit, search, bash, web, todo, ask-user,
`present`, skills, compaction. It is explicitly instructed to produce designs
and documents, not to implement unless asked.

**Best paired with** the reviewer persona: architect drafts, reviewer attacks
the design against the actual repository.

### `writer` — Writer

**Use it when** the deliverable is prose or a document: README, runbook, spec,
announcement, slide outline. The persona prompt is about audience, purpose,
house style, concrete detail, and honest editing.

**Capabilities.** Filesystem read/write/edit, search, web, todo, ask-user,
`present`, skills, compaction. There is **no bash** row and **no
`agent-instructions`** row: the writer works from what it can read, and does not
load workspace instruction files the way the architect and reviewer do.

**Watch out for.** Without bash it cannot run builds or tests; give it a
reviewer or orchestrator stage when the document must be validated against
generated output.

### `reviewer` — Reviewer

**Use it when** a change must be validated independently and the answer has to
be evidence-backed: run the tests, read the diff, cite `file:line`, order
findings by severity, end with **APPROVE**, **APPROVE WITH NITS**, or **REQUEST
CHANGES**.

**Capabilities.** Read/read-image filesystem, write/edit **enabled** but
`applyPatch` disabled, search, bash, web, todo, ask-user, skills, compaction.
The persona prompt tells it to write only sample/fixture data (`samples/`,
`fixtures/`, `*.csv`) to reproduce a defect.

**Important accuracy note.** The bundle's own README says the reviewer is
read-only with `write: false, edit: false`; the YAML actually mounts
`read: true, readImage: true, write: true, edit: true, applyPatch: false`.
That is deliberate — a reviewer must be able to create a failing fixture — but
it means the **read-only guarantee comes from the System One persona policy**
(`presets.reviewer.policy` in the profile patch), not from the preset alone.
If you install only `dsh-personas`, the reviewer has write tools and the
read-only behavior is prompt discipline, not enforcement. Install
`dsh-systemone` and configure the reviewer policy if you rely on it; see
[`docs/decision-system.md`](decision-system.md#deterministic-persona-policy).

### `researcher` — Researcher

**Use it when** the answer depends on sources: a spec, a repository, a filing, a
paper, a changelog, a current event. The persona prompt insists on primary
sources, dates and versions, an explicit fact/inference/unknown split, and "never
cite a URL you did not open."

**Capabilities.** Filesystem read/write/edit, search, bash, web (with a 60 s
search timeout), todo, ask-user, `present`, skills, compaction. No
`agent-instructions` row.

---

## Tool surface at a glance

Legend: ✓ mounted; — not mounted; config notes in parentheses.

| Row | orchestrator | architect | writer | reviewer | researcher |
|---|---|---|---|---|---|
| `persona` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `agent-instructions` (workspace instructions) | ✓ | ✓ | — | ✓ | — |
| `time-context` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tool-fs` (read/write/edit) | ✓ (`applyPatch:false`) | ✓ (`applyPatch:false`) | ✓ (`applyPatch:false`) | ✓ (`read`,`readImage`,`write`,`edit`, no patch) | ✓ (`applyPatch:false`) |
| `tool-fs-search` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tool-bash` | ✓ | ✓ | — | ✓ | ✓ |
| `tool-web` | ✓ (fetch) | ✓ (fetch) | ✓ (fetch, 60 s search) | ✓ (fetch) | ✓ (fetch, 60 s search) |
| `tool-todo` | ✓ (parallel) | ✓ | ✓ | ✓ | ✓ (parallel) |
| `tool-ask-user` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `present` | — | ✓ | ✓ | — | ✓ |
| `skill-filesystem` + `tool-skill` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tool-subagent-control` | ✓ | — | — | — | — |
| `tool-subagent` (spawn) | ✓ | — | — | — | — |
| `tool-subagent` (fork) | ✓ | — | — | — | — |
| `workflow` engine + tool | ✓ | — | — | — | — |
| compaction group (basic + `/compact`) | ✓ | ✓ | ✓ | ✓ | ✓ |

Shared by every persona: the preset's own `persona` row (tool guidance and
runtime context are kept because all rows use `complete: false`), `time-context`,
and an isolated compaction group so long sessions stay usable.

---

## How presets compose

- **One preset per session.** The preset is selected when the session is
  created and composes that session's whole capability set. Presets are not
  additive: selecting `reviewer` does not also give you the orchestrator's
  delegation rows.
- **A preset owns its rows.** Preset plugins live on the session's agent plane;
  the harness's host-plane rows (for example the `systemone_*`/`swarm_*` tools
  and team tools) remain visible without being re-declared inside a preset.
  This is why the bundles are independent: personas shape *capabilities*,
  systemone adds *host tools and decisions*.
- **Subagents inherit.** A child spawned with `subagent` or `subagent_fork`
  inherits the parent's preset unless the `tool-subagent` row configures
  `agentPreset` (and `allowedAgentPresets` to constrain the choice). The shipped
  personas bundle leaves that unset. Swarm mode works around this by passing the
  assigned persona's operating instructions inside the subagent brief; it does
  not switch the child's preset.
- **Per-preset decision configuration.** The systemone bundle keys its mandatory
  overrides by **preset id** (`presets.orchestrator`, `presets.reviewer`, …) and
  resolves the id through the preset registry. Renaming a preset id therefore
  changes which policy applies; changing only the display name does not.
- **Bundle order.** In the profile's `dsh.profile.bundles`, keep
  `@local/dsh-personas` before `@local/systemone`. The systemone profile row
  override and the persona preset rows are independent, but personas-first is
  the documented order and the one the example patch uses.

---

## How the picker and the Settings roster show them

Each preset row declares:

```yaml
- id: preset-architect
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: architect                 # stable id: picker, per-preset overrides, logs
    name: Architect               # display name
    description: Designs systems from the actual repository and writes
      decision-complete design documents.
    order: 11                     # position after the shipped presets
    plugins: [ ... ]              # the capability set
```

- The **New-session preset picker** lists the preset by `name` and `description`,
  ordered by `order`.
- **Settings → Agent presets** shows the same roster; removing the bundle removes
  all five entries again. Sessions that already selected one keep their
  composition until they end.
- Tooling that resolves presets (`ctx.get('agentPresets').presetForSession`)
  returns the stable `id`, which is what the decision layer records as `preset`
  in its recent decisions and what `swarm.presets` matches.

---

## Customizing

### Change a persona prompt or its tools

Edit
[`packages/dsh-personas/cordis.patch.yml`](../packages/dsh-personas/cordis.patch.yml),
then reinstall the bundle (remove and re-add it through the Plugins page, or
reinstall the directory). Keep the row id stable (`preset-<id>`); DSH resolves
presets by their row ids and config `id`.

Rules of thumb:

- Keep `persona.config.prefix` focused on *how to behave*; keep capability
  decisions in the `plugins` list.
- Every preset needs `persona`, `time-context`, and a compaction group to stay
  usable in long sessions.
- A preset that should see workspace instruction files needs an
  `agent-instructions` row.
- A read-only persona should omit `bash` if it must not execute anything; if it
  must run checks (a reviewer), it needs `bash` and the enforcement belongs in
  the systemone persona policy.

Existing sessions keep the composition they started with; start a new session
to see the change.

### Add a sixth preset

Append one `insert` row to the bundle's patch list. This is the minimum shape
(choose real rows from the table above):

```yaml
- insert:
    - id: preset-operator
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: operator
        name: Operator
        description: Runs a documented procedure step by step and records the evidence.
        order: 15
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
                You run a documented procedure. Follow the runbook in order,
                stop at the first unexpected result, and record the evidence.
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              applyPatch: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
```

Then:

1. Add `operator` to the systemone `swarm.presets` list if it should participate
   in swarm mode.
2. Add `presets.operator` to the systemone row if it needs a mode, taxonomy,
   thresholds, deterministic policy, or model judge.
3. Reinstall the personas bundle and start a new session.

### Remove a preset

Delete its `preset-<id>` entry and reinstall. The bundle uninstall path also
removes all five; sessions already using one keep their composition until they
end. If you remove a preset that the systemone row references, remove that
`presets.<id>` override and the id from `swarm.presets` too, or leave them
inert (they are only consulted for sessions whose preset resolves to that id).

### Use personas without the custom bundle

The shipped presets remain available. The custom presets are a convenience
layer: every one of them composes stock DSH rows, so an equivalent session can
be built by hand with an `@deepseek-ai/dsh-agent-preset` declaration. The
bundle exists so you do not have to repeat that composition in every profile.
