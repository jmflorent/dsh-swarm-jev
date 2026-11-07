# @local/systemone — tools + decision layer

Three surfaces over one self-hosted System One endpoint (`/v1/systemone`):

1. **Tools** — `systemone_ask`, `systemone_status` (model-invoked).
2. **Decision layer** — four harness adapters that consult System One on their
   own, in `off` / `shadow` / `enforce` / `swarm` mode.
3. **Settings page** — a browser-side **Decision model** section in Settings
   that edits the endpoint, model, timeout, mode, and the endpoint API key.

The endpoint is configurable and defaults to
`http://127.0.0.1:8008/v1/systemone`. Any Jev-compatible decision service can
serve it; `/health` may report the served model id and its aliases, and the id
sent on every request is the `model` field.

## Decision layer

| Extension point | Decision | Effect in `enforce` |
|---|---|---|
| `agent/pre-step` | which declared tool categories the step needs | `agent.ctx.tools.restrict({ allow })`, recomputed every step |
| `tools/pre-execute` | per-call assessment: restriction conflict, missing information, task match | `ask` (or `cancel` for `onFailure: hold`); off-task alone never gates |
| `tools/result` + `tools.guard` | deterministic identical-call detection | denies a repeat after `maxRepeats` |
| `agent/pre-step` | optional skill hint and model route | one skill notice; `agent.model.select()` for the **next** step |

Per-preset overrides (`presets.<id>`) select the taxonomy, mode, and thresholds
for a session's composing preset (resolved through `ctx.get('agentPresets')`).
This profile ships overrides for `orchestrator`, `architect`, `writer`,
`reviewer`, and `researcher`; `layer.presetOverrides` lists them and every
selection decision records the detected `preset`.

Modes:

- `off` — no work.
- `shadow` — decisions are computed, logged, and kept in `systemone_status` under
  `layer.recent`; behavior is untouched.
- `enforce` — decisions narrow behavior for every session. Never widens: a
  downstream `deny` / `cancel` survives, a restriction only intersects, and a
  stale decision (snapshot changed mid-flight) is discarded.
- `swarm` — a **session mode**, not a preset (like plan mode). No session is
  affected until it enters with `swarm_enter` (or says "enter swarm mode");
  every other session stays inert — no selection, no assessment, no policy, no
  model calls — so a lead session never blocks itself. While a session is in
  swarm mode:
  - the primary agent becomes the **orchestrator**: a `swarm:policy` prompt
    section tells it to keep an explicit workplan and assign every stage;
  - `swarm_assign(stage, needs?, context?)` asks the decision model which
    persona executes the stage (orchestrator / architect / writer / reviewer /
    researcher, configurable via `swarm.personas`) and returns that persona's
    description and operating instructions. The orchestrator then invokes that
    agent — spawn a subagent with those instructions, or execute the stage when
    it is the chosen persona. The model's answer is the assignment; the
    orchestrator does not pick the persona itself;
  - every tool call is judged by the decision model (generic assessment plus a
    per-preset `judge` where configured). Note that per-session personas are
    not selectable through the subagent tool in this harness, so the persona
    travels as the brief's operating instructions, not as a preset switch.
  `swarm_exit` leaves the mode and restores an inert session.

Safety defaults: fail to `ask` rather than allow on provider failure; skip a
restriction that would leave <15% of tools; always keep `systemone_ask` /
`systemone_status` and any tool with no declared category; bound state
(`maxStateChars`), arguments (`maxArgumentChars`), and request size.

Selection only asks about declared categories (`selection.categories`). Tools
without a `toolCategories` entry are never narrowed. Scoped tools mounted by an
agent preset are out of scope for restrictions by design, so selection mostly
affects host-level tools.

### Configuration

Behavior config lives in the profile patch override
(`~/.dsh/profiles/<name>/cordis.patch.yml`, row id `systemone`), which replaces
this bundle's `config` wholesale. Feature blocks: `selection`, `assessment`,
`loopDetection`, `skills`, `modelRouting`; plus `thresholds`, `mode`, `swarm`,
`policy` (per preset, deterministic), `judge` (per preset, model-judged),
`timeoutMs`, `maxStateChars`, `maxArgumentChars`, `maxCategories`,
`maxSelectedTools`, `redactKeys`.

The Settings page writes the volatile fields above into that same profile patch,
so a value set in the UI becomes an ordinary profile override. Editing the patch
directly still takes precedence and remains the way to set the non-volatile
limits (`maxQuestions`, `maxRequestChars`, and so on).

`skills` and `modelRouting` ship disabled:

- skill hints depend on `agent.inject()` accepting a plugin-sourced message;
  unverified in 0.2.2, so it is opt-in and failure-tolerant.
- model routing uses `agent.model.select()` and therefore applies to the next
  step, not the one being decided.

