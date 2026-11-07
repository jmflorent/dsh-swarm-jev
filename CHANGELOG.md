# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the repository
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file tracks the repository (the bundles and their documentation), not the
DeepSeek Harness release it runs on. See
[Compatibility](README.md#compatibility) for the supported DSH version.

## [Unreleased]

### Added

- `packages/dsh-systemone` — a live **Swarm** panel in the right sidebar
  (`lib/client.js`): active swarm sessions with preset and session id, the
  persona catalog with `swarm_assign` counts, the recent decision feed, the
  counters, and the live decision plane. It auto-opens once when a session
  enters swarm mode and collapses with the sidebar. Data comes from the
  authenticated `GET /systemone/panel.json` snapshot route, which reports
  decision metadata only and refuses unauthenticated or cross-origin requests.

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
