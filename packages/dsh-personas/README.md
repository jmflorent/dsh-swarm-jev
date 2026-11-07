# dsh-personas — role presets for this DeepSeek Harness profile

Five Agent presets layered on top of the shipped `standard`, `ptc`, `minimal`, and
`cordis` presets. They appear in **New session → preset picker** and in
**Settings → Agent presets**, after the built-ins (orders 10–14).

| Preset id | Name | Tools | Intended use |
|---|---|---|---|
| `orchestrator` | Orchestrator | fs, search, bash, web, todo, ask-user, skills, subagent + fork, workflow | Decompose a goal, fan work out to subagents, integrate results |
| `architect` | Architect | fs, search, bash, web, todo, ask-user, skills, present | Design systems grounded in the repo; write design docs |
| `writer` | Writer | fs, search, web, todo, ask-user, skills, present | Prose and documents matched to audience and house style |
| `reviewer` | Reviewer | read-only fs (read + readImage), search, bash, web, todo, ask-user, skills | Independent validation, evidence-cited findings, verdict |
| `researcher` | Researcher | fs, search, bash, web, todo, ask-user, skills, present | Primary-source research with citations, fact vs. inference |

Every preset mounts its own `@deepseek-ai/dsh-persona` row (keeping tool guidance and
runtime context), plus `time-context`, and an isolated compaction group.

## Notes

- A preset is chosen **per session**. A subagent started with `subagent`/`subagent_fork`
  inherits the parent's preset unless the parent's `tool-subagent` row configures
  `agentPreset` (and `allowedAgentPresets` to restrict the choice) — both supported in
  DSH 0.2.2-rc.1. To get a mixed-role team in one conversation, run roles in separate
  sessions, configure those two fields, or install the official
  `@deepseek-ai/dsh-experimental-agent-team-profile` bundle.
- `reviewer` is read-only by design: `write: false`, `edit: false`, `applyPatch: false`.
- Removing the bundle on the sidebar **Plugins** page removes all five presets again
  (sessions already using one keep their composition).

## Edit

Change `cordis.patch.yml`, then reinstall the bundle (plugin_manager
`install_bundle` on this directory). The declaration row ids are `preset-<id>`.