## Settings

Open **Settings → Decision model** in the Web UI. The page edits the same live
fields the decision layer reads:

| Field | Effect |
|---|---|
| Endpoint URL | Where decision POST requests are sent. |
| Model id | The `model` value sent with every request. |
| Timeout (ms) | Per-call deadline for one decision request. |
| Mode | `off`, `shadow`, `enforce`, or `swarm`. |
| API key | Written to the DSH credential service under `apiKeyRef` (default `SYSTEMONE_API_KEY`), never to the settings file. Blank keeps the current key; **Clear key** removes it. |

The page is the browser half of this same package (`lib/client.js`, declared by
`dsh.client` in `package.json`). It writes through `ctx.configForms`, so the
Host persists the values in the active profile's Cordis patch and the running
plugin sees them without a restart: `endpoint`, `model`, `apiKeyRef`,
`timeoutMs`, `mode`, and the five feature toggles are `.volatile()` in the
Config schema, and the runtime binds them as live getters. A profile that does
not compose the Web client simply does not show the page; the same fields stay
editable in the profile patch.

The key is resolved through `ctx.credentials.resolve` and then the environment,
so a deployment that supplies `SYSTEMONE_API_KEY` externally can leave the
Settings field blank.

## Swarm panel (right sidebar)

The browser half also registers a **Swarm** tab in the right sidebar. Open the
right sidebar (its expand button sits in the conversation header corner), pick
**Swarm** from the guide — or let it auto-open: the poller opens the tab once
when a session enters swarm mode.

It shows, live:

- the decision plane: mode, model, and endpoint;
- active swarm sessions with their preset and session id (the on-screen session
  is marked), plus the persona catalog with assignment counts;
- the recent decision feed — tool selection, call assessment, persona policy,
  loop guard, and `swarm_assign` stage → persona — with the counters beside it.

When the `@local/objective-engine` bundle is also composed, the panel adds an
**Objectives** block: the engine's paused/running state, admission counts, and
each tracked objective with its round budget.

The panel polls every 3 s (paused in a hidden tab; refresh on visibility) and
has a manual refresh button. Its **»** button collapses the sidebar; the
sidebar's own chrome also collapses and re-opens it.

Data path: `GET /systemone/panel.json`, registered only where the Web host and
its connection gate are composed. The handler runs `connection.admit(request)`,
which applies the same Host/Origin fence and browser-session cookie check as
`/api`, so an unauthenticated request receives 401. The payload is decision
metadata only — counters, recent decisions, persona catalog, and swarm-mode
session ids — never prompts, tool arguments, credentials, or session content.

## Questions

`noul`, `choice`, `score`, and `box`. A `box` question locates what its
instructions describe in an attached image and answers `{ top, bottom, left,
right }` as fractions of the image; it requires `images` and fails fast without
them.

## Images (vision)

`systemone_ask` accepts `images: [{ path, name? }]` and sends the TypeSafe
assets protocol: `multipart/form-data` with a `request` JSON part plus
`asset-N` binary parts, referenced from `state` as `{ assets: { alias: { type,
part } } }`.

**This deployment does not accept it.** The Qev Playground server parses the
body as JSON only (`POST` with `application/json`) and answers `422 invalid
JSON` to multipart, so image decisions are unavailable here; the tool returns
an explicit error instead of a silent failure. The client code is retained for
a TypeSafe-compatible endpoint. Base64 in `state` is not a substitute — the
contract expects assets.

## Notes

- `enforce` + disabled approval prompts = every `ask` becomes a denial. Keep
  approvals enabled before switching modes.
- `restrict()` may only name tools a scope *inherits*: a tool the agent
  registered on its own layer is visible but not restrictable, and naming one
  rejects the whole filter. The layer tries the full allow-list, trims the
  scope-local names the rejection names, retries once, then fails open.
  `ctx.tools.schemas()` (the global view) is not a usable stand-in for
  "restrictable names" here — it returns only the few tools registered on the
  global layer while host tools live on the agent plane, which is how an
  enforce rollout once collapsed a 38-tool selection to 4 and hid every tool.
  The `selection.alwaysAllow` escape hatch keeps `bash`, `edit`, `glob`, `grep`,
  `read`, and `write` visible regardless.
- Model routing is unverified end to end; leave it off until a route target is
  added and observed.
- Calibration observed on a real shadow run: category probabilities across a
  documentation/config task were 0.11–0.33, so the default selection threshold
  is `0.25`; on-task assessments scored 0.46–0.64 `matchesTask`, while a
  meta-tool call scored 0.24 and is recorded as a note rather than a gate.
- Verify state with the `systemone_status` tool: `layer.mode`,
  `layer.selectionCategories`, `layer.stats`, and the last 20 decisions in
  `layer.recent`.
