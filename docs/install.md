# Installing on another DSH installation

This guide installs the three bundles on a DeepSeek Harness installation that
is not the author's. The target release is **DSH 0.2.2-rc.1** — the version all
three bundles were built and tested against — using the Node/pnpm runtimes
shipped with DSH.

- The bundles are ordinary DSH plugin packages; nothing is compiled and there is
  no build step.
- You can install through the DSH Web plugin manager (recommended), the DSH CLI
  plus a package-list edit, or by wiring the profile files by hand.
- Both paths end in the same state: the packages are dependencies of the
  profile, their names are in the profile's bundle list, and (optionally) a
  profile patch row overrides their configuration.

---

## 1. Prerequisites

| Requirement | Check |
|---|---|
| DeepSeek Harness **0.2.2-rc.1** | `dsh --version` → `0.2.2-rc.1` |
| The DSH-provided Node and pnpm | Nothing to install; the plugin manager and `dsh plugin` use them |
| A directory that will keep the bundles | Do not install from a temporary folder; profile dependencies are `link:` references to the path you choose |
| A reachable System One decision endpoint | Only for `dsh-systemone`; personas work without it |
| Optional: the team bundle | `@deepseek-ai/dsh-experimental-agent-team-profile` for the Phase 0 objective workflow |
| Network access for installs | pnpm must resolve the systemone bundle's two dependencies (`@deepseek-ai/dsh-tools@0.2.1-rc.3`, `@deepseek-ai/schemastery@~3.18.5`) from a registry or a local store; the personas bundle has no dependencies |
| A Web client, for the Settings page | The **Settings → Decision model** page is a browser plugin; headless deployments can configure the same fields in the profile patch |

> **Upgrading DSH later:** reinstall/re-link the bundles after a DSH upgrade and
> re-check `systemone_status`. The plugin API is pre-1.0.

---

## 2. What a bundle is

A **bundle** is an npm-style package with a `dsh.bundle.patch` entry in its
`package.json`:

```json
{
  "name": "@local/dsh-personas",
  "version": "1.0.0",
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

DSH composes a profile from **patch layers** in this order:

```text
1. each bundle in profile package.json -> dsh.profile.bundles   (in list order)
2. the profile's own cordis.patch.yml                            (user layer)
3. any --patch <file> overlays passed to the DSH launcher        (last)
```

- A bundle's `cordis.patch.yml` is a patch list. The shipped bundles use
  `- insert: [...]` to add **rows**.
- A **row** is a plugin instance: `{ id, name, config }`. `name` is the package
  or a built-in module; `config` is validated by that plugin's `Config` schema.
- **Row ids are stable handles.** The profile patch can override a row by id,
  and a row override replaces the row's `config` **wholesale**.
- Bundles can also add groups (`cordis:group`) and presets; that is how the
  personas bundle composes sessions.

Two consequences worth internalizing:

1. **Bundle order matters** relative to other bundles only when rows collide or
   when a later row needs an earlier service. Keep `@local/dsh-personas` before
   `@local/systemone`.
2. **The profile patch wins over the bundle.** If a bundle's default endpoint is
   a placeholder, the profile patch (or the Settings screen, which writes there)
   is where the real value belongs. A row override must restate every field the
   deployment needs, because it replaces the whole `config`.

To inspect the composed tree before booting:

```bash
dsh --profile <name> --dump-config
```

---

## 3. Path A — DSH Web plugin manager (recommended)

This is the path the UI is designed for; it updates the profile dependency and
the bundle list together.

1. **Keep the repository somewhere permanent**, for example
   `~/Development/dsh-swarm-jev`.
2. Open the **Plugins** page from the DSH Web sidebar.
3. Choose **Add plugin → local directory** and select
   `<repo>/packages/dsh-personas`.
4. Repeat for `<repo>/packages/dsh-systemone`.
5. Repeat for `<repo>/packages/objective-engine` (no runtime dependencies, so
   this install resolves nothing from the registry).
6. Confirm the bundle list order shows `@local/dsh-personas` before
   `@local/systemone` and `@local/objective-engine` last. If the UI lets you
   reorder, do; otherwise use Path B or C to fix the order in the profile
   `package.json`.
6. Reload or restart DSH when the plugin manager asks for it. Structural changes
   (a newly inserted row) are applied at load; client UI additions need a full
   reload.
7. Configure System One: **Settings → Decision model** — endpoint, model,
   timeout, mode (`shadow` first), and API key (stored in the DSH credential
   service as `SYSTEMONE_API_KEY`). See
   [`docs/decision-system.md`](decision-system.md#settings-screen-and-configuration).
   This page appears only when the DSH Web client composes the bundle
   (`dsh.client.platform: "web"`); in a headless/CLI composition the same fields
   are profile-patch-only.

**What this writes** (for verifiers):

- profile `package.json`: a `link:<abs path>` dependency for each package, and
  the package names in `dsh.profile.bundles`;
- profile `cordis.patch.yml`: only if you edit settings (the Settings screen
  writes the row override there);
- the profile's `node_modules`: pnpm link installs.

---

## 4. Path B — CLI plus a bundle-list edit

The CLI forwards arguments to pnpm inside the profile; it does **not** register
the bundle in `dsh.profile.bundles`, so that one line is a manual edit.

```bash
# 1. Add each bundle as a linked dependency of the profile.
#    (Use the absolute path to the package directories.)
dsh plugin --profile <name> add link:$HOME/Development/dsh-swarm-jev/packages/dsh-personas
dsh plugin --profile <name> add link:$HOME/Development/dsh-swarm-jev/packages/dsh-systemone

