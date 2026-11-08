/**
 * Model-facing tools (design §8.2): eleven host-plane tools whose execute
 * bodies re-check authority before touching the engine. Tool identity is
 * the deterministic boundary between objectives and progress; Mammoth is
 * reachable only through objective_classify and is advisory.
 */
import { fullStatus } from './status.js'

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

const tool = ({ name, description, parameters, execute }) => ({
  name,
  description,
  parameters,
  output: { schema: {}, render: renderJson },
  async execute(args, exec) {
    const value = await execute(args !== undefined && args !== null && typeof args === 'object' ? args : {}, exec)
    // Tool output must be lossless JSON: drop undefined-valued keys.
    return JSON.parse(JSON.stringify(value))
  },
})

const str = (description) => ({ type: 'string', description })
const int = (description) => ({ type: 'integer', description })
const strings = (description) => ({ type: 'array', items: { type: 'string' }, description })
const CHECK_SCHEMA = {
  type: 'object',
  description: 'How a verifier proves the criterion.',
  properties: {
    kind: str('command | artifact | human-ack | evidence'),
    command: str('Command to run (command checks).'),
    cwd: str('Working directory for the command.'),
    expectedExitCode: int('Expected exit code (default 0).'),
    timeoutMs: int('Command timeout.'),
    path: str('Artifact path (artifact checks).'),
    sha256: str('Expected artifact digest.'),
    prompt: str('Question for the human (human-ack checks).'),
    hint: str('What evidence the verifier should cite (evidence checks).'),
  },
}
const CRITERIA_SCHEMA = {
  type: 'array',
  description: '1–12 checkable criteria: a string (verifier evidence) or {statement, check, requiresHumanAck}.',
  items: {
    oneOf: [
      { type: 'string' },
      { type: 'object', properties: { statement: str('The checkable statement.'), check: CHECK_SCHEMA, requiresHumanAck: { type: 'boolean' } }, required: ['statement'] },
    ],
  },
}
const SCOPE_SCHEMA = {
  type: 'object',
  description: '{kind:"paths", paths:[…]} — two active objectives may not overlap.',
  properties: { kind: str('paths'), paths: strings('Workspace paths this objective may change.') },
}
const BUDGET_SCHEMA = {
  type: 'object',
  description: 'Counter maxima: rounds, tokens, wallTimeMs, items, verifierRuns, concurrency.',
  properties: {
    rounds: int('Admitted engine prompts.'),
    tokens: int('Token budget (measured when the token meter is composed).'),
    wallTimeMs: int('Wall-clock budget from activation.'),
    items: int('Work items.'),
    verifierRuns: int('Verifier runs.'),
    concurrency: int('Concurrent dispatched items.'),
  },
}
const EVIDENCE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      criterionId: str('Criterion id this entry proves (verdicts).'),
      kind: str('command | artifact | inspection | evidence'),
      command: str('Command that was run.'),
      cwd: str('Where it ran.'),
      exitCode: int('Exit code observed.'),
      stdoutExcerpt: str('Up to 2 KB of output.'),
      path: str('Artifact path.'),
      sha256: str('Artifact digest.'),
      note: str('What was inspected.'),
      failed: { type: 'boolean', description: 'This entry demonstrates a failure.' },
    },
  },
}

