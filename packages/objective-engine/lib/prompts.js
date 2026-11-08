/**
 * Versioned engine prompt templates (design §5.3). Deterministic, one text
 * block each, JSON-quoted objective text, and an idempotency header so a
 * duplicate delivery is detectable by the model and by the pre-step fence.
 */
import { TEMPLATE_VERSION } from './records.js'

const quote = (text, max = 400) => JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text)
const budgetLine = (objective) => {
  const b = objective.budget
  return `rounds ${b.rounds.used}/${b.rounds.max}, items ${b.items.used}/${b.items.max}, verifier runs ${b.verifierRuns.used}/${b.verifierRuns.max}` +
    (b.tokens.baseline === undefined ? '' : `, tokens ${b.tokens.used}/${b.tokens.max}`)
}
const header = (kind, objective, wake) =>
  `[OBJECTIVE ENGINE ${kind} template=${TEMPLATE_VERSION} wake=${wake.id} occurrence=${wake.occurrence} objective=${objective.id} revision=${objective.revision}]`

const SWARM_LINE = 'If you are not in swarm mode, call swarm_enter first; route every stage with swarm_assign and use the persona it returns.'
const DUPLICATE_LINE = 'If this wakeup is a duplicate (same wake id already handled), reply "duplicate" and stop.'

export const renderWork = ({ objective, wake, items, criteria }) => {
  const ready = items.filter((item) => item.state === 'queued')
  const inFlight = items.filter((item) => item.state === 'dispatched')
  const reported = items.filter((item) => item.state === 'reported')
  const lines = [
    header('WAKEUP', objective, wake),
    `Objective: ${quote(objective.statement)} (state=${objective.state}, ${budgetLine(objective)})`,
    `Criteria: ${criteria.map((c) => `${c.id}${c.requiresHumanAck ? '†' : ''} ${quote(c.statement, 160)}`).join('; ')}`,
  ]
  if (ready.length > 0) lines.push(`Ready work: ${ready.map((item) => `${item.id} ${quote(item.title, 120)} (criteria ${item.link.criterionIds.join(',')})`).join('; ')}`)
  if (inFlight.length > 0) lines.push(`In flight: ${inFlight.map((item) => `${item.id} → ${item.assignedChild?.sessionId ?? '?'}`).join('; ')}`)
  if (reported.length > 0) lines.push(`Reported, awaiting your acceptance: ${reported.map((item) => `${item.id} ${quote(item.report?.summary ?? '', 160)}`).join('; ')}`)
  lines.push(
    'Do this in order: (1) accept or reject each reported item with objective_plan {action:"accept"|"reject"}; (2) for each ready work order call swarm_assign for the stage, then objective_dispatch with the item id and that persona and a self-contained brief; (3) do not work on files yourself.',
    SWARM_LINE,
    DUPLICATE_LINE,
  )
  return lines.join('\n')
}

export const renderPlan = ({ objective, wake, items, criteria }) => {
  const accepted = items.filter((item) => item.state === 'accepted').map((item) => item.id)
  const lines = [
    header('WAKEUP', objective, wake),
    `Objective: ${quote(objective.statement)} (state=${objective.state}, ${budgetLine(objective)})`,
    `Criteria: ${criteria.map((c) => `${c.id}${c.requiresHumanAck ? '†' : ''} ${quote(c.statement, 160)}`).join('; ')}`,
    accepted.length === 0 ? 'No work order is queued, in flight, or awaiting acceptance.' : `Accepted work: ${accepted.join(', ')}. No work order is open.`,
    'Decide the next step: (a) plan the next work order with objective_plan {action:"add", title, detail, acceptance:[…], criterionIds:[…]} and dispatch it; or (b) if every criterion is covered by accepted work, request independent verification with objective_verify {objectiveId}; or (c) if the objective cannot proceed, say why and ask the human (objective_control is theirs).',
    'Do not spend this turn on a plan you will not execute. Never verify or complete the objective yourself.',
    SWARM_LINE,
    DUPLICATE_LINE,
  ]
  return lines.join('\n')
}

