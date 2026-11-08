# dsh-personas — role presets for this DeepSeek Harness profile

Seven Agent presets layered on top of the shipped `standard`, `ptc`, `minimal`, and
`cordis` presets: five role presets and the two session types the objective engine
dispatches to. They appear in **New session → preset picker** and in
**Settings → Agent presets**, after the built-ins (orders 10–16).

| Preset id | Name | Tools | Intended use |
|---|---|---|---|
| `orchestrator` | Orchestrator | fs, search, bash, web, todo, ask-user, skills, subagent + fork, workflow | Decompose a goal, fan work out to subagents, integrate results |
| `architect` | Architect | fs, search, bash, web, todo, ask-user, skills, present | Design systems grounded in the repo; write design docs |
| `writer` | Writer | fs, search, web, todo, ask-user, skills, present | Prose and documents matched to audience and house style |
| `reviewer` | Reviewer | read-only fs (read + readImage), search, bash, web, todo, ask-user, skills | Independent validation, evidence-cited findings, verdict |
| `researcher` | Researcher | fs, search, bash, web, todo, ask-user, skills, present | Primary-source research with citations, fact vs. inference |
| `objective-manager` | Objective manager | fs, search, bash, web, todo, ask-user, skills, present — no subagent/workflow tools | Owns an objective's plan: plans and dispatches work orders through `objective_dispatch`, accepts reports, requests verification; never completes |
| `verifier` | Verifier | read + readImage + write (evidence/fixtures only by policy), `edit: false`, search, bash, web, todo, ask-user, skills | Engine-started verification of a pinned commit; one `objective_verdict` with per-criterion evidence |

Every preset mounts its own `@deepseek-ai/dsh-persona` row (keeping tool guidance and
runtime context), plus `time-context`, and an isolated compaction group.

## Notes

- A preset is chosen **per session**. A subagent started with `subagent`/`subagent_fork`
  inherits the parent's preset unless the parent's `tool-subagent` row configures
  `agentPreset` (and `allowedAgentPresets` to restrict the choice) — both supported in
  DSH 0.2.2-rc.1. The orchestrator's spawn row sets `allowedAgentPresets` to the six
  other presets with no default, so the model may name one through `agent_preset`.
  The objective engine's `objective_dispatch` always starts children under the
  assigned persona's preset.
- `reviewer` is read-only by design: `write: false`, `edit: false`, `applyPatch: false`.
- Removing the bundle on the sidebar **Plugins** page removes all seven presets again
  (sessions already using one keep their composition). The objective engine falls
  back from `verifier` to `reviewer` when the former is missing (`verifierPresets`).
- Rows mounted by a preset must satisfy their plugin's **required** config: one
  rejected row fails the whole preset ("failed to load" in Settings). Required in
  DSH 0.2.2-rc.1 are `tool-fs-search.sampleOverCapGlobResults` and
  `tool-todo.allowParallelInProgress`; both are set here. Re-check these rows
  when upgrading DSH, against the shipped presets' configs.

## Edit

Change `cordis.patch.yml`, then reinstall the bundle (plugin_manager
`install_bundle` on this directory). The declaration row ids are `preset-<id>`.