# 2. Edit the profile package.json and add the bundle names, in order.
#    $DSH_HOME defaults to ~/.dsh
$EDITOR "$HOME/.dsh/profiles/<name>/package.json"

# 3. If you changed the dependency list by hand instead, install it:
dsh plugin --profile <name> install

# 4. Inspect the composed tree, then restart DSH.
dsh --profile <name> --dump-config
```

The profile `package.json` should contain:

```json
{
  "name": "dsh-profile-<name>",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-personas",
        "@local/systemone"
      ]
    }
  },
  "dependencies": {
    "@local/dsh-personas": "link:/absolute/path/to/packages/dsh-personas",
    "@local/systemone": "link:/absolute/path/to/packages/dsh-systemone"
  }
}
```

Keep whatever shipped bundles the profile already has; add the two local ones at
the end, in this order.

---

## 5. Path C — manual profile wiring

Use this when you cannot use the UI or CLI, or when you are scripted-installing
into a profile. Work with DSH **stopped**.

1. **Place the bundles** at a stable path, e.g.
   `~/Development/dsh-swarm-jev/packages/dsh-personas` and `.../dsh-systemone`.

2. **Edit `~/.dsh/profiles/<name>/package.json`**: add the two dependencies and
   append the bundle names to `dsh.profile.bundles` (see the JSON above).

3. **Install the linked dependencies**:

   ```bash
   dsh plugin --profile <name> install
   ```

   This runs pnpm in the profile directory and creates the `node_modules` links.

4. **Add the configuration row overrides.** Edit
   `~/.dsh/profiles/<name>/cordis.patch.yml` and add rows keyed by the bundle's
   row ids. Start from [`examples/profile-patch.example.yml`](../examples/profile-patch.example.yml);
   never commit the real one (it may contain internal hostnames). A minimal
   System One override looks like:

   ```yaml
   - id: systemone
     name: '@local/systemone'
     config:
       endpoint: 'http://127.0.0.1:8008/v1/systemone'
       model: 'decision-model'
       apiKeyRef: 'SYSTEMONE_API_KEY'
       timeoutMs: 20000
       mode: shadow
   ```

   The bootstrap bundle row itself does not need a profile override; its
   `cordis.patch.yml` is enough. The override exists because the profile layer is
   where deployment values (endpoint, taxonomy, policy) belong and because it
   replaces the bundle row's placeholder defaults wholesale.

5. **Restart DSH.** Verify (next section).

> The profile patch is durable profile state. If you later remove a bundle,
> remove or comment its row override too: a row naming an uninstalled package
> cannot resolve.

---

## 6. Enabling, reloading, and restarting

| Change | How it takes effect |
|---|---|
| Installing/removing a bundle | Plugin manager reload or full DSH restart; the composed tree changes at load |
| Adding/removing a bundle from `dsh.profile.bundles` | Restart (the list is read when the profile boots) |
| Editing a bundle's `cordis.patch.yml` (e.g. a preset prompt) | Reinstall/re-link the bundle, then reload; existing sessions keep their composition |
| Editing the profile patch or Settings values | Reload recommended for structural fields; fields marked `.volatile()` (mode, feature toggles, and the Settings screen's live fields) are read at the next decision without reload |
| Client UI changes (Settings screens) | Full DSH Web reload/restart |
| `swarm_enter` state | In-memory: re-enter after any reload/restart |

Sessions capture their preset composition when they start. A newly installed
preset appears in the picker for **new** sessions; existing sessions keep what
they started with.

---

## 7. Verify the installation

| Check | Expected |
|---|---|
| `dsh --version` | `0.2.2-rc.1` |
| `node --version` inside the profile's install | `>= 24` (the bundle declares `engines.node`) |
| `dsh --profile <name> --dump-config` | The two bundle rows (`preset-*` rows and the `systemone` row) appear in order; the profile patch row overrides them |
| New-session preset picker | Five new presets: Orchestrator, Architect, Writer, Reviewer, Researcher |
| Settings → Agent presets | Same five, after the shipped presets |
| Settings → Decision model | Endpoint, model, timeout, mode, API key fields (after the systemone bundle loads and the Web client is running) |
| `systemone_status({ probe: true })` in a session | `{ ok: true, probe: { ok: true, answers: { probe: { noul } } } }`, `auth` reflects the key, `layer.mode` matches configuration |
| `objective_status` in a session | `{ ok: true }` with `engine.paused: true` (the engine boots paused), limits, and zero counters |
| `objective_system` `{ action: "resume" }` then `pause` | `ok: true` for both; resume reports `paused: false`, pause reports `paused: true` |
| Right sidebar → Swarm panel | An **Objectives** block appears when the engine is composed (paused state, counts, objectives) |
| Plugins (sidebar) | All three bundles listed and enabled |

If a row is missing, check bundle order and the profile path; if the tools are
missing, check `layer.mode` and whether the bundle loaded (Troubleshooting).

---

## 8. Dependencies, offline installs, and the Web client half

- **The personas bundle** has no dependencies. It is pure YAML plus a
  `package.json`.
- **The objective engine bundle** has no runtime dependencies either: Node 24
  built-ins and the harness tool registry only. It also needs no Web client; the
  Objectives block in the Swarm panel appears only when the systemone bundle is
  composed.
- **The systemone bundle** imports two packages at runtime:
  `@deepseek-ai/dsh-tools` (tool definitions) and `@deepseek-ai/schemastery`
  (Config schema). Installing it through the plugin manager or
  `dsh plugin ... install` makes pnpm resolve them. Without registry or store
  access the install fails at resolution time, before DSH loads anything.
- **The host half and the browser half are one package.** The host registers the
  tools, decision layer, and swarm tools; `lib/client.js` is the
  **Settings → Decision model** page. A headless composition loads the host half
  and never loads the browser half — everything except the page still works, and
  the page's fields stay editable in the profile patch.
- **The tools are host-plane.** `systemone_ask`, `systemone_status`, and the
  swarm tools are visible in sessions without adding rows to a preset.

## 9. Updating

```bash
cd ~/Development/dsh-swarm-jev
git pull                     # or replace the checkout
dsh plugin --profile <name> install   # refresh linked packages (no version bump for link:)
# restart DSH
```

Because the dependencies are `link:` references, updating the checkout is
usually enough; restart to load changed module code. Re-read
[`CHANGELOG.md`](../CHANGELOG.md) for behavior changes and re-verify in `shadow`
mode.

---

## 10. Uninstall and rollback

### Disable temporarily

Use the sidebar **Plugins** page to disable a bundle (or remove its name from
`dsh.profile.bundles`) and restart. The package stays installed; the patch layer
is not applied.

### Uninstall

1. Stop DSH.
2. If you added a profile patch row for `systemone`, remove or comment it.
3. Remove the bundle on the sidebar **Plugins** page, or
   `dsh plugin --profile <name> remove @local/systemone`.
4. Confirm `dsh.profile.bundles` and `dependencies` no longer reference the
   package (the plugin manager normally does this; check by hand if not).
5. Restart.

Result: the five presets disappear from the picker/roster; the `systemone_*` and
`swarm_*` tools disappear; sessions that started with a preset keep their
composition until they end.

### Roll back a bad change

- **Configuration:** keep a copy of the profile patch before editing
  (`cp cordis.patch.yml cordis.patch.yml.bak`) and restore it; restart.
- **Bundle version:** check out the previous tag/commit of this repository,
  reinstall the linked packages (`dsh plugin --profile <name> install`), restart.
- **Enforcement surprise:** set `mode: shadow` (Settings or profile patch). In
  shadow the layer computes and logs but does not change behavior. If DSH does
  not boot at all, remove the `systemone` profile row, restart, and re-add it
  with a minimal config.
- **Runaway orchestration:** leave swarm mode (`swarm_exit`), and in `enforce`
  consider setting `mode: shadow` or removing the bundle from the profile until
  you have read the decisions in `systemone_status`.

There is no durable state to migrate for the two shipped bundles: the personas
bundle is stateless, and the systemone bundle keeps only the last-call record and
the bounded recent-decision list in memory.

---

## 11. Post-install checklist

- [ ] DSH version is 0.2.2-rc.1.
- [ ] Both bundles are in `dsh.profile.bundles`, personas before systemone.
- [ ] Five presets visible in the New-session picker.
- [ ] Settings → Decision model shows the endpoint/model/timeout/mode fields (Web client only).
- [ ] `systemone_status({ probe: true })` answers with a `noul`.
- [ ] Mode is `shadow`; approvals are enabled.
- [ ] The API key is in the credential service (`SYSTEMONE_API_KEY`), not in the
      profile patch.
- [ ] The profile patch (if used) contains no credentials and no internal
      hostnames you would not publish.