export const renderVerdict = ({ objective, wake, verification }) => {
  const verdict = verification.verdict ?? {}
  const lines = [
    header('VERIFICATION RESULT', objective, wake),
    `Objective: ${quote(objective.statement)} (state=${objective.state}, ${budgetLine(objective)})`,
    `Verification ${verification.id}${verification.advisory ? ' (advisory, subset of criteria)' : ''}: verdict=${verdict.kind}${verdict.requested && verdict.requested !== verdict.kind ? ` (requested ${verdict.requested}, downgraded: ${verdict.downgrade})` : ''}`,
    verdict.reason ? `Reason: ${quote(verdict.reason, 600)}` : '',
    verdict.coverage ? `Covered criteria: ${verdict.coverage.covered.join(',') || 'none'}; uncovered: ${verdict.coverage.uncovered.join(',') || 'none'}` : '',
  ].filter((line) => line !== '')
  if (objective.state === 'completed') lines.push('The objective is complete. Write the closing message: what was delivered, how it was verified, where the results are. Do not call objective tools for it again.')
  else if (objective.state === 'awaiting-human') lines.push('Approved, but judgment criteria need a human acknowledgment. Ask the human in this session (ask_user_question) to confirm each † criterion; the human records it with objective_ack. You cannot acknowledge on their behalf.')
  else if (objective.state === 'active') lines.push('The objective is active again: plan new work orders for the failing or uncovered criteria (never reopen a rejected item), or re-request verification once the fix is accepted.')
  else if (objective.state === 'blocked') lines.push(`The objective is blocked (${objective.blockedReason?.code}). Only a human can resume it (objective_control).`)
  lines.push(DUPLICATE_LINE)
  return lines.join('\n')
}

export const renderFailure = ({ objective, wake, items }) => {
  const lines = [
    header('WORKER FAILURE', objective, wake),
    `Objective: ${quote(objective.statement)} (state=${objective.state}, ${budgetLine(objective)})`,
    ...items.map((item) => `Failed item ${item.id} ${quote(item.title, 120)}: ${item.failure?.code ?? 'failed'} — ${quote(item.failure?.detail ?? '', 300)}`),
    `Consecutive worker failures: ${objective.counters?.workerFailures ?? 0}/${'{max}'}`,
    'A failed item is terminal. Diagnose whether the brief, the persona, or the task was wrong; then either add a new work order (objective_plan) for the retry or report the blocker to the human. Do not retry blindly.',
    DUPLICATE_LINE,
  ]
  return lines.join('\n')
}

export const renderAck = ({ objective, wake, verification }) => {
  const pending = objective.criteria.filter((criterion) => criterion.requiresHumanAck)
  return [
    header('ACK PENDING', objective, wake),
    `Objective: ${quote(objective.statement)} (state=${objective.state})`,
    `Verification ${verification?.id ?? '?'} approved every criterion; these need a human acknowledgment: ${pending.map((c) => `${c.id} ${quote(c.check?.prompt ?? c.statement, 160)}`).join('; ')}`,
    'Ask the human in this session to confirm (ask_user_question). The human records the decision with objective_ack {objectiveId, decision:"ack"|"send-back", note}. You cannot acknowledge for them; if nobody answers, the objective stays awaiting-human.',
    DUPLICATE_LINE,
  ].join('\n')
}

export const renderBlocked = ({ objective, wake }) => [
  header('OBJECTIVE BLOCKED', objective, wake),
  `Objective: ${quote(objective.statement)} (state=blocked, ${budgetLine(objective)})`,
  `Reason: ${objective.blockedReason?.code ?? 'unknown'} — ${quote(objective.blockedReason?.detail ?? '', 300)}`,
  'No work will be dispatched for it. Tell the human what was completed, what blocked it, and what they can do: raise the budget (objective_control budget-raise), edit the criteria, reset attempts, resume, or cancel. Do not call objective tools for it until a human acts.',
].join('\n')

