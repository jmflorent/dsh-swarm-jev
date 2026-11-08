# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the repository
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file tracks the repository (the bundles and their documentation), not the
DeepSeek Harness release it runs on. See
[Compatibility](README.md#compatibility) for the supported DSH version.

## [0.3.0] — 2026-11-08

The checker evolves so delivery meets executed expectations, following the
verification lessons of the external Ringer runner. Comparison and trust model:
[`docs/checker.md`](docs/checker.md).

### Added

- `packages/objective-engine` 0.3.0 — the engine executes `command` and
  `artifact` criteria itself (`lib/checker.js`) before starting a verifier:
  exit code/signal/timeout, cwd, duration, bounded output excerpts, artifact
  stat/sha256/minBytes. A failing executed check returns
  `mechanical-check-failed` with the evidence, leaves the objective active, and
  consumes no verifier run.
- `objective_lint` tool — lint vacuous/silent/duplicate checks, evidence-only
  criteria, and a missing scope; `execute:true` runs the mechanical baseline
  without creating a verification. `objective_create` also returns the lint
  warnings.
- Artifact criteria accept `minBytes` (default 1) in addition to `sha256`.
- Verifier briefs carry the engine-executed results; worker briefs carry the
  concrete checks the engine will execute during verification.
- Checker config: `checkerExecute`, `checkerTimeoutMs`, `checkerMaxTimeoutMs`,
  `checkerMaxOutputBytes`; `objective_status` exposes the checker block and
  executed checks.

### Changed

- `objective_verify` now pins the commit, executes the checks, and only starts
  the verifier when they pass; the verifier still cannot override a failed
  executed check, and the engine cannot override a verifier reject.
- The verifier preset prompt now treats the engine results as execution truth
  while requiring independent commit/workspace inspection and semantic review;
  an executed check catches laziness, not subtle wrongness.
- The package suite is now twenty-one sections (deterministic checker pass/fail,
  artifact stat/hash, lint/baseline, plus the dispatch-depth and human-actor
  regressions).

## [0.2.0] — 2026-11-07

The objective/progress orchestrator reaches Phase 1 of the design: the engine
is a full control plane, the two session types ship as presets, and a
nine-condition test suite pins the completion gate.

### Added

- `packages/objective-engine` — `@local/objective-engine` 0.2.0, rebuilt in
  the design's module layout (`store`, `fold`, `transition`, `admission`,
  `pump`, `dispatch`, `verify`, `classify`, `prompts`, `status`, `authority`,
  `tools`):
  - a hash-chained `opm/v1` command journal validated from genesis on every
    load, with a periodic snapshot, a single-writer `LOCK`, a `PAUSED`
    sentinel, torn-tail repair, and a degraded (read-only) mode on gaps or
    write failures; classifier proposals live in a separate advisory log that
    the fold never reads;
  - complete objective records: typed criteria (`command`, `artifact`,
    `human-ack`, `evidence`) with `requiresHumanAck`, `criteriaVersion`,
    priority, `scope.paths`, six budget counters, `armed`, and the closed state
    machine (`proposed`, `queued`, `active`, `paused`, `verifying`,
    `awaiting-human`, `blocked`, `completed`, `cancelled`);
  - work items with acceptance, criterion links, dispatch provenance,
    evidence, heartbeats, stall detection, and terminal failures; verification
    records with commit pinning (`git rev-parse HEAD` / `git status` through
    `ctx.subprocess`), per-criterion evidence coverage, advisory subsets, and
    `superseded` on criteria edits or send-back;
  - execution-time authority: creation, approval, control, ack, and resume
    require a direct human message in the open turn of a top-level session;
    plans, dispatches, and verification requests require the owner; item
    reports require the assigned child; verdicts require the engine-started
    verifier (or, without a subagent service, a non-producer session with a
    different preset);
  - admission and measured load: per-owner caps, duplicate statements, scope
    conflicts, in-flight items, dispatch rate, verifier backlog and per-day
    runs, backpressure, an `engine/overloaded` signal, fairness with aging;
  - the serialized pump with a priority order (ack, verdict, failure, work,
    blocked, plan), one outstanding wakeup per session, versioned prompt
    templates, and an `agent/pre-step` fence that admits (consuming a round),
    supersedes (human message wins), or rejects (stale) engine prompts;
  - engine-started workers (`ctx.subagents.startActivation` with the persona's
    preset, an absolute child-depth cap of the owner's depth + 1, the owner's
    working directory) and verifier
    (`verifierPresets`, never the producer's preset), settlement from
    `subagent/end`, the manager-driven fallback (`external: true`,
    `objective_report childSessionId`);
  - the kill switch (`objective_system pause`, `PAUSED`, the `objectives`
    service's `pauseAll`): cancels children with the `hook` cause, expires
    wakeups, cancels dispatched items, survives restart; restart reconciliation
    fails dispatched items, marks requested verifications inconclusive, pauses
    and disarms active objectives, and never wakes anything at boot;
  - the advisory classifier with the design's three questions, the
    deterministic decision rule and thresholds, two-call hysteresis, an hourly
    rate cap, a circuit breaker, model id and latency in every proposal, and
    auto-tagging of incoming human messages;
  - eleven tools: `objective_create`, `objective_status`, `objective_plan`,
    `objective_dispatch`, `objective_report`, `objective_verify`,
    `objective_verdict`, `objective_ack`, `objective_control`,
    `objective_system`, `objective_classify`, whose parameter schemas follow the
    enforced registry JSON-Schema subset;
  - `test/`: a fake Cordis context and a sixteen-section suite covering the
    nine conditions, restart and replay determinism, the fence, coalescing,
    the kill switch, the classifier outage policy, the replay paradox, the
    fallback paths, and the dispatch-depth and human-actor regressions;
- `packages/dsh-personas` — 1.1.0: the `objective-manager` (order 15, no
  subagent tools; dispatches through the engine) and `verifier` (order 16,
  read-only on source) presets; the orchestrator's spawn tool gains
  `allowedAgentPresets` (no default, so inheritance is unchanged).
- `packages/dsh-systemone` — 0.2.4: `objective-manager` and `verifier` in the
  default `swarm.personas` catalog; the eleven `objective_*` tools and the team
  tools in the default `swarm.orchestratorTools`; the sidebar Objectives block
  shows verifying/awaiting counts, blocked reasons, and the engine mode.
- `examples/profile-patch.example.yml` — the full objective-engine row, the
  seven-persona catalog, the extended allow-list, and a `presets.verifier`
  policy and judge.
- Documentation: `docs/objective-engine.md` rewritten as the reference; the
  package README is the operator runbook; orchestrator, configuration,
  personas, install, troubleshooting, and decision-system pages updated.

### Changed

- The objective engine's `objective_complete` and `objective_cancel` tools are
  gone: completion is engine-only (verifier approval, then a human ack for
  judgment criteria) and cancellation is `objective_control { action: "cancel" }`.
  `objective_verify` now *requests* verification; the verifier answers with
  `objective_verdict`. Status reports a `mode` (`paused` / `running` /
  `degraded`) instead of a boolean.
- The example patch no longer sets the retired `swarm.presets` field.

### Verified

- Phase-1 in-harness acceptance passed end to end on 2026-11-08 (headless
  top-level session, real worker and verifier children, commit-pinned clean
  tree, mechanical criterion completed). The drill found and the same release
  fixed the absolute `maxDepth` dispatch bug and the human-actor
  `item/dispatched`/`verification/*` fold bug. Evidence:
  [`docs/acceptance/phase-1.md`](docs/acceptance/phase-1.md).

### Fixed

- `packages/objective-engine` — a dispatch issued by a **human owner** was
  journaled but rejected by the fold: `item/dispatched` (and the `verification/`
  family) did not allow the `human` actor kind, so the journal and the in-memory
  state diverged (`fold rejected a freshly written event: item/dispatched`) even
  though the child had started. Both now allow human owners; a regression pins
  the human-owner dispatch case that the agent-actor-only tests missed.

- `packages/objective-engine` — engine-started workers could never start when
  the subagent service was present: the dispatcher passed `maxDepth: 0`, which
  the subagent service treats as an **absolute** child-depth cap, so every
  depth-1 worker (and the verifier) failed with `subagent depth 1 exceeds
  maxDepth 0`. The dispatcher now caps at the owner's delegation depth + 1
  (`workerMaxDepth` default 1), which allows a root or nested owner to start its
  worker while still forbidding grandchildren; a regression section pins the
  root (cap 1) and nested (cap 2) cases.

- `packages/dsh-systemone` 0.2.4 — the package is now **self-contained** so a
  linked/offline install works with no registry resolution:
  - vendored the MIT `schemastery` 3.18.5 and `cosmokit` 1.8.6 sources under
    `packages/dsh-systemone/vendor/` (one relative-import rewrite; license texts
    included), and imported the schema library from there;
  - replaced the `@deepseek-ai/dsh-tools` `defineTool` import with
    `lib/define-tool.js`, which produces the same registry-ready definition
    shape (JSON-Schema parameters, required/scalar validation, JSON output) and
    drops that package's large dependency closure;
  - removed both runtime dependencies from `package.json` and updated the
    install guide, compatibility table, tests guide, and vendor provenance.

### Removed

- `packages/objective-engine/lib/journal.js` (replaced by `lib/store.js`).

## [0.1.0] — 2026-11-07

### Added

- `packages/dsh-personas` — `@local/dsh-personas` 1.0.0: five role presets
  (`orchestrator`, `architect`, `writer`, `reviewer`, `researcher`) layered
  over the shipped DSH presets.
- `packages/dsh-systemone` — `@local/systemone` 0.2.0: the
  `systemone_ask` / `systemone_status` tools, the `off` / `shadow` / `enforce` /
  `swarm` decision layer (tool selection, call assessment, deterministic persona
  policy, model-judged persona rules, loop guard, optional skill hints and model
  routing), swarm mode (`swarm_enter`, `swarm_assign`, `swarm_exit`), and the
  browser-side **Settings → Decision model** page (`lib/client.js`, declared by
  `dsh.client`, `platform: web`, English and Chinese), which edits endpoint,
  model, timeout, mode, and the API key live.
- `packages/dsh-systemone/test/` — the package selftest suite and an in-process
  mock System One endpoint; `pnpm test` runs it. Adapted from the author's
  workspace harness with imports rewritten for the packaged layout.
- `docs/design/objective-progress-swarm-design.md` — sanitized, 970-line
  decision-complete design for the objective/progress agent type and the
  `@local/objective-engine` control plane. **Design only; not implemented.**
- Documentation: README, persona reference, decision-system reference,
  orchestrator design summary, installation guide, configuration reference,
  and troubleshooting guide.
- `examples/profile-patch.example.yml` — a generic, credential-free profile
  patch showing both bundles with placeholder endpoints.

### Changed

- Bundle defaults and UI hints were sanitized for publication: the endpoint
  default is `http://127.0.0.1:8008/v1/systemone`, the model default is the
  `decision-model` placeholder, and the deployment-specific model aliases and
  server names were removed from the bundle README, locale metadata, and the
  Settings page hints. Set the real endpoint and model in the profile patch or
  the Settings page.
- The host and browser halves ship as one package; the Settings page appears
  only in a Web-client composition.

### Security

- Sanitized all internal hostnames, absolute paths, deployment-specific model
  ids, and credential references from the published material. No API keys,
  tokens, session ids, or internal URLs are included.
