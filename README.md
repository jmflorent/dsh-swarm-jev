# dsh-swarm-jev

**A swarm setup for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): role personas, a self-hosted System One decision layer, and a design for an objective/progress orchestrator.**

This repository packages the pieces of a working DSH swarm configuration in
installable form. It is meant to be forked, read, installed on another DSH
installation, and extended. Everything here is ordinary DSH plugin material:
bundles with a `cordis.patch.yml`, plain ES modules, and Markdown.

| Part | Package / location | What it gives you | Status |
|---|---|---|---|
| **Role personas** | [`packages/dsh-personas`](packages/dsh-personas) (`@local/dsh-personas` 1.0.0) | Five agent presets — orchestrator, architect, writer, reviewer, researcher — layered over the shipped DSH presets | Stable |
| **System One decision layer** | [`packages/dsh-systemone`](packages/dsh-systemone) (`@local/systemone` 0.2.0) | `systemone_ask` / `systemone_status` tools, a self-hosted decision model integration, `off`/`shadow`/`enforce`/`swarm` decision layer, persona routing, per-preset tool policy and model judging, and the **Settings → Decision model** page | Stable |
| **Objective/progress orchestrator** | [`docs/orchestrator.md`](docs/orchestrator.md) + [`docs/design/`](docs/design/objective-progress-swarm-design.md) | A decision-complete design for a managed objective registry, event-driven wakeups, budgets, a verifier-gated completion gate, and a kill switch | **Design only — not implemented** |

> The objective engine is a design document, not a shipped feature. No
> `objective_*` tools, `@local/objective-engine` bundle, or durable journal
> exist yet. The design is included because it is the third part of the setup
> and it explains where swarm mode is going.

---

## Why this exists

Out of the box, DSH gives you sessions, agent presets, subagents, compaction,
and the extension points a harness needs. It deliberately does not tell you
*who* should do *what*, and it has no opinion about decisions a language model
is bad at making confidently.

This kit adds three things on top of that:

1. **Roles.** Five presets that compose a session's whole capability set —
   including a delegating orchestrator and a read-only-independent reviewer —
   so the same harness can behave like a small team instead of one generalist.
2. **A decision plane you host yourself.** A small HTTP endpoint that answers
   typed questions (`noul`, `choice`, `score`, `box`) with calibrated numbers.
   DSH consults it for tool selection, per-call assessment, loop detection,
   persona policy, and — in swarm mode — stage assignment. The model never
   writes prose for the agent and never touches harness state.
3. **Swarm mode.** A session-scoped mode in which the primary agent becomes an
   orchestrator: its tool surface is narrowed to coordination, it keeps an
   explicit workplan, and `swarm_assign` asks the decision model which persona
   executes each stage. Every other session stays inert, so a lead session
   cannot block itself.

The design in `docs/design/` extends that last piece into an objective/progress
agent type: a control-plane plugin that tracks objectives, work items, budgets,
verification, wakeups, and a human acknowledgment gate.

---

## Architecture

```text
                      +------------------------------------------------------+
                      |             DeepSeek Harness profile                 |
                      |                                                      |
                      |  packages/dsh-personas     packages/dsh-systemone    |
                      |  +-------------------+     +----------------------+  |
                      |  | 5 agent presets   |     | tools: systemone_ask |  |
                      |  |  orchestrator     |     |        systemone_    |  |
                      |  |  architect        |     |        status        |  |
                      |  |  writer           |     | swarm: enter/assign/ |  |
                      |  |  reviewer         |     |        exit          |  |
                      |  |  researcher       |     | decision layer       |  |
                      |  +---------+---------+     | (selection, assess,  |  |
                      |            |               |  policy, judge, ...) |  |
                      |            | preset rows   | Settings screen      |  |
                      |  +---------v---------------v----------------------+  |
                      |  | sessions - subagents - swarm mode - tool policy  |  |
                      |  +---------------------------+----------------------+  |
                      +------------------------------|-----------------------+
                                                     |
                                    POST { state, questions, model }
                                    Authorization: Bearer <optional>
                                                     |
                                       +-------------v-------------+
                                       | System One decision model |
                                       | self-hosted, e.g. Jev     |
                                       +---------------------------+

  Objective/progress orchestrator (design only, see docs/orchestrator.md)
  +-----------------------------------------------------------------------+
  | @local/objective-engine control plane                                 |
  | objective registry - journal - admission - budgets - wakeup pump -    |
  | verification gate - human ack - kill switch                           |
  +-----------------------------------------------------------------------+
```