export const renderEnginePaused = ({ reason }) => [
  `[OBJECTIVE ENGINE PAUSED template=${TEMPLATE_VERSION}]`,
  `The objective engine is paused (${reason}). No progress prompts will arrive and objective_dispatch is refused.`,
  'Do not call objective tools except objective_status. A human resumes the engine with objective_system {action:"resume"}; after a host restart, also call swarm_enter again before resuming work.',
].join('\n')

/** Brief wrapper for a dispatched worker child. */
export const renderWorkerBrief = ({ objective, item, persona, brief, instructions }) => [
  `[OBJECTIVE ENGINE WORK ORDER item=${item.id} objective=${objective.id} attempt=${item.attempt} persona=${persona}]`,
  instructions ? `Persona: ${instructions}` : '',
  `Objective (context only): ${quote(objective.statement)}`,
  `Work order: ${quote(item.title, 300)}`,
  item.detail ? `Detail: ${item.detail}` : '',
  `Acceptance: ${item.acceptance.map((entry, index) => `${index + 1}. ${entry}`).join(' ')}`,
  '',
  brief,
  '',
  `When done, call objective_report {objectiveId:"${objective.id}", itemId:"${item.id}", text:<what you did and how you checked it>, evidence:[{kind:"command", command, exitCode}|{kind:"artifact", path, sha256}]} (at most 3 evidence entries). Send objective_report {kind:"heartbeat"} if a long step is still running. You cannot create objectives, dispatch work, verify, or complete anything; the manager accepts your report.`,
].filter((line) => line !== undefined).join('\n')

/** Brief for the engine-started verifier child. */
export const renderVerifierBrief = ({ objective, verification, criteria, evidenceFormat }) => [
  `[OBJECTIVE ENGINE VERIFICATION verification=${verification.id} objective=${objective.id} criteriaVersion=${verification.criteriaVersion}]`,
  'You are an independent verifier. You did not produce this work and you must not fix it. Read the actual state of the workspace and run the checks yourself.',
  `Objective: ${quote(objective.statement)}`,
  verification.commit?.pinned
    ? `Pinned commit: ${verification.commit.commit}. Run \`git rev-parse HEAD\` and \`git status --porcelain\` first; if HEAD differs from the pinned commit or the workspace is dirty, report inconclusive with that reason.`
    : 'No commit is pinned for this objective (not a git workspace or pinning unavailable): verify the current workspace state and say so.',
  `Criteria to verify: ${criteria.map((c) => `${c.id}: ${quote(c.statement, 300)} [check=${c.check.kind}${c.check.command ? ` command=${quote(c.check.command, 200)} expectedExitCode=${c.check.expectedExitCode}` : ''}${c.check.path ? ` path=${c.check.path}` : ''}${c.requiresHumanAck ? ' human-ack: report your assessment; a human decides' : ''}]`).join('; ')}`,
  `Evidence format: ${evidenceFormat}`,
  `Finish with exactly one objective_verdict {verificationId:"${verification.id}", verdict:"approve"|"reject"|"inconclusive", commit:<git rev-parse HEAD or omit>, workspaceClean:true|false, reason, evidence:[…one entry per criterion…]}. Approve only when every mechanical criterion passed at the pinned commit; reject with the failing evidence; inconclusive when you could not establish either. Write nothing to source files.`,
].join('\n')

export const EVIDENCE_FORMAT =
  '{criterionId, kind:"command", command, cwd?, exitCode, stdoutExcerpt?} for command checks; {criterionId, kind:"artifact", path, sha256} for artifacts; {criterionId, kind:"inspection", note} for evidence checks; add failed:true on a failing entry.'
