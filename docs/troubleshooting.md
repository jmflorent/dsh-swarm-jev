# Troubleshooting

Start with the built-in diagnostics before changing anything.

| Question | How to answer |
|---|---|
| Is the bundle loaded at all? | Does `systemone_status` exist in a session? Does **Settings → Decision model** appear (Web)? |
| Is the endpoint reachable? | `systemone_status({ probe: true })` |
| What does the layer think? | `systemone_status().layer` — `mode`, `features`, `stats`, `recent` |
| What config is actually composed? | `dsh --profile <name> --dump-config` |
| What did the app log? | The DSH host log / terminal that launched the app; decision warnings are prefixed `[systemone]` |

A healthy probe looks like:

```json
{
  "ok": true,
  "endpoint": "http://127.0.0.1:8008/v1/systemone",
  "model": "decision-model",
  "auth": "credential configured",
  "probe": {
    "ok": true,
    "answers": { "probe": { "type": "noul", "noul": 0.99 } }
  }
}
```

---

## Endpoint unreachable

**Symptoms:** `systemone_status({ probe: true })` returns `probe.ok: false`;
tool errors contain `connection to the decision endpoint failed` or
`no answer within <timeout> ms`; assessment failures in `enforce` produce `ask`.

| Cause | Check | Fix |
|---|---|---|
| Decision server not running | `curl -sS http://127.0.0.1:8008/health` (or your host) | Start it |
| Wrong URL or port | Compare the Settings endpoint with the server's listen address | Correct `endpoint` |
| Wrong path | The plugin posts to the URL exactly as configured; it does not append a path | Include the full path, e.g. `/v1/systemone` |
| Firewall / bind address | Server bound to `127.0.0.1` but DSH reaches it through a different host | Bind the right interface or use the right host |
| Timeout too short | `latencyMs` in `lastCall` / probe near `timeoutMs` | Raise `timeoutMs` (Settings) |
| TLS/proxy | `https://` endpoint with an untrusted certificate | Use a trusted certificate or a local HTTP endpoint you control |

Nothing in the plugin retries silently. A failed selection is skipped (full tool
set kept), a failed assessment becomes `ask`/`cancel` in `enforce`, and the
failure is counted in `layer.stats.failures` with `layer.stats.lastFailure`.

---

## Authentication failures

**Symptoms:** HTTP `401`/`403` in `error`/`status`; probe fails while `curl`
without auth succeeds or vice versa; `auth` says `"no credential (requests carry
no auth header)"`.

| Cause | Check | Fix |
|---|---|---|
| No key configured | `systemone_status().auth` | Set the key in **Settings → Decision model** |
| Environment key not visible to a GUI app | Was DSH launched from a shell that exports `SYSTEMONE_API_KEY`? | Use the credential service instead; GUI processes do not inherit shell env reliably |
| Wrong credential reference | The Settings page shows the reference; the profile row's `apiKeyRef` | Align `apiKeyRef` with where you stored the key |
| Key set but rejected | The endpoint's own logs; try the key with `curl -H "Authorization: Bearer …"` | Re-enter the key; check the endpoint's auth mode |
| Endpoint requires no auth | Requests work without a header | Set `apiKeyRef: ''` (or clear the key) to stop sending one |
| Key was cleared accidentally | `auth` shows no credential | Re-enter it; **Clear key** is irreversible for the stored value |

The key never appears in tool output or logs; `systemone_status` reports only
whether one resolved. If a Settings save reports
`"The settings were saved, but the API key could not be written"`, the config
part succeeded and only the credential write failed — fix the credential
service or re-enter the key.

---

## The decision model returns invalid answers

**Symptoms:** `systemone_ask` returns `ok: false` with
`the response carries no "answers" object`; or `ok: true` with ids in
`unmatched`; or low-probability decisions.