export const buildTools = ({ engine, authority, classifier, pump, statusParts }) => {
  const actorOf = (exec) => authority.actorOf(exec)
  return [
    tool({
      name: 'objective_create',
      description:
        'Create an objective: a body of work with checkable acceptance criteria, an owner session, a scope, and budgets. Requires a direct human message in the current turn of a top-level session (the human creates objectives; an agent-created one is only "proposed" when allowAgentProposedObjectives is on). ' +
        'Criteria may be strings (verifier evidence) or objects {statement, check:{kind:"command"|"artifact"|"human-ack"|"evidence", command?, cwd?, expectedExitCode?, path?, sha256?, prompt?}, requiresHumanAck?}. Beyond the active limit the objective is queued.',
      parameters: {
        type: 'object',
        properties: {
          statement: str('The end state that should be true when the objective completes (not an activity).'),
          criteria: CRITERIA_SCHEMA,
          priority: int('0 (human-urgent) … 9 (background); default 5.'),
          scope: SCOPE_SCHEMA,
          budget: BUDGET_SCHEMA,
          idempotencyKey: str('Repeat the same key to make creation idempotent.'),
          allowDuplicate: { type: 'boolean', description: 'Allow a statement identical to one created in the last 24h.' },
        },
        required: ['statement', 'criteria'],
      },
      execute: (args, exec) => engine.create(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_status',
      description: 'Read the engine: mode, counts, limits, measured load, classifier health, pending wakeups, recent events, and every objective with its items and verifications (redacted). Optional objectiveId narrows the records.',
      parameters: { type: 'object', properties: { objectiveId: str('Only this objective.') } },
      execute: (args, exec) => fullStatus(statusParts(), { sessionId: actorOf(exec).sessionId, objectiveId: typeof args.objectiveId === 'string' ? args.objectiveId : undefined }),
    }),
    tool({
      name: 'objective_plan',
      description:
        'Owner-only progress planning. action "add" (default) records a work-order {title, detail, acceptance:[…], criterionIds:[…]} (dispatchable) or a status-report/heartbeat; "accept" / "reject" {itemId, reason} judge a reported item (the producer cannot accept its own work; rejected items are terminal); "cancel" {itemId} stops an open item.',
      parameters: {
        type: 'object',
        properties: {
          objectiveId: str('Objective id (required for add).'),
          action: str('add | accept | reject | cancel'),
          kind: str('work-order (default) | status-report | heartbeat'),
          title: str('Short title of the work order.'),
          detail: str('What exactly to do.'),
          acceptance: strings('Checkable acceptance entries for the work order.'),
          criterionIds: strings('Objective criteria this work order advances (e.g. ["c1"]).'),
          itemId: str('Item to accept/reject/cancel.'),
          reason: str('Reason for reject/cancel.'),
          deferred: strings('Acceptance entries deferred on a partial acceptance.'),
          acceptWithoutEvidence: { type: 'boolean', description: 'Accept a report that carries no evidence (recorded).' },
          expectedRevision: int('Optional compare-and-set guard on the item.'),
        },
      },
      execute: (args, exec) => engine.plan(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_dispatch',
      description:
        'Owner-only: start a worker child for a queued work order. Pass the persona swarm_assign returned and a self-contained brief; the engine starts the child with that preset, records the provenance, and settles the item when the child ends. Refused while the engine is paused, the objective is disarmed, or admission is busy (admission-busy carries retryAfterMs).',
      parameters: {
        type: 'object',
        properties: {
          itemId: str('Queued work-order id.'),
          persona: str('Persona/preset id from swarm_assign (architect, writer, researcher, reviewer, …).'),
          brief: str('Self-contained brief for the child: files, interfaces, acceptance, constraints.'),
          instructions: str('Optional persona instructions returned by swarm_assign.'),
          reassign: { type: 'boolean', description: 'Allow a different persona than the item was planned for.' },
          external: { type: 'boolean', description: 'Fallback when no subagent service is composed: mark dispatched and bind the child later with objective_report.' },
          expectedRevision: int('Optional compare-and-set guard on the item.'),
        },
        required: ['itemId', 'persona', 'brief'],
      },
      execute: (args, exec) => engine.dispatch(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_report',
      description:
        'Report progress. The assigned child reports on its work order {itemId, text, evidence:[…]} (kind "heartbeat" only proves liveness); the owner files objective-level status reports {text}. Reports never complete anything and cannot create work orders.',
      parameters: {
        type: 'object',
        properties: {
          objectiveId: str('Objective id.'),
          itemId: str('Work order being reported (child) — omit for an objective-level report (owner).'),
          text: str('What was done, how it was checked, or the blocker.'),
          kind: str('status-report (default) | heartbeat'),
          evidence: { ...EVIDENCE_SCHEMA, description: 'Up to 3 entries: {kind:"command", command, exitCode} or {kind:"artifact", path, sha256}.' },
          childSessionId: str('Fallback only: bind an externally started child to the item (owner).'),
          expectedRevision: int('Optional compare-and-set guard on the item.'),
        },
        required: ['objectiveId'],
      },
      execute: (args, exec) => engine.report(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_verify',
      description:
        'Owner (or human): request independent verification of an active objective. Requires every linked work order to be accepted (or force:true). The engine pins the commit, starts a verifier child with a distinct preset, and the verifier answers through objective_verdict. A subset of criterionIds makes an advisory verification that can never complete the objective.',
      parameters: {
        type: 'object',
        properties: {
          objectiveId: str('Objective id.'),
          criterionIds: strings('Optional subset (advisory).'),
          force: { type: 'boolean', description: 'Verify even when no work order is linked.' },
          expectedRevision: int('Optional compare-and-set guard.'),
        },
        required: ['objectiveId'],
      },
      execute: (args, exec) => engine.verify(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_verdict',
      description:
        'Verifier only: record the verdict for a verification with per-criterion evidence. approve needs evidence for every mechanical criterion, the pinned commit, and a clean workspace; reject needs failing evidence; anything else is recorded inconclusive. The owner and any producer child are rejected.',
      parameters: {
        type: 'object',
        properties: {
          verificationId: str('Verification id from the brief.'),
          verdict: str('approve | reject | inconclusive'),
          reason: str('Why.'),
          commit: str('git rev-parse HEAD in the verified workspace.'),
          workspaceClean: { type: 'boolean', description: 'git status --porcelain was empty.' },
          evidence: { ...EVIDENCE_SCHEMA, description: 'One entry per criterion: {criterionId, kind:"command"|"artifact"|"inspection", command?, exitCode?, path?, sha256?, note?, failed?}.' },
        },
        required: ['verificationId', 'verdict', 'evidence'],
      },
      execute: (args, exec) => engine.verdict(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_ack',
      description: 'Human only (direct human message in a top-level session): acknowledge the judgment criteria of an approved objective ("ack" completes it) or send it back with a note ("send-back" pauses it).',
      parameters: {
        type: 'object',
        properties: {
          objectiveId: str('Objective id.'),
          decision: str('ack | send-back'),
          criterionIds: strings('Criteria being acknowledged (default: all that require an ack).'),
          note: str('Required for send-back.'),
          expectedRevision: int('Optional compare-and-set guard.'),
        },
        required: ['objectiveId', 'decision'],
      },
      execute: (args, exec) => engine.ack(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_control',
      description:
        'Human only: approve a proposed objective, pause, resume (budget must not be exhausted), cancel, edit {statement, criteria, priority, scope} (a criteria edit supersedes every verification and pauses the objective), budget-raise {budget:{rounds,…}}, or reset-attempts.',
      parameters: {
        type: 'object',
        properties: {
          objectiveId: str('Objective id.'),
          action: str('approve | pause | resume | cancel | edit | budget-raise | reset-attempts'),
          reason: str('Reason (pause/cancel).'),
          statement: str('New statement (edit).'),
          criteria: { ...CRITERIA_SCHEMA, description: 'New criteria (edit).' },
          priority: int('New priority (edit).'),
          scope: { ...SCOPE_SCHEMA, description: 'New scope (edit).' },
          budget: { ...BUDGET_SCHEMA, description: 'Counters to raise (budget-raise).' },
          expectedRevision: int('Optional compare-and-set guard.'),
        },
        required: ['objectiveId', 'action'],
      },
      execute: (args, exec) => engine.control(args, actorOf(exec)),
    }),
    tool({
      name: 'objective_system',
      description:
        'Engine driver control. It boots paused after every host start. resume (human, top-level session) arms progress prompts; resumeAll:true also resumes objectives paused by the restart. pause is the kill switch: it expires wakeups, cancels engine-started children, and survives restart. status returns the engine record.',
      parameters: {
        type: 'object',
        properties: {
          action: str('resume | pause | status'),
          reason: str('Pause reason.'),
          resumeAll: { type: 'boolean', description: 'Also resume objectives paused by a process restart.' },
        },
        required: ['action'],
      },
      execute: (args, exec) => {
        const result = engine.system(args, actorOf(exec))
        if (result.ok && args.action === 'resume' && pump !== undefined) pump.kick()
        return { ...result, engine: fullStatus(statusParts()).engine }
      },
    }),
    tool({
      name: 'objective_classify',
      description:
        'Ask Mammoth whether a message is a new objective, progress toward an existing objective, an objective update, not work, or none of these. Advisory only: the proposal is journaled and never changes state; act through objective_create (human) / objective_plan / objective_report, or ask the human when it is ambiguous. At most two calls per message.',
      parameters: {
        type: 'object',
        properties: {
          text: str('The message to classify.'),
          objectiveId: str('Optional objective the message may belong to.'),
        },
        required: ['text'],
      },
      execute: (args, exec) => classifier.classify({ sessionId: actorOf(exec).sessionId, text: args.text, objectiveId: args.objectiveId }),
    }),
  ]
}
