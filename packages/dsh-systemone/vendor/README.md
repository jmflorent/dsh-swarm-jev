# Vendored schema dependency

This directory vendors the only runtime dependency of the `@local/systemone`
bundle so a linked/offline install needs no registry resolution:

| Vendored package | Version | Upstream | License |
|---|---|---|---|
| `@deepseek-ai/schemastery` | 3.18.5 | `deepseek-ai/deepseek-harness` → `vendor/schemastery` | MIT |
| `@deepseek-ai/cosmokit` | 1.8.6 | `deepseek-ai/deepseek-harness` → `vendor/cosmokit` | MIT |

They are copied from the DSH 0.2.2-rc.1 installation unchanged, except one
relative import in `schemastery/index.mjs` (`@deepseek-ai/cosmokit` →
`../cosmokit/index.mjs`). `@standard-schema/spec` is type-only and not needed at
runtime. License texts are beside each vendored file.

The bundle also replaces `@deepseek-ai/dsh-tools` `defineTool` with
`lib/define-tool.js`, which produces the same registry-ready definition shape
without importing that package's large dependency closure.

Refresh policy: re-copy both `lib/index.*` files from the matching DSH release
and re-apply the import rewrite when upgrading the harness.