| Symptom | Meaning | Fix |
|---|---|---|
| `response carries no "answers" object` | The URL answered, but not with the System One contract — often a 404 page, a chat-completions API, or an HTML error | Point `endpoint` at the decision endpoint, not a generic model server |
| `the decision endpoint returned a body that is not JSON` | Wrong service or a proxy/error page | Fix the URL or the proxy |
| `unmatched: ["id"]` | The answer's shape did not match the question type | `noul` expects `{ noul }`; `choice` expects `{ choice }` with a label from `criteria`; `score` expects `{ score }`; `box` expects `{ box: {top,bottom,left,right} }` |
| `choice` answers always unmatched | Labels in `criteria` must be exactly the ids the model returns | Use simple token-like labels (no spaces unless the endpoint supports them) |
| `score` questions rejected | `criteria` must be an array of ≥ 2 level descriptions | Provide at least two levels, lowest first |
| `box` rejected before sending | A `box` question requires `images` | Attach PNG/JPEG images, or stop using `box` on this deployment |
| `too many questions` | More than `maxQuestions` in one call | Batch less, or raise the limit in the profile patch |
| `serialized request is N characters` | State/questions exceed `maxRequestChars` | Trim the state or raise the limit |
| Decisions look badly calibrated | Thresholds were calibrated on a different model/endpoint | Run in `shadow`, read `layer.stats`/`layer.recent`, adjust `thresholds` |
| Endpoint reports `422 invalid JSON` for images | The endpoint is JSON-only (the reference deployment is) | Call without `images`; see [Images](decision-system.md#images-and-the-vision-limitation) |

Model output is never coerced: a malformed answer is reported, not repaired.
That is deliberate — a wrong decision is worse than a visible error.

---

## Tool selection hides tools

| Symptom | Cause | Fix |
|---|---|---|
| A tool is missing for one step | Selection chose a category set that excludes it | Add the **tool** to `selection.alwaysAllow`, or add its category to the needed set |
| Selection never narrows anything | `toolCategories` is empty (debug log "no tool categories configured") | Configure a taxonomy |
| Warning "tool selection skipped: N categories exceed maxCategories" | Catalog too large | Raise `maxCategories` or trim `categories` |
| Warning "tool restriction skipped: only N of M tools selected" | The < 15% fail-open guard fired | That is the guard working; inspect the probabilities in `layer.recent` |
| Warning "tool restriction rejected" | The filter named tools registered on the agent's own layer | The layer trims and retries once; if it still fails it fails open. This mostly affects preset-scoped tools |
| An `enforce` rollout once collapsed to 4 tools | An old known failure mode; the current code fails open and the author's profile sets `selection.alwaysAllow` | Keep a `selection.alwaysAllow` escape hatch |

Watch selection in `shadow` first: `layer.recent` records
`{ decision: "selection", probabilities, allow, latencyMs }`.

---

## Swarm mode shows nothing

Swarm mode is inert by design until a **session enters it**.

| Symptom | Cause | Fix |
|---|---|---|
| No orchestrator behavior after setting `mode: swarm` | No session called `swarm_enter` | Start an orchestrator session and call `swarm_enter` (or ask it to enter swarm mode) |
| Other sessions behave normally in swarm mode | Correct: with `mode: swarm`, only sessions that entered are enforced; every other session is `off` | Enter swarm mode in the session that should be the orchestrator |
| Orchestrator lost coordination tools | `swarm.orchestratorTools` is the allow-list; everything else is intentionally hidden | Add needed tools to the list in the profile patch |
| Orchestrator cannot edit files | Correct: the orchestrator is restricted to coordination/reading; workers do stage work | Dispatch a worker; do not widen the orchestrator |
| `swarm_assign` returns `no persona candidates configured` | `swarm.personas` is empty (an empty map falls back to the built-in catalog, but the top-level row may be malformed) | Configure `swarm.personas` |
| `swarm_assign` returns `the decision model returned no readable persona` | The model answered a label outside `criteria` | Check the model/endpoint; keep persona ids simple and their descriptions distinct |
| Swarm state vanished after reload | Membership is an in-memory `Set`; it is not durable | Re-enter swarm mode |
| Swarm mode has no effect in a session | Swarm enforcement is opt-in per session; there is no preset list | Call `swarm_enter` in that session explicitly (membership is process-local and resets on restart) |
| Enforcing a swarm session denies everything | `mode: swarm` + assessment/judge/`policy` + no approvals = every `ask` becomes a denial | Keep approvals enabled; start in `shadow`; inspect `layer.recent` |

Verify with `systemone_status().layer.swarm` (`active`, `personas`,
`judgedPresets`) and `layer.recent` entries with `preset`/`tool`/`action`.

---

## Objective engine prompts do not fire

The objective engine is a second bundle and its driver is intentionally opt-in.

| Symptom | Cause | Fix |
|---|---|---|
| `objective_status` reports `engine.mode: "paused"` | The engine boots paused after every host start | `objective_system { action: "resume" }` from a **human turn in a top-level session**; after a restart add `resumeAll: true` |
| `objective_system resume` returns `unauthorized` | The call came from an engine wakeup, a subagent, or a turn without a direct human message | Type a message in the top-level session and call it in that turn |
| `objective_system resume` returns `paused-sentinel` | `PAUSED` exists in the data directory | Remove the file, then resume |
| Resumed, but no prompt arrives | No actionable objective (all queued/paused/blocked/completed), the objective is not `armed`, or the owner session is not live in this process | `objective_status`: check `state` and `armed`; `objective_control resume` a paused objective; open the owner session and wait for its idle edge |
| Prompts stopped for one objective | A budget counter is exhausted (`blocked`, `blockedReason.code: "budget-exhausted"`, `detail` names the counter) | `objective_control { action: "budget-raise", budget: { rounds: N } }`, then `resume` |
| `blocked: worker-failures` / `verification-failed` | Three worker failures, or two rejected/inconclusive verifications | Fix the brief or criteria, `objective_control reset-attempts` (or `edit`), then `resume` |
| Wakeup arrived but the turn was rejected | The pre-step fence found the wakeup stale (objective changed state, disarmed, engine paused) or a duplicate | Nothing to do: the next idle edge sends a fresh prompt and no round was spent |
| `objective_create` returns `unauthorized` | Objectives are human-created; this was an agent turn | The human writes the objective in the top-level session; or set `allowAgentProposedObjectives` and approve with `objective_control` |
| `objective_create` returns `admission-rejected` / `duplicate-objective` / `scope-conflict` | Owner cap or queue depth, same statement within 24 h, overlapping `scope.paths` with an active objective | Complete/cancel an objective, pass `allowDuplicate`, or narrow the scope |
| `objective_dispatch` returns `dispatch-unavailable` | No subagent service is composed in this profile | Pass `external: true`, start the child with the `subagent` tool, bind it with `objective_report { itemId, childSessionId }` |
| `objective_dispatch` returns `admission-busy` | In-flight items, dispatch rate, or per-objective concurrency at the cap | Wait `retryAfterMs`; accept reported items first |
| `objective_verify` returns `not-ready` | A linked work order is still queued/dispatched/reported | Accept or cancel it; `force: true` verifies without work orders |
| Verifier child never answers | It ended without `objective_verdict` | The engine records `inconclusive`; one re-request is allowed, then `verification-failed` |
| `objective_verdict` returns `unauthorized` | The caller is the owner, a worker, not the engine-started verifier, or shares the producer's preset | Only the verifier child answers; for `external` records use a `reviewer`/`verifier` session |
| Verdict was approve but recorded inconclusive | `downgrade`: `wrong-commit`, `dirty-workspace`, `commit-not-reported`, `missing-evidence:c1`, `criteria-changed` | Commit the work, keep the workspace clean, cover every criterion with evidence |
| Objective stuck in `awaiting-human` | A judgment criterion needs a human ack | `objective_ack { decision: "ack" }` or `send-back` in a human turn; after `maxAckAgeMs` it blocks |
| `engine-degraded` | `LOCK` held by a live pid, a journal gap/hash mismatch, or a write failure | Read `engine.degraded`; stop the other host, or back up and repair `journal.jsonl` (truncate to the last good line); delete `snapshot.json` to force a full replay |
| `classifier-unavailable` / `classifier-circuit-open` / `classifier-rate-limited` | The decision endpoint failed, the breaker is open, or the hourly cap is reached | Deterministic tools keep working; check `systemone_status`; the breaker closes after `breakerCooldownMs` |
| No Objectives block in the Swarm panel | The objective-engine bundle is not installed/enabled, or the engine row failed to load | Check the sidebar Plugins page; `objective_status` tells you whether the tools exist |

The data lives in `$DSH_HOME/storages/objective-engine/` (`journal.jsonl`,
`advisory.jsonl`, `snapshot.json`, `LOCK`, optional `PAUSED`). The engine logs
`[objective-engine] ready · mode=… · journal=…` with the restart reconciliation
counts when it loads.

---

## The Settings page is not visible

**Settings → Decision model** is the browser half of the systemone package. It
appears only when the Web client composes it.

| Check | Expected |
|---|---|
| Bundle installed and enabled | `@local/systemone` in the active profile's `dsh.profile.bundles` and enabled on the sidebar **Plugins** page |
| Package declares the client | `package.json` has `exports["./client"]` and `dsh.client.platform === "web"` |
| Web client running | This is the DSH Web app; headless/CLI compositions never show client pages |
| App reloaded after install | A full Web client reload/restart, not only a host plugin reload |
| Browser cache | Hard-refresh the page |
| Version compatibility | `engines.dsh` accepts your DSH (`>=0.2.2-rc.1 <0.3.0`); `engines.node >= 24` |
| Client services available | The bundle declares `@deepseek-ai/dsh-client-locale`, `@deepseek-ai/dsh-client-ui-settings`, `@deepseek-ai/dsh-api-remotes`; a stripped-down Web build may not provide them |

If the page cannot be shown by your composition, the same fields stay editable
in the profile patch — the host half works without the browser half. That is a
supported configuration, not a bug.

If the page shows but says **"This deployment's settings are read-only"** or
**"The Host does not expose settings for this plugin"**, the host's config-forms
service is unavailable or read-only; edit the profile patch.

---

## Settings changes do not apply or do not persist

| Symptom | Cause | Fix |
|---|---|---|
| Change saved, no effect | Field is not volatile, or you are looking at a session that already captured its composition | Volatile: endpoint, model, apiKeyRef, timeoutMs, mode, and the five feature toggles. Others need a reload |
| Change reverted after restart | Save did not reach the profile patch (read-only settings, conflict, or write error) | Check the save message; inspect the profile patch; verify the active profile |
| Save reports a conflict | The settings changed elsewhere (another window or hand edit) | Review the reloaded values and save again |
| Settings appear in a different profile | Settings write the **active** profile's patch | Switch to that profile or copy the row |
| Key field saves but auth still fails | Credential write failed or `apiKeyRef` points elsewhere | See [Authentication failures](#authentication-failures) |
| Non-volatile limits changed in Settings ↗ nothing | Limits are not on the page by design | Edit the profile patch |

Remember: a row override replaces the bundle's `config` wholesale. If you
hand-write a small override later, you may drop the fields the Settings page had
saved.

---

## Custom presets show "failed to load"

The roster's diagnostic names the unusable row. Opening a failed preset's
configuration shows the exact failure, for example:

```text
tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config:
  - $.sampleOverCapGlobResults missing required value
```

A preset fails as a whole when one of its mounted rows rejects its config. In
DSH 0.2.2-rc.1 two plugin configs are required, and older persona bundles
omitted them:

| Row | Required field | Value used here |
|---|---|---|
| `@deepseek-ai/dsh-tool-fs-search` | `sampleOverCapGlobResults` | `false` (same as the shipped Standard preset) |
| `@deepseek-ai/dsh-tool-todo` | `allowParallelInProgress` | `true` for orchestrator/researcher, `false` for the other roles |

Fix in `packages/dsh-personas/cordis.patch.yml`, then disable and re-enable the
bundle on the Plugins page and confirm the roster has no failed presets. This
repository's bundle already carries the fields.

## Version mismatch or loader errors

| Symptom | Cause | Fix |
|---|---|---|
| `dsh --version` is not `0.2.2-rc.1` | The bundle targets `>=0.2.2-rc.1 <0.3.0` | Use a supported DSH, or fork and adjust `engines` at your own risk |
| Loader complains it cannot resolve `@local/systemone` | The package is not a profile dependency, or the bundle is not in `dsh.profile.bundles` | Re-run the install path in [`docs/install.md`](install.md) |
| Loader complains about `@deepseek-ai/dsh-tools` or `@deepseek-ai/schemastery` | You installed the old 0.2.3 package, which needed registry resolution | Install `packages/dsh-systemone` 0.2.4 or later: its schema library is vendored and it has no runtime dependencies |
| Node version error | DSH's bundled Node is older than 24 | Update DSH; the bundle expects the DSH-provided Node |
| Client package fails to build | The Web client build step failed; host half still works | Restart DSH; check the app log; if persistent, use the profile patch and remove the client half only if you fork |
| `EACCES` on profile files | Profile directory permissions | Fix ownership/permissions on `~/.dsh/profiles/<name>` |
| Bundle row names an uninstalled package | A leftover profile row override after removal | Remove/comment the row in the profile patch |

The reliable reset is: stop DSH, back up the profile's `cordis.patch.yml`,
restore a known-good version, restart, and re-apply changes one at a time.

---

## Loop guard denies a repeated call

**Symptom:** in `enforce`, a tool call fails with
`identical <tool> call already completed N times; change the arguments or the
approach before retrying`.

That is deterministic loop detection working: the same tool with the same
arguments has completed `maxRepeats` (default 2) times. Change the call, or raise
`loopDetection.maxRepeats` if the workflow legitimately repeats. The counter
resets when a user message enters the step or the agent is disposed.

---

## Enforce mode is surprising

- **`ask` becomes a denial when approvals are disabled.** Keep approval prompts
  enabled, or use `onFailure: hold` deliberately.
- **Every gated call costs a round-trip** when assessment is enabled. Compare
  `layer.stats.assessments` with wall-clock latency before enforcing broadly.
- **A restrictive taxonomy can fail open.** That is safety, not a bug: the layer
  will not apply a restriction that would leave almost no tools.
- **Per-preset overrides apply by preset id**, not display name. Verify with
  `layer.presetOverrides` and the `preset` field in `layer.recent`.

Go back to `shadow` (Settings or profile patch) whenever behavior is unclear;
shadow computes the same decisions and records them without changing anything.

---

## Running the package tests

```bash
cd packages/dsh-systemone
pnpm test             # = node test/run.mjs
```

The tests spin up an in-process mock System One endpoint, import the real plugin
modules, and assert the tools, decision layer, policy, vision transport, and
swarm behavior. They need no DSH process and no installed dependencies.

---

## What to include in a bug report

1. DSH version (`dsh --version`), OS, and whether it is the Web client.
2. `systemone_status()` output (it never contains the key).
3. `dsh --profile <name> --dump-config` with secrets and hostnames redacted.
4. The relevant `[systemone]` log lines.
5. Which mode you were in, and whether the session had entered swarm mode.
