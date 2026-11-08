# Checker evolution acceptance (0.3.0)

**Status: passed** — the deterministic checker executed the delivery criteria,
the independent verifier approved, and the objective completed on 2026-11-08.

## What was exercised

Isolated headless composition (`DSH_HOME=/tmp/dsh-checker-accept`, profile
`headless` + `dsh-base`, the three local bundles, an explicit
`agent-preset-registry`, and the forge model endpoint), with the task delivered
as a top-level `user/message`:

- objective `obj-5ba269e73bf6404aba09` with two mechanical criteria:
  - `c1` command: `test -s docs/checker.md && grep -q 'Ringer' docs/checker.md`
  - `c2` artifact: `docs/checker.md`, at least 2 KiB
- one work order dispatched to a preset `architect` worker; the worker reported;
  the owner accepted it;
- `objective_verify` executed both checks **in the engine** (verification
  `ver-d7fd99a219794cddb2f0`, `checker.mode: "engine"`, `executed: 2`) before
  starting the verifier child;
- verifier child (preset `verifier`, distinct from the producer) confirmed the
  pinned commit `539bc97`, a clean workspace, and approved with full coverage;
- objective state **completed**, completion record names the verification; no
  `mechanical-check-failed` was returned.

Recorded check evidence:

| Criterion | Execution | Result |
|---|---|---|
| `c1` command | engine, cwd repo | exit **0**, 18 ms, passed |
| `c2` artifact | engine, stat + sha256 | exists, **8,898 bytes**, sha256 `13b9dbee…695c`, passed |

The run also produced one transient `engine/overloaded` event during the
verifier wait and an `engine/recovered` event after completion; final load was
idle (`backpressure: false`, no children).

## Defects caught and fixed during this evolution

The audit before merge found three issues in the first checker implementation,
all fixed and covered by regressions:

1. **Checks ran before the verification gate.** A non-owner could call
   `objective_verify` and make the engine execute criterion commands; a request
   with no accepted work order also executed checks before returning `not-ready`.
   `prepareVerification` now validates authority, revision, readiness, budget,
   commit pin, and a clean workspace **before** any check runs.
2. **Duplicate criterion ids could fake full coverage.**
   `criterionIds:["c1","c1"]` was treated as a non-advisory request and could
   complete a two-criterion objective after checking only `c1`. Ids are deduped,
   advisory is decided by set size, and approval requires the verification's
   criteria set to equal every objective criterion id.
3. **Dirty pinned workspaces were checked anyway.** Verification now refuses a
   dirty pinned workspace with `dirty-workspace` before executing checks, so
   executed evidence always corresponds to the pinned commit.

A request-level check run is now re-proved at verdict time: `objective_verdict`
re-executes the mechanical criteria and re-pins the tree, so a delivery that
changes after the request is rejected (a failing final check or
`changed-since-request`) rather than approved on stale evidence.

## What this does not replace

Executed checks catch a missing or broken delivery, not a subtle semantic
wrongness. The independent verifier approval remains mandatory, as does human
acknowledgment for judgment criteria — the Ringer doctrine, kept intact.

## Live deployment finding (journal integrity)

Deploying 0.3.0 to the live profile surfaced a pre-existing store bug rather
than a checker bug: a human-authority owner's objective-level status report was
journaled as `item/reported` with actor `human`, which the fold's allow-list
refused. The event stayed in the journal while the folded state stopped
advancing, so the journal sequence (1556) and the snapshot's folded sequence
(554) diverged and the next boot's `engine/started` was rejected.

Fixed in `9d8cf5f`:

- `item/reported` now accepts a human owner (objective-level status reports).
- `core.append` validates against the fold **before** writing; a rejected event
  can no longer poison the journal.
- Snapshots whose folded `lastSeq` differs from the store's are refused and
  ignored instead of being loaded.

The poisoned live store was archived at
`/tmp/objective-engine-repair-20261108-171440`, truncated to the last folded
sequence (554), and booted cleanly; the engine deployed at 0.3.0 is paused with
the amail objective preserved as `paused`/disarmed.

## Strictness re-run (verdict-time proof)

After the verdict-time and liveness hardening, an isolated headless drill re-ran
the same objective shape (`c1` command, `c2` artifact) against commit `f122cf4`:

- `objective_verify` executed both checks (c1 exit 0; c2 9,495 bytes, sha256
  `44ea2558…`), then `objective_verdict` **re-executed them and re-pinned the
  tree** (`recheck: {commit: f122cf4, dirty: false}`);
- the verifier approved, the objective completed, and the engine named the
  recheck commit in the verdict record;
- the package suite now has 23 sections, including verdict rechecks, fallback
  refusal (`checker-unavailable`), external-verifier preset enforcement,
  malformed-criteria rejection, and zombie/TTL verification cleanup.

The live deployment was upgraded to this build (0.3.0, paused by default).