The two shipped bundles are independent: personas work without System One, and
System One works without the role presets. Installing both gives the per-preset
behavior (`swarm.presets`, `presets.<id>.policy`, `presets.<id>.judge`) that the
rest of the documentation assumes.

---

## Quick start

Prerequisite: **DSH 0.2.2-rc.1** (the release this kit was built and tested
against). See [Compatibility](#compatibility).

```text
1. Install the personas bundle
   DSH Web -> Plugins (sidebar) -> Add plugin -> local directory
   choose:  <repo>/packages/dsh-personas

2. Install the System One bundle
   same screen, choose:  <repo>/packages/dsh-systemone

3. Point System One at your decision endpoint
   Settings -> Decision model
     endpoint:  http://127.0.0.1:8008/v1/systemone
     model:     <the model id your endpoint serves>
     timeoutMs: 20000
     mode:      shadow          (observe first; enforce later)
     API key:   stored by DSH's credential service under SYSTEMONE_API_KEY

4. Use it
   New session -> preset "Orchestrator" -> ask it to enter swarm mode
   (it calls swarm_enter), then let swarm_assign route stages to personas
```

On a fresh install nothing is enforced: `mode: shadow` computes decisions and
records them under `systemone_status` without changing behavior. Switch to
`enforce` only after reading `docs/decision-system.md`, and keep approval
prompts enabled.

Full instructions, including CLI and manual profile wiring:
[`docs/install.md`](docs/install.md).

---

## Installation summary

| Bundle | Install path | Requires | Enables |
|---|---|---|---|
| `@local/dsh-personas` | `packages/dsh-personas` | DSH 0.2.2-rc.1 | Five presets in the New-session picker and Settings → Agent presets |
| `@local/systemone` | `packages/dsh-systemone` | DSH 0.2.2-rc.1, a reachable System One endpoint; pnpm/registry access for its two dependencies; the Web client for the Settings page | `systemone_*` and `swarm_*` tools, the decision layer, per-preset policy/judge, Settings → Decision model |

Both bundles are added through the DSH Web Plugins page (or the equivalent
profile wiring). Keep `@local/dsh-personas` before `@local/systemone` in the
profile's bundle list, as the documented order; the shipped
[`examples/profile-patch.example.yml`](examples/profile-patch.example.yml) shows
a complete, credential-free profile patch.

---

## Compatibility

| Component | Version |
|---|---|
| DeepSeek Harness | **0.2.2-rc.1** (tested) |
| DSH profile team packages | 0.2.2-rc.1 |
| Bundled Node / pnpm shipped with DSH | Node 24.21.0 / pnpm 11.28.5 |
| `@local/dsh-personas` | 1.0.0 — no runtime dependencies |
| `@local/systemone` | 0.2.0 — `engines.dsh: >=0.2.2-rc.1 <0.3.0`, `engines.node: >=24`; declares `@deepseek-ai/dsh-tools` 0.2.1-rc.3, `@deepseek-ai/schemastery` ~3.18.5; browser half at `lib/client.js` (`platform: web`) |

DSH's plugin API is young. Treat the versions above as the tested set: if you
run a different DSH release, install in `shadow` mode first and check
`systemone_status`. There is no compatibility shim and no claim of forward
compatibility.

---

## Security and egress

Read this before pointing the bundle at anything.

- **What leaves the machine.** Every `systemone_ask` call and every decision the
  layer makes sends the `state` and `questions` payload to the configured
  endpoint. That is the only network egress the plugin performs (image paths
  are read locally and sent to that same endpoint when the endpoint supports
  multipart assets). Use an endpoint you control or trust; the bundle has no
  analytics, telemetry, or callback.
- **Credentials.** The API key is resolved at call time from the DSH credential
  service under the reference `SYSTEMONE_API_KEY`, falling back to the process
  environment variable of that name. It is sent as a `Bearer` header. It is
  never returned by a tool, never logged, and never written into configuration
  by the plugin. The Settings screen writes it to the credential service, not
  to the profile patch.
- **Decision output is probabilistic.** A `noul` answer is a probability, not a
  fact; `enforce` mode can deny or hold tool calls based on it. Keep DSH
  approval prompts enabled while you learn the endpoint's calibration. With
  approvals disabled, an `ask` decision becomes a denial.
- **Nothing in this repository is secret.** It contains no API keys, tokens,
  session ids, internal hostnames, or absolute user paths. The design document
  was sanitized; endpoint examples use `127.0.0.1`.
- **The reviewer is not a sandbox.** The reviewer preset plus the
  systemone persona policy is a cooperative guarantee for a well-behaved model,
  not an operating-system sandbox. Run DSH with the file and command
  permissions you are willing to grant.

See [`docs/decision-system.md`](docs/decision-system.md) and
[`docs/configuration.md`](docs/configuration.md) for the full picture.

---

## Repository layout

```text
dsh-swarm-jev/
├── README.md
├── LICENSE                  MIT (changeable by the maintainer)
├── CHANGELOG.md
├── VERSION
├── .gitignore
├── packages/
│   ├── dsh-personas/         @local/dsh-personas bundle
│   └── dsh-systemone/        @local/systemone bundle (tools + layer + Settings UI)
│       └── test/             mock decision endpoint + selftest suite
├── docs/
│   ├── personas.md           the five presets and how to customize them
│   ├── decision-system.md    tools, decisions, modes, swarm mode, Settings
│   ├── orchestrator.md       swarm orchestrator + objective/progress design summary
│   ├── install.md            installing on another DSH installation
│   ├── configuration.md      every configuration field, defaults, precedence
│   ├── troubleshooting.md    failure modes and diagnostics
│   └── design/
│       └── objective-progress-swarm-design.md   sanitized full design (design only)
└── examples/
    └── profile-patch.example.yml   generic two-bundle profile patch
```

## Documentation

| Read this | If you want to |
|---|---|
| [`docs/personas.md`](docs/personas.md) | Understand, choose, compose, or customize the five role presets |
| [`docs/decision-system.md`](docs/decision-system.md) | Understand the System One tools, every decision, the modes, swarm mode, and the Settings screen |
| [`docs/orchestrator.md`](docs/orchestrator.md) | Understand the swarm orchestrator today and the objective/progress design |
| [`docs/install.md`](docs/install.md) | Install, enable, reload, verify, uninstall, and roll back on another machine |
| [`docs/configuration.md`](docs/configuration.md) | Change a config field without breaking the layer; understand precedence and credentials |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Fix an endpoint, auth, answer, mode, Settings-page, or version problem |
| [`docs/design/objective-progress-swarm-design.md`](docs/design/objective-progress-swarm-design.md) | Read the complete objective-engine design (protocol, state machines, phasing, tests) |

---

## What is not in this repository

- **The objective engine.** No code exists; `docs/orchestrator.md` explains the
  design status and the Phase 0 prototype you can run with today's primitives.
- **A decision-model server.** The bundle ships the client, not the model. The
  endpoint is yours to run; any service that implements the System One contract
  described in `docs/decision-system.md` works, and Jev-style deployments are
  what this kit was built against.
- **The author's profile.** No profile patch, credential, or session data is
  included; start from the example.

What *is* included beyond the bundles: the package test harness for
`dsh-systemone` (`packages/dsh-systemone/test`, an in-process mock System One
endpoint plus the selftest suite) and the sanitized objective-engine design.

---

## Testing

The systemone package ships its selftest suite, including an in-process mock of
the decision endpoint:

```bash
cd packages/dsh-systemone
pnpm install
pnpm test        # node test/run.mjs
```

The suite exercises the tools, decision layer, deterministic policy, vision
transport, and swarm behavior against the real package modules. It needs no DSH
process, but it does need the package's two `@deepseek-ai/*` dependencies
resolved (that is what `pnpm install` does). The personas bundle is
configuration-only and has no test suite.

---

## License

MIT — see [`LICENSE`](LICENSE). The license is the maintainer's choice and can
be changed in a fork; if you publish a derivative, keep the copyright notice.

DeepSeek Harness and its `@deepseek-ai/*` packages are separate works under
their own licenses; this repository only depends on them and does not
redistribute them.
