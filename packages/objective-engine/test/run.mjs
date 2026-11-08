/**
 * Self-test for @local/objective-engine: the nine-condition suite (design
 * §10.4) plus lifecycle, dispatch, verification, pump, fence, classifier,
 * journal durability, and tool wiring — all against a fake Cordis context.
 */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeClock, makeCtx } from './fake-ctx.mjs'
import { baseConfig, compose, createAsHuman, humanControl, humanSystem, sleep, tempDir } from './harness.mjs'
import { readJournal } from '../lib/store.js'
import { decide as decideRule } from '../lib/classify.js'
import { TEMPLATE_VERSION } from '../lib/records.js'

const passed = []
const section = (title) => {
  passed.push(title)
  console.log(`· ${title}`)
}
const objective = (h, id) => h.engine.state.objectives.get(id)
const simpleCriteria = ['pnpm test exits 0', 'the README documents the flag']

// ---------------------------------------------------------------------------
// 1. Boot, lock, sentinel, corruption (condition 6 / 8 groundwork)
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx()
  const clock = makeClock()
  const dataDir = tempDir()
  const h = compose({ ctx, clock, dataDir })
  assert.equal(h.engine.mode, 'paused', 'boots paused')
  assert.equal(h.engine.state.engine.pausedReason, 'process-start')
  assert.ok(existsSync(join(dataDir, 'LOCK')), 'lock file written')

  // A second engine on the same directory with a live pid is refused.
  const second = compose({ ctx, clock, dataDir, pid: 1 })
  assert.equal(second.engine.mode, 'degraded', 'second instance is locked out')
  assert.match(second.engine.state.engine.pausedReason, /locked/)
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  const refused = createAsHuman(second, owner, { statement: 'x', criteria: simpleCriteria })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'engine-degraded')
  second.engine.store.close()

  // PAUSED sentinel: resume refused until removed.
  writeFileSync(join(dataDir, 'PAUSED'), '')
  const resumed = humanSystem(h, owner, { action: 'resume' })
  assert.equal(resumed.ok, false)
  assert.equal(resumed.code, 'paused-sentinel')
  h.close()
  section('boot paused, single-writer lock, PAUSED sentinel')
}

{
  // Torn tail is repaired; a corrupt middle line degrades the engine.
  const ctx = makeCtx()
  const clock = makeClock()
  const dataDir = tempDir()
  const h = compose({ ctx, clock, dataDir })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  const created = createAsHuman(h, owner, { statement: 'Persist me', criteria: simpleCriteria })
  assert.equal(created.ok, true)
  h.close()
  const journal = join(dataDir, 'journal.jsonl')
  appendFileSync(journal, '{"seq":99,"schema":"opm/v1","type":"objective/created","data":')
  const again = compose({ ctx, clock, dataDir })
  assert.equal(again.engine.mode, 'paused', 'torn tail repaired')
  assert.equal(again.engine.store.repaired, true)
  assert.equal(again.engine.state.objectives.size, 1)
  again.close()
  const lines = readFileSync(journal, 'utf8').split('\n').filter((line) => line !== '')
  lines[1] = lines[1].replace('"hash":"', '"hash":"deadbeef')
  writeFileSync(journal, `${lines.join('\n')}\n`)
  const broken = compose({ ctx, clock, dataDir })
  assert.equal(broken.engine.mode, 'degraded', 'hash mismatch refuses to serve')
  assert.match(broken.engine.state.engine.pausedReason, /hash mismatch/)
  broken.engine.store.close()
  section('torn tail repaired, hash chain enforced')
}

// ---------------------------------------------------------------------------
// 2. Condition 2 + 5: record completeness, authority, admission
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx()
  const clock = makeClock()
  const h = compose({ ctx, clock })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  humanSystem(h, owner, { action: 'resume' })

  const noCriteria = createAsHuman(h, owner, { statement: 'x', criteria: [] })
  assert.equal(noCriteria.code, 'record-incomplete')
  const badCheck = createAsHuman(h, owner, { statement: 'x', criteria: [{ statement: 'y', check: { kind: 'vibes' } }] })
  assert.equal(badCheck.code, 'record-incomplete')
  const noCommand = createAsHuman(h, owner, { statement: 'x', criteria: [{ statement: 'y', check: { kind: 'command' } }] })
  assert.equal(noCommand.code, 'record-incomplete')

  // An agent turn (no direct human message) cannot create.
  owner.engineTurn()
  const agentCreate = h.engine.create({ statement: 'Agent made', criteria: simpleCriteria }, h.actor(owner))
  assert.equal(agentCreate.ok, false)
  assert.equal(agentCreate.code, 'unauthorized')
  owner.idle()
  // A non-root session cannot create even with human-looking events.
  const child = ctx.makeAgent({ preset: 'architect', root: false })
  child.humanTurn()
  const childCreate = h.engine.create({ statement: 'Child made', criteria: simpleCriteria }, h.actor(child))
  assert.equal(childCreate.code, 'unauthorized')
  assert.ok(h.engine.state.rejections.some((entry) => entry.code === 'unauthorized'), 'rejection journaled')

  const a = createAsHuman(h, owner, { statement: 'A', criteria: simpleCriteria, scope: { paths: ['src/auth'] }, idempotencyKey: 'k1' })
  assert.equal(a.ok, true)
  assert.equal(a.objective.state, 'active')
  assert.equal(a.objective.armed, true)
  assert.equal(a.objective.criteria[0].check.kind, 'evidence')
  const replayed = createAsHuman(h, owner, { statement: 'A', criteria: simpleCriteria, scope: { paths: ['src/auth'] }, idempotencyKey: 'k1' })
  assert.equal(replayed.replayed, true, 'same key + payload replays')
  const conflict = createAsHuman(h, owner, { statement: 'A changed', criteria: simpleCriteria, idempotencyKey: 'k1' })
  assert.equal(conflict.code, 'idempotency-conflict')
  const dup = createAsHuman(h, owner, { statement: ' a ', criteria: simpleCriteria })
  assert.equal(dup.code, 'duplicate-objective')
  const overlap = createAsHuman(h, owner, { statement: 'B', criteria: simpleCriteria, scope: { paths: ['src/auth/login'] } })
  assert.equal(overlap.code, 'scope-conflict')
  const b = createAsHuman(h, owner, { statement: 'B', criteria: simpleCriteria, scope: { paths: ['docs'] } })
  assert.equal(b.objective.state, 'active')
  const c = createAsHuman(h, owner, { statement: 'C', criteria: simpleCriteria })
  assert.equal(c.objective.state, 'queued', 'third objective queues')
  const d = createAsHuman(h, owner, { statement: 'D', criteria: simpleCriteria })
  assert.equal(d.objective.state, 'queued')
  const e = createAsHuman(h, owner, { statement: 'E', criteria: simpleCriteria })
  assert.equal(e.code, 'admission-rejected', 'owner cap / queue depth rejected')

  // Cancel frees a slot and promotes the oldest queued objective.
  const cancelled = humanControl(h, owner, { objectiveId: b.objective.id, action: 'cancel', reason: 'superseded' })
  assert.equal(cancelled.ok, true)
  assert.deepEqual(cancelled.promoted, [c.objective.id])
  assert.equal(objective(h, c.objective.id).state, 'active')
  // Terminal objectives are terminal.
  const reopen = humanControl(h, owner, { objectiveId: b.objective.id, action: 'resume' })
  assert.equal(reopen.code, 'objective-terminal')
  h.close()
  section('record completeness, human authority, idempotency, admission and queue promotion')
}

{
  // allowAgentProposedObjectives: proposed, needs human approve.
  const ctx = makeCtx()
  const clock = makeClock()
  const h = compose({ ctx, clock, config: baseConfig({ allowAgentProposedObjectives: true }) })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  owner.engineTurn()
  const proposed = h.engine.create({ statement: 'Self proposed', criteria: simpleCriteria }, h.actor(owner))
  assert.equal(proposed.ok, true)
  assert.equal(proposed.objective.state, 'proposed')
  owner.idle()
  owner.engineTurn()
  const agentApprove = h.engine.control({ objectiveId: proposed.objective.id, action: 'approve' }, h.actor(owner))
  assert.equal(agentApprove.code, 'unauthorized', 'an agent cannot approve')
  owner.idle()
  const approved = humanControl(h, owner, { objectiveId: proposed.objective.id, action: 'approve' })
  assert.equal(approved.objective.state, 'active')
  h.close()
  section('agent-proposed objectives require human approval')
}

// ---------------------------------------------------------------------------
// 3. Condition 3: the completion gate, end to end with dispatch + verifier
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx({ git: { head: 'b'.repeat(40), dirty: false } })
  const clock = makeClock()
  const h = compose({ ctx, clock })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  humanSystem(h, owner, { action: 'resume' })
  const created = createAsHuman(h, owner, {
    statement: 'Ship the rate limiter',
    criteria: [
      { statement: 'tests pass', check: { kind: 'command', command: 'pnpm test', expectedExitCode: 0 } },
      { statement: 'operator approves the runbook', check: { kind: 'human-ack', prompt: 'Approve the runbook?' } },
    ],
  })
  const id = created.objective.id

  // Verification before any work order: not-ready.
  const early = await h.engine.verify({ objectiveId: id }, h.actor(owner))
  assert.equal(early.code, 'not-ready')

  // Plan: a work order must link a criterion and carry acceptance.
  const bare = h.engine.plan({ objectiveId: id, title: 'Implement limiter' }, h.actor(owner))
  assert.equal(bare.code, 'record-incomplete')
  const planned = h.engine.plan({ objectiveId: id, title: 'Implement limiter', detail: 'token bucket in auth/limiter.ts', acceptance: ['unit tests added'], criterionIds: ['c1'] }, h.actor(owner))
  assert.equal(planned.ok, true)
  assert.equal(planned.item.state, 'queued')
  const itemId = planned.item.id
  const stranger = ctx.makeAgent({ preset: 'writer' })
  const notOwner = await h.engine.dispatch({ itemId, persona: 'architect', brief: 'do it' }, h.actor(stranger))
  assert.equal(notOwner.code, 'unauthorized')

  // Dispatch starts a child with the persona as its preset.
  const dispatched = await h.engine.dispatch({ itemId, persona: 'architect', brief: 'Implement the token bucket; run pnpm test.' }, h.actor(owner))
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched))
  assert.equal(ctx.activations.length, 1)
  assert.equal(ctx.activations[0].request.agentPreset, 'architect')
  assert.equal(ctx.activations[0].request.maxDepth, 1, 'a top-level owner may start a depth-1 worker')
  assert.equal(ctx.activations[0].delivery, 'parent')
  assert.match(ctx.activations[0].request.prompt[0].text, /OBJECTIVE ENGINE WORK ORDER/)
  const childId = dispatched.childSessionId
  const child = ctx.agents.get(childId)
  const twice = await h.engine.dispatch({ itemId, persona: 'architect', brief: 'again' }, h.actor(owner))
  assert.equal(twice.code, 'item-not-queued', 'same item never re-dispatched')

  // Only the assigned child reports on the item; the owner cannot accept its own report.
  const wrongReporter = h.engine.report({ objectiveId: id, itemId, text: 'done' }, h.actor(stranger))
  assert.equal(wrongReporter.code, 'unauthorized')
  const heartbeat = h.engine.report({ objectiveId: id, itemId, kind: 'heartbeat' }, h.actor(child))
  assert.equal(heartbeat.ok, true)
  assert.equal(h.engine.state.items.get(itemId).state, 'dispatched', 'heartbeat is never progress')
  const reported = h.engine.report({ objectiveId: id, itemId, text: 'Implemented; pnpm test exit 0', evidence: [{ kind: 'command', command: 'pnpm test', exitCode: 0 }] }, h.actor(child))
  assert.equal(reported.ok, true)
  assert.equal(reported.item.state, 'reported')
  const selfAccept = h.engine.plan({ action: 'accept', itemId }, h.actor(child))
  assert.equal(selfAccept.code, 'unauthorized', 'worker cannot accept its own item')
  const accepted = h.engine.plan({ action: 'accept', itemId }, h.actor(owner))
  assert.equal(accepted.ok, true)
  assert.equal(accepted.item.state, 'accepted')
  // Settlement after the report does not change the accepted state.
  ctx.activations[0].settle('completed', [{ type: 'text', text: 'done' }])
  assert.equal(h.engine.state.items.get(itemId).state, 'accepted')

  // Request verification: the engine pins the commit and starts the verifier child.
  const verifyReq = await h.engine.verify({ objectiveId: id }, h.actor(owner))
  assert.equal(verifyReq.ok, true, JSON.stringify(verifyReq))
  assert.equal(objective(h, id).state, 'verifying')
  assert.equal(verifyReq.verification.commit.commit, 'b'.repeat(40))
  assert.equal(verifyReq.verification.commit.pinned, true)
  assert.equal(ctx.activations.length, 2)
  assert.equal(ctx.activations[1].request.agentPreset, 'verifier')
  assert.match(ctx.activations[1].request.prompt[0].text, /OBJECTIVE ENGINE VERIFICATION/)
  const verifier = ctx.agents.get(verifyReq.verifierSessionId)
  const verificationId = verifyReq.verification.id
  const evidence = [{ criterionId: 'c1', kind: 'command', command: 'pnpm test', exitCode: 0 }]

  // Producer, worker, and an unrelated session cannot verdict.
  const ownerVerdict = h.engine.verdict({ verificationId, verdict: 'approve', evidence, commit: 'b'.repeat(40), workspaceClean: true }, h.actor(owner))
  assert.equal(ownerVerdict.code, 'unauthorized')
  const workerVerdict = h.engine.verdict({ verificationId, verdict: 'approve', evidence, commit: 'b'.repeat(40), workspaceClean: true }, h.actor(child))
  assert.equal(workerVerdict.code, 'unauthorized')
  const otherVerdict = h.engine.verdict({ verificationId, verdict: 'approve', evidence, commit: 'b'.repeat(40), workspaceClean: true }, h.actor(stranger))
  assert.equal(otherVerdict.code, 'unauthorized')
  // Completion by the owner through any path is impossible: no tool exists; control cannot complete.
  const noComplete = humanControl(h, owner, { objectiveId: id, action: 'complete' })
  assert.equal(noComplete.code, 'action-invalid')

  // Wrong commit → inconclusive, objective back to active.
  const wrong = h.engine.verdict({ verificationId, verdict: 'approve', evidence, commit: 'c'.repeat(40), workspaceClean: true }, h.actor(verifier))
  assert.equal(wrong.ok, true)
  assert.equal(wrong.verification.verdict.kind, 'inconclusive')
  assert.equal(wrong.verification.verdict.downgrade, 'wrong-commit')
  assert.equal(objective(h, id).state, 'active')

  // Second request: dirty workspace → inconclusive → blocked verification-failed (limit 2).
  const req2 = await h.engine.verify({ objectiveId: id }, h.actor(owner))
  assert.equal(req2.ok, true)
  const ver2 = ctx.agents.get(req2.verifierSessionId)
  const dirty = h.engine.verdict({ verificationId: req2.verification.id, verdict: 'approve', evidence, commit: 'b'.repeat(40), workspaceClean: false }, h.actor(ver2))
  assert.equal(dirty.verification.verdict.downgrade, 'dirty-workspace')
  assert.equal(objective(h, id).state, 'blocked')
  assert.equal(objective(h, id).blockedReason.code, 'verification-failed')
  const resumeBlocked = humanControl(h, owner, { objectiveId: id, action: 'resume' })
  assert.equal(resumeBlocked.code, 'verification-failed', 'blocked verification needs a human edit/reset')
  const reset = humanControl(h, owner, { objectiveId: id, action: 'reset-attempts' })
  assert.equal(reset.ok, true)
  const resumed = humanControl(h, owner, { objectiveId: id, action: 'resume' })
  assert.equal(resumed.ok, true)
  assert.equal(objective(h, id).state, 'active')

  // Third request: approve with full evidence → awaiting-human (judgment criterion).
  const req3 = await h.engine.verify({ objectiveId: id }, h.actor(owner))
  assert.equal(req3.ok, true, JSON.stringify(req3))
  const ver3 = ctx.agents.get(req3.verifierSessionId)
  const missing = h.engine.verdict({ verificationId: req3.verification.id, verdict: 'approve', evidence: [], commit: 'b'.repeat(40), workspaceClean: true }, h.actor(ver3))
  assert.match(missing.verification.verdict.downgrade, /missing-evidence/)
  const req4 = await h.engine.verify({ objectiveId: id }, h.actor(owner))
  assert.equal(req4.ok, true, JSON.stringify(req4))
  const ver4 = ctx.agents.get(req4.verifierSessionId)
  const approved = h.engine.verdict({ verificationId: req4.verification.id, verdict: 'approve', reason: 'all green', evidence, commit: 'b'.repeat(40), workspaceClean: true }, h.actor(ver4))
  assert.equal(approved.ok, true, JSON.stringify(approved))
  assert.equal(approved.verification.verdict.kind, 'approve')
  assert.equal(objective(h, id).state, 'awaiting-human')

  // Ack: only a human in a root turn; the manager cannot.
  owner.engineTurn()
  const agentAck = h.engine.ack({ objectiveId: id, decision: 'ack' }, h.actor(owner))
  assert.equal(agentAck.code, 'unauthorized')
  owner.idle()
  owner.humanTurn('approved')
  const acked = h.engine.ack({ objectiveId: id, decision: 'ack', note: 'runbook approved' }, h.actor(owner))
  owner.idle()
  assert.equal(acked.ok, true, JSON.stringify(acked))
  assert.equal(objective(h, id).state, 'completed')
  assert.equal(objective(h, id).completion.verificationId, req4.verification.id)
  assert.equal(h.engine.state.verifications.get(req4.verification.id).state, 'acked')
  h.close()
  section('completion gate: dispatch provenance, producer rejection, commit pinning, evidence coverage, human ack')
}

{
  // O6b: a purely mechanical objective completes on approve; send-back pauses; verifier death → inconclusive.
  const ctx = makeCtx()
  const clock = makeClock()
  const h = compose({ ctx, clock })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  humanSystem(h, owner, { action: 'resume' })
  const mech = createAsHuman(h, owner, { statement: 'Mechanical', criteria: [{ statement: 'build passes', check: { kind: 'command', command: 'make', expectedExitCode: 0 } }] })
  const req = await h.engine.verify({ objectiveId: mech.objective.id, force: true }, h.actor(owner))
  assert.equal(req.ok, true)
  // Verifier dies without a verdict → inconclusive, back to active.
  ctx.activations[0].settle('error')
  assert.equal(h.engine.state.verifications.get(req.verification.id).state, 'inconclusive')
  assert.equal(objective(h, mech.objective.id).state, 'active')
  const req2 = await h.engine.verify({ objectiveId: mech.objective.id, force: true }, h.actor(owner))
  const ver = ctx.agents.get(req2.verifierSessionId)
  const done = h.engine.verdict({ verificationId: req2.verification.id, verdict: 'approve', evidence: [{ criterionId: 'c1', kind: 'command', command: 'make', exitCode: 0 }], commit: 'a'.repeat(40), workspaceClean: true }, h.actor(ver))
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(objective(h, mech.objective.id).state, 'completed', 'mechanical objective completes without an ack')

  const judged = createAsHuman(h, owner, { statement: 'Judged', criteria: [{ statement: 'doc reads well', check: { kind: 'human-ack' } }] })
  const req3 = await h.engine.verify({ objectiveId: judged.objective.id, force: true }, h.actor(owner))
  const ver3 = ctx.agents.get(req3.verifierSessionId)
  h.engine.verdict({ verificationId: req3.verification.id, verdict: 'approve', evidence: [{ criterionId: 'c1', kind: 'inspection', note: 'read it' }], commit: 'a'.repeat(40), workspaceClean: true }, h.actor(ver3))
  assert.equal(objective(h, judged.objective.id).state, 'awaiting-human')
  owner.humanTurn('no')
  const back = h.engine.ack({ objectiveId: judged.objective.id, decision: 'send-back', note: 'tone is off' }, h.actor(owner))
  owner.idle()
  assert.equal(back.ok, true)
  assert.equal(objective(h, judged.objective.id).state, 'paused')
  assert.equal(h.engine.state.verifications.get(req3.verification.id).state, 'superseded')
  // A criteria edit supersedes verifications and bumps the version; a stale verdict cannot complete.
  const resumed = humanControl(h, owner, { objectiveId: judged.objective.id, action: 'resume' })
  assert.equal(resumed.ok, true)
  const req4 = await h.engine.verify({ objectiveId: judged.objective.id, force: true }, h.actor(owner))
  const edited = humanControl(h, owner, { objectiveId: judged.objective.id, action: 'edit', criteria: ['doc reads well', 'has examples'] })
  assert.equal(edited.ok, true)
  assert.equal(objective(h, judged.objective.id).criteriaVersion, 2)
  assert.equal(objective(h, judged.objective.id).state, 'paused')
  assert.ok(edited.supersededVerifications.includes(req4.verification.id))
  const stale = h.engine.verdict({ verificationId: req4.verification.id, verdict: 'approve', evidence: [], commit: 'a'.repeat(40), workspaceClean: true }, h.actor(ctx.agents.get(req4.verifierSessionId)))
  assert.equal(stale.code, 'verification-closed', 'a superseded record accepts no verdict')
  h.close()
  section('mechanical completion (O6b), send-back, verifier death, criteria edit supersedes verification')
}

// ---------------------------------------------------------------------------
// 4. Condition 4: budgets block and are never retried
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx()
  const clock = makeClock()
  const h = compose({ ctx, clock, config: baseConfig({ maxRoundsPerObjective: 2, maxItemsPerObjective: 2, maxWallTimePerObjective: 10_000 }) })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  humanSystem(h, owner, { action: 'resume' })
  const a = createAsHuman(h, owner, { statement: 'Budgeted', criteria: simpleCriteria })
  assert.equal(h.engine.spendRound(a.objective.id).budget.rounds.used, 1)
  assert.equal(h.engine.spendRound(a.objective.id).budget.rounds.used, 2)
  assert.equal(h.engine.spendRound(a.objective.id), undefined, 'no round beyond the budget')
  assert.equal(objective(h, a.objective.id).state, 'blocked')
  assert.equal(objective(h, a.objective.id).blockedReason.code, 'budget-exhausted')
  h.pump.tick()
  assert.equal(objective(h, a.objective.id).state, 'blocked', 'no timer path resumes it')
  const resume = humanControl(h, owner, { objectiveId: a.objective.id, action: 'resume' })
  assert.equal(resume.code, 'budget-exhausted')
  const raised = humanControl(h, owner, { objectiveId: a.objective.id, action: 'budget-raise', budget: { rounds: 6 } })
  assert.equal(raised.ok, true)
  assert.equal(humanControl(h, owner, { objectiveId: a.objective.id, action: 'resume' }).ok, true)

  // Items budget.
  const b = createAsHuman(h, owner, { statement: 'Items', criteria: simpleCriteria })
  for (let index = 0; index < 2; index += 1) assert.equal(h.engine.plan({ objectiveId: b.objective.id, title: `w${index}`, acceptance: ['x'], criterionIds: ['c1'] }, h.actor(owner)).ok, true)
  const third = h.engine.plan({ objectiveId: b.objective.id, title: 'w3', acceptance: ['x'], criterionIds: ['c1'] }, h.actor(owner))
  assert.equal(third.code, 'budget-exhausted')
  // Wall time via the sweep.
  clock.advance(20_000)
  h.engine.sweep()
  assert.equal(objective(h, b.objective.id).state, 'blocked')
  assert.equal(objective(h, b.objective.id).blockedReason.detail, 'wallTimeMs')
  h.close()
  section('budgets: rounds, items, wall time block with budget-exhausted and need a human raise')
}

// ---------------------------------------------------------------------------
// 5. Condition 6: restart reconstruction and replay determinism
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx()
  const clock = makeClock()
  const dataDir = tempDir()
  const h = compose({ ctx, clock, dataDir })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  humanSystem(h, owner, { action: 'resume' })
  const a = createAsHuman(h, owner, { statement: 'Survive restart', criteria: simpleCriteria })
  const planned = h.engine.plan({ objectiveId: a.objective.id, title: 'w', acceptance: ['x'], criterionIds: ['c1'] }, h.actor(owner))
  await h.engine.dispatch({ itemId: planned.item.id, persona: 'architect', brief: 'go' }, h.actor(owner))
  const b = createAsHuman(h, owner, { statement: 'Verifying at restart', criteria: simpleCriteria })
  await h.engine.verify({ objectiveId: b.objective.id, force: true }, h.actor(owner))
  const hashBefore = h.engine.store.lastHash
  h.close()

  const again = compose({ ctx, clock, dataDir })
  assert.equal(again.engine.mode, 'paused')
  assert.equal(again.engine.bootChanges.failedItems, 1)
  assert.equal(again.engine.bootChanges.pausedObjectives, 2)
  assert.equal(again.engine.bootChanges.inconclusiveVerifications, 1)
  assert.equal(again.engine.state.items.get(planned.item.id).state, 'failed')
  assert.equal(again.engine.state.items.get(planned.item.id).failure.code, 'process-restart')
  assert.equal(objective(again, a.objective.id).state, 'paused')
  assert.equal(objective(again, a.objective.id).armed, false)
  assert.ok(again.engine.store.lastSeq > 0)
  // Nothing wakes at boot; a human resume with resumeAll re-arms both.
  const agent = ctx.agents.get(owner.id)
  agent.idle()
  await sleep(50)
  assert.equal(agent.followups.length, 0, 'no prompt at boot')
  const resumed = humanSystem(again, owner, { action: 'resume', resumeAll: true })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.rearmed.length, 2)
  assert.equal(objective(again, a.objective.id).state, 'active')
  again.close()

  // Replay determinism: folding the journal twice yields the same chain hash and state digest.
  const first = readJournal(join(dataDir, 'journal.jsonl'))
  const second = readJournal(join(dataDir, 'journal.jsonl'))
  assert.equal(first.corrupt, undefined)
  assert.equal(first.lastHash, second.lastHash)
  assert.ok(first.events.some((event) => event.hash === hashBefore), 'pre-restart hash is in the chain')
  // Snapshot roundtrip: a snapshot plus the tail reconstructs the same objectives.
  const third = compose({ ctx, clock, dataDir })
  third.engine.snapshotNow()
  third.close()
  const fourth = compose({ ctx, clock, dataDir })
  assert.equal(fourth.engine.store.snapshotUsed, true, 'snapshot loaded')
  assert.equal(fourth.engine.state.objectives.size, 2)
  fourth.close()
  section('restart: items failed, objectives paused and disarmed, no boot wake, replay and snapshot deterministic')
}

// ---------------------------------------------------------------------------
// 6. Condition 7: event-driven wakeups, the fence, coalescing
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx()
  const clock = makeClock()
  const h = compose({ ctx, clock, config: baseConfig({ maxRoundsPerObjective: 3 }) })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  const a = createAsHuman(h, owner, { statement: 'Drive me', criteria: simpleCriteria })
  owner.idle()
  await sleep(60)
  assert.equal(owner.followups.length, 0, 'paused engine sends nothing')
  humanSystem(h, owner, { action: 'resume' })
  owner.idle()
  await sleep(200)
  assert.equal(owner.followups.length, 1, 'one plan wakeup after resume')
  const first = owner.followups[0]
  assert.equal(first.source.kind, 'objective-engine')
  assert.equal(first.source.form, 'plan')
  assert.match(first.content[0].text, new RegExp(`template=${TEMPLATE_VERSION} wake=${first.source.wakeId}`))
  owner.idle()
  await sleep(100)
  assert.equal(owner.followups.length, 1, 'never queued twice while a wakeup is reserved')
  assert.equal(objective(h, a.objective.id).budget.rounds.used, 0, 'reservation spends nothing')

  // The fence admits the prompt and consumes one round.
  const decision = await ctx.preStep({ agent: owner, messages: [{ id: 'm1', source: first.source, content: first.content }] })
  assert.equal(decision.kind, 'enter')
  assert.equal(h.engine.state.wakes.get(first.source.wakeId).state, 'admitted')
  assert.equal(objective(h, a.objective.id).budget.rounds.used, 1, 'admission consumes a round')
  const duplicate = await ctx.preStep({ agent: owner, messages: [{ id: 'm1b', source: first.source, content: first.content }] })
  assert.equal(duplicate.kind, 'reject', 'a duplicate delivery is rejected')

  // A stale prompt (objective state changed) is rejected and expired; a human message wins.
  clock.advance(120_000)
  owner.idle()
  await sleep(100)
  assert.equal(owner.followups.length, 2, 'timer-due plan prompt')
  const second = owner.followups[1]
  humanControl(h, owner, { objectiveId: a.objective.id, action: 'pause' })
  const stale = await ctx.preStep({ agent: owner, messages: [{ id: 'm2', source: second.source, content: second.content }] })
  assert.equal(stale.kind, 'reject')
  assert.equal(h.engine.state.wakes.get(second.source.wakeId).state, 'expired')
  assert.equal(objective(h, a.objective.id).budget.rounds.used, 1, 'a rejected prompt spends nothing')
  humanControl(h, owner, { objectiveId: a.objective.id, action: 'resume' })
  clock.advance(120_000)
  owner.idle()
  await sleep(100)
  const third = owner.followups[2]
  const human = await ctx.preStep({ agent: owner, messages: [{ id: 'h1', source: { kind: 'user' }, content: [] }, { id: 'm3', source: third.source, content: third.content }] })
  assert.equal(human.kind, 'enter', 'human messages always win')
  assert.equal(h.engine.state.wakes.get(third.source.wakeId).state, 'superseded')

  // Nothing actionable → no prompt: paused objective, idle edges, timer.
  humanControl(h, owner, { objectiveId: a.objective.id, action: 'pause' })
  const count = owner.followups.length
  clock.advance(600_000)
  owner.idle()
  h.pump.tick()
  await sleep(100)
  assert.equal(owner.followups.length, count, 'no wakeup without an actionable objective')
  h.close()
  section('wakeups: one per idle edge, rounds consumed at admission, duplicate/stale rejected, human supersedes, zero idle spend')
}

{
  // Work prompt and child-end coalescing; failure notice; blocked notice once; backpressure.
  const ctx = makeCtx()
  const clock = makeClock()
  const h = compose({ ctx, clock, config: baseConfig({ maxInFlightItemsGlobal: 1, maxConsecutiveWorkerFailures: 2 }) })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  humanSystem(h, owner, { action: 'resume' })
  const a = createAsHuman(h, owner, { statement: 'Coalesce', criteria: simpleCriteria })
  owner.status = 'running'
  const w1 = h.engine.plan({ objectiveId: a.objective.id, title: 'w1', acceptance: ['x'], criterionIds: ['c1'] }, h.actor(owner))
  const w2 = h.engine.plan({ objectiveId: a.objective.id, title: 'w2', acceptance: ['x'], criterionIds: ['c2'] }, h.actor(owner))
  await h.engine.dispatch({ itemId: w1.item.id, persona: 'architect', brief: 'go' }, h.actor(owner))
  const busy = await h.engine.dispatch({ itemId: w2.item.id, persona: 'writer', brief: 'go' }, h.actor(owner))
  assert.equal(busy.code, 'admission-busy', 'global in-flight cap')
  assert.ok(busy.retryAfterMs > 0)
  clock.advance(1000)
  owner.idle()
  await sleep(100)
  assert.equal(owner.followups.length, 0, 'backpressure: no work wakeup while in flight is at the cap')
  // Two children settle in a burst: one wakeup.
  ctx.activations[0].settle('completed', [{ type: 'text', text: 'w1 done' }])
  await sleep(50)
  assert.equal(h.engine.state.items.get(w1.item.id).state, 'reported')
  clock.advance(1000)
  owner.idle()
  await sleep(600)
  assert.equal(owner.followups.length, 1, 'one wakeup for the settlement burst')
  assert.equal(owner.followups[0].source.form, 'work')
  assert.match(owner.followups[0].content[0].text, /awaiting your acceptance/)
  await ctx.preStep({ agent: owner, messages: [{ id: 'x', source: owner.followups[0].source, content: owner.followups[0].content }] })
  // Failure: a child error fails the item and a failure notice is sent once; two failures block.
  h.engine.plan({ action: 'accept', itemId: w1.item.id, acceptWithoutEvidence: true }, h.actor(owner))
  const d2 = await h.engine.dispatch({ itemId: w2.item.id, persona: 'writer', brief: 'go' }, h.actor(owner))
  assert.equal(d2.ok, true)
  ctx.activations[1].settle('max-tokens')
  assert.equal(h.engine.state.items.get(w2.item.id).state, 'failed')
  clock.advance(1000)
  owner.idle()
  await sleep(600)
  assert.equal(owner.followups[1].source.form, 'failure')
  await ctx.preStep({ agent: owner, messages: [{ id: 'y', source: owner.followups[1].source, content: owner.followups[1].content }] })
  const w3 = h.engine.plan({ objectiveId: a.objective.id, title: 'w3', acceptance: ['x'], criterionIds: ['c2'] }, h.actor(owner))
  await h.engine.dispatch({ itemId: w3.item.id, persona: 'writer', brief: 'go' }, h.actor(owner))
  ctx.activations[2].settle('error')
  assert.equal(objective(h, a.objective.id).state, 'blocked')
  assert.equal(objective(h, a.objective.id).blockedReason.code, 'worker-failures')
  clock.advance(1000)
  owner.idle()
  await sleep(600)
  assert.equal(owner.followups[2].source.form, 'blocked')
  clock.advance(1000)
  owner.idle()
  await sleep(300)
  assert.equal(owner.followups.length, 3, 'blocked notice is sent once')
  h.close()
  section('work wakeups coalesce child settlements, backpressure holds dispatch, failures notify once and block')
}

// ---------------------------------------------------------------------------
// 7. Condition 8: kill switch
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx()
  const clock = makeClock()
  const dataDir = tempDir()
  const h = compose({ ctx, clock, dataDir })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  humanSystem(h, owner, { action: 'resume' })
  const a = createAsHuman(h, owner, { statement: 'Kill me', criteria: simpleCriteria })
  const w = h.engine.plan({ objectiveId: a.objective.id, title: 'w', acceptance: ['x'], criterionIds: ['c1'] }, h.actor(owner))
  await h.engine.dispatch({ itemId: w.item.id, persona: 'architect', brief: 'go' }, h.actor(owner))
  const wake = h.engine.reserveWake({ objectiveId: a.objective.id, sessionId: owner.id, form: 'plan', revision: 1, objectiveState: 'active' })
  const paused = humanSystem(h, owner, { action: 'pause', reason: 'operator stop' })
  assert.equal(paused.ok, true)
  assert.equal(paused.cancelledChildren, 1)
  assert.equal(ctx.activations[0].disposed, true, 'child activation disposed with the hook cause')
  assert.equal(h.engine.state.wakes.get(wake.id).state, 'expired')
  assert.equal(h.engine.state.items.get(w.item.id).state, 'cancelled')
  assert.equal(objective(h, a.objective.id).armed, false)
  const refused = await h.engine.dispatch({ itemId: w.item.id, persona: 'architect', brief: 'go' }, h.actor(owner))
  assert.equal(refused.ok, false)
  h.close()
  const again = compose({ ctx, clock, dataDir })
  assert.equal(again.engine.mode, 'paused', 'pause survives restart')
  again.close()
  section('kill switch: one command pauses, cancels children, expires wakeups, survives restart')
}

// ---------------------------------------------------------------------------
// 8. Conditions 1 and 9: advisory classifier, outage policy, replay paradox
// ---------------------------------------------------------------------------
{
  const answers = { ok: true, answers: { message_type: { choice: 'new_objective', probabilities: { new_objective: 0.81, progress: 0.12 }, confidence: 0.7 }, is_objective: { noul: 0.77 } }, model: 'decision-model' }
  let mode = 'ok'
  let calls = 0
  const decide = async (state, questions) => {
    calls += 1
    assert.ok(questions.message_type && questions.is_objective)
    assert.equal(state.channel, 'human-message')
    if (mode === 'down') return { ok: false, error: 'connect ECONNREFUSED' }
    if (mode === 'progress') return { ok: true, answers: { message_type: { choice: 'progress', probabilities: { progress: 0.9 } }, is_objective: 0.2 }, model: 'decision-model' }
    return answers
  }
  const ctx = makeCtx()
  const clock = makeClock()
  const dataDir = tempDir()
  const h = compose({ ctx, clock, dataDir, decide, config: baseConfig({ classificationCallsPerHour: 12, classification: { breakerFailures: 2, breakerCooldownMs: 1000 } }) })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  humanSystem(h, owner, { action: 'resume' })
  const a = createAsHuman(h, owner, { statement: 'Existing', criteria: simpleCriteria })
  const hashBefore = h.engine.store.lastHash
  const seqBefore = h.engine.store.lastSeq

  const proposal = await h.classifier.classify({ sessionId: owner.id, text: 'Ship a billing export feature' })
  assert.equal(proposal.ok, true)
  assert.equal(proposal.proposal.kind, 'new_objective')
  assert.equal(proposal.model, 'decision-model')
  assert.equal(h.engine.state.objectives.size, 1, 'a proposal creates nothing')
  assert.equal(h.engine.store.lastSeq, seqBefore, 'no command event was appended')
  assert.equal(h.engine.store.lastHash, hashBefore, 'command chain untouched')
  assert.equal(h.engine.store.readAdvisory(5).length, 1, 'proposal journaled in the advisory table')
  assert.equal(h.engine.store.readAdvisory(5)[0].applied, false)

  mode = 'progress'
  const attach = await h.classifier.classify({ sessionId: owner.id, text: 'add the retry path', objectiveId: a.objective.id })
  assert.equal(attach.proposal.kind, 'attach')
  assert.equal(attach.proposal.targetObjectiveId, a.objective.id)
  assert.equal(objective(h, a.objective.id).revision, 1, 'attach proposal mutates nothing')
  // Hysteresis: the same message classified twice with different answers → ambiguous; a third call is refused.
  mode = 'ok'
  const again = await h.classifier.classify({ sessionId: owner.id, text: 'add the retry path', objectiveId: a.objective.id })
  assert.equal(again.proposal.kind, 'ambiguous')
  const third = await h.classifier.classify({ sessionId: owner.id, text: 'add the retry path', objectiveId: a.objective.id })
  assert.equal(third.code, 'classifier-hysteresis')

  // Auto-tagging on pre-step is advisory and never changes state.
  const callsBefore = calls
  await ctx.preStep({ agent: owner, messages: [{ id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'please also add login' }] }] })
  await sleep(30)
  assert.equal(calls, callsBefore + 1, 'incoming human message tagged once')
  await ctx.preStep({ agent: owner, messages: [{ id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'please also add login' }] }] })
  await sleep(30)
  assert.equal(calls, callsBefore + 1, 'same message id not re-tagged')
  assert.equal(h.engine.state.objectives.size, 1)

  // Outage: deterministic tools keep working; the breaker opens after two failures; recovery after cooldown.
  mode = 'down'
  const down = await h.classifier.classify({ sessionId: owner.id, text: 'something new entirely' })
  assert.equal(down.code, 'classifier-unavailable')
  const down2 = await h.classifier.classify({ sessionId: owner.id, text: 'another new thing' })
  assert.equal(down2.code, 'classifier-unavailable')
  const open = await h.classifier.classify({ sessionId: owner.id, text: 'yet another' })
  assert.equal(open.code, 'classifier-circuit-open')
  assert.equal(h.classifier.status().breaker.state, 'open')
  const planned = h.engine.plan({ objectiveId: a.objective.id, title: 'still works', acceptance: ['x'], criterionIds: ['c1'] }, h.actor(owner))
  assert.equal(planned.ok, true, 'deterministic path unaffected by the outage')
  clock.advance(2000)
  mode = 'ok'
  const recovered = await h.classifier.classify({ sessionId: owner.id, text: 'after cooldown' })
  assert.equal(recovered.ok, true)
  // Rate limit (12 per hour): the calls past the cap are refused without a model call.
  const before = calls
  let limited
  for (let index = 0; index < 8; index += 1) limited = await h.classifier.classify({ sessionId: owner.id, text: `msg ${index}` })
  assert.equal(limited.code, 'classifier-rate-limited')
  assert.ok(calls - before < 8, 'refused calls never reach the model')
  h.close()

  // Replay paradox: rewrite the advisory file with contradictory answers; the command fold is identical.
  const journalHash = readJournal(join(dataDir, 'journal.jsonl')).lastHash
  writeFileSync(join(dataDir, 'advisory.jsonl'), '{"schema":"opm/v1","kind":"advisory","applied":false,"proposal":{"kind":"attach","targetObjectiveId":"obj-forged"}}\n{"schema":"opm/v1","type":"objective/created","data":{"objective":{"id":"obj-forged"}}}\n')
  const replayed = compose({ ctx, clock, dataDir })
  assert.equal(replayed.engine.state.objectives.size, 1, 'forged proposals cannot synthesize a record')
  assert.equal(replayed.engine.state.objectives.has('obj-forged'), false)
  assert.equal(readJournal(join(dataDir, 'journal.jsonl')).events.filter((event) => event.type !== 'engine/started' && event.seq <= replayed.engine.store.lastSeq && event.hash === journalHash).length, 1, 'command chain unchanged by advisory rewrites')
  replayed.close()
  // Import scan: the transition path never imports the classifier, and the classifier cannot append.
  const transitionSource = readFileSync(new URL('../lib/transition.js', import.meta.url), 'utf8')
  const classifySource = readFileSync(new URL('../lib/classify.js', import.meta.url), 'utf8')
  assert.doesNotMatch(transitionSource, /classify\.js/)
  assert.doesNotMatch(classifySource, /store\.js|transition\.js|\.append\(/)
  section('classifier is advisory: journaled, never applied, outage/breaker/rate limit, replay paradox, import scan')
}

{
  // The decision rule table (design §3.2).
  const t = { objectiveProbability: 0.7, progressProbability: 0.6, choiceFloor: 0.35, confidenceFloor: 0.3, margin: 0.1 }
  assert.equal(decideRule({ messageType: 'new_objective', typeProbability: 0.8, secondProbability: 0.1, isObjective: 0.75, knownIds: [] }, t).kind, 'new_objective')
  assert.equal(decideRule({ messageType: 'progress', typeProbability: 0.8, isObjective: 0.2, target: 'o1', knownIds: ['o1'] }, t).kind, 'attach')
  assert.equal(decideRule({ messageType: 'not_work', typeProbability: 0.9, isObjective: 0.1, knownIds: [] }, t).kind, 'not_work')
  assert.equal(decideRule({ messageType: 'new_objective', typeProbability: 0.8, isObjective: 0.5, knownIds: [] }, t).kind, 'ambiguous')
  assert.equal(decideRule({ messageType: 'progress', typeProbability: 0.3, isObjective: 0.2, knownIds: ['o1'] }, t).kind, 'ambiguous')
  assert.equal(decideRule({ messageType: 'new_objective', typeProbability: 0.5, secondProbability: 0.45, isObjective: 0.9, knownIds: [] }, t).kind, 'ambiguous')
  assert.equal(decideRule({ messageType: 'none_fit', knownIds: [] }, t).kind, 'none_fit')
  assert.equal(decideRule({ messageType: undefined, knownIds: [] }, t).kind, 'none_fit', 'absent answer never defaults to new_objective')
  section('decision rule table')
}

// ---------------------------------------------------------------------------
// 9. Fallback paths and tools
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx()
  delete ctx.services.subagents
  delete ctx.services.subprocess
  const clock = makeClock()
  const h = compose({ ctx, clock })
  const owner = ctx.makeAgent({ preset: 'orchestrator' })
  humanSystem(h, owner, { action: 'resume' })
  const a = createAsHuman(h, owner, { statement: 'Fallback', criteria: simpleCriteria })
  const w = h.engine.plan({ objectiveId: a.objective.id, title: 'w', acceptance: ['x'], criterionIds: ['c1'] }, h.actor(owner))
  const unavailable = await h.engine.dispatch({ itemId: w.item.id, persona: 'architect', brief: 'go' }, h.actor(owner))
  assert.equal(unavailable.code, 'dispatch-unavailable')
  const external = await h.engine.dispatch({ itemId: w.item.id, persona: 'architect', brief: 'go', external: true }, h.actor(owner))
  assert.equal(external.fallback, true)
  const child = ctx.makeAgent({ preset: 'architect', root: false })
  const unbound = h.engine.report({ objectiveId: a.objective.id, itemId: w.item.id, text: 'done' }, h.actor(child))
  assert.equal(unbound.code, 'unauthorized')
  const bound = h.engine.report({ objectiveId: a.objective.id, itemId: w.item.id, childSessionId: child.id }, h.actor(owner))
  assert.equal(bound.ok, true)
  assert.equal(h.engine.report({ objectiveId: a.objective.id, itemId: w.item.id, text: 'done', evidence: [{ kind: 'command', command: 'make', exitCode: 0 }] }, h.actor(child)).ok, true)
  h.engine.plan({ action: 'accept', itemId: w.item.id }, h.actor(owner))
  const req = await h.engine.verify({ objectiveId: a.objective.id }, h.actor(owner))
  assert.equal(req.ok, true)
  assert.equal(req.verification.verifier.kind, 'external')
  assert.equal(req.verification.commit.pinned, false)
  // External verifier: same preset as the producer is refused; a reviewer session is accepted.
  const samePreset = ctx.makeAgent({ preset: 'orchestrator' })
  assert.equal(h.engine.verdict({ verificationId: req.verification.id, verdict: 'approve', evidence: [{ criterionId: 'c1', kind: 'inspection' }, { criterionId: 'c2', kind: 'inspection' }] }, h.actor(samePreset)).code, 'unauthorized')
  const reviewer = ctx.makeAgent({ preset: 'reviewer' })
  const verdict = h.engine.verdict({ verificationId: req.verification.id, verdict: 'approve', evidence: [{ criterionId: 'c1', kind: 'inspection' }, { criterionId: 'c2', kind: 'inspection' }] }, h.actor(reviewer))
  assert.equal(verdict.ok, true, JSON.stringify(verdict))
  assert.equal(objective(h, a.objective.id).state, 'completed')
  h.close()
  section('fallback dispatch and external verifier when host services are absent')
}

{
  const ctx = makeCtx({ systemone: { decide: async () => ({ ok: true, answers: { message_type: 'not_work', is_objective: 0.05 }, model: 'm' }) } })
  const clock = makeClock()
  const h = compose({ ctx, clock })
  const names = h.tools.map((definition) => definition.name)
  assert.deepEqual(names, [
    'objective_create',
    'objective_status',
    'objective_plan',
    'objective_dispatch',
    'objective_report',
    'objective_verify',
    'objective_verdict',
    'objective_ack',
    'objective_control',
    'objective_system',
    'objective_classify',
  ])
  for (const definition of h.tools) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.parameters.type, 'object')
  }
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  const byName = (name) => h.tools.find((definition) => definition.name === name)
  owner.humanTurn()
  const resumed = await byName('objective_system').execute({ action: 'resume' }, h.exec(owner))
  assert.equal(resumed.ok, true)
  assert.equal(resumed.engine.mode, 'running')
  const created = await byName('objective_create').execute({ statement: 'Via tools', criteria: simpleCriteria }, h.exec(owner))
  owner.idle()
  assert.equal(created.ok, true)
  const status = await byName('objective_status').execute({}, h.exec(owner))
  assert.equal(status.ok, true)
  assert.equal(status.objectives.length, 1)
  assert.equal(status.engine.counts.active, 1)
  assert.equal(status.engine.classifier.available, true)
  const classified = await byName('objective_classify').execute({ text: 'how is the weather' }, h.exec(owner))
  assert.equal(classified.proposal.kind, 'not_work')
  const rendered = byName('objective_status').output.render({}, status)
  assert.equal(rendered[0].type, 'text')
  // When the real registry library is resolvable (the systemone package has it
  // installed), every parameter schema must pass its JSON-schema validator.
  let validator
  for (const candidate of ['../../dsh-systemone/node_modules/@deepseek-ai/dsh-tools/lib/index.js']) {
    try {
      validator = await import(new URL(candidate, import.meta.url))
      break
    } catch {
      validator = undefined
    }
  }
  if (validator?.assertSupportedJsonSchema !== undefined) {
    for (const definition of h.tools) {
      validator.assertSupportedJsonSchema(definition.parameters)
      validator.assertSupportedJsonSchema(definition.output.schema)
    }
    console.log('  (parameter schemas validated with @deepseek-ai/dsh-tools)')
  }
  h.close()
  section('eleven tools registered and callable through the fake execution context')
}

// ---------------------------------------------------------------------------
// 10. Regression: the child-depth cap is absolute, not relative
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx()
  const clock = makeClock()
  const h = compose({ ctx, clock })
  const owner = ctx.makeAgent({ preset: 'objective-manager' })
  // A nested orchestrator owner is itself at delegation depth 1.
  owner.session.header.delegationDepth = 1
  humanSystem(h, owner, { action: 'resume' })
  const created = createAsHuman(h, owner, {
    statement: 'Nested orchestrator dispatch',
    criteria: [simpleCriteria[0]],
  })
  const planned = h.engine.plan(
    { objectiveId: created.objective.id, title: 'Nested item', detail: 'no-op', acceptance: ['reported'], criterionIds: ['c1'] },
    h.actor(owner),
  )
  assert.equal(planned.ok, true)
  await h.engine.dispatch({ itemId: planned.item.id, persona: 'architect', brief: 'nested' }, h.actor(owner))
  assert.equal(ctx.activations[0].request.maxDepth, 2, 'a nested owner may start a depth-2 worker')

  // A dispatch by the human owner (the headless one-turn case) must fold; the
  // event actor is `human`, not just `agent`.
  const second = createAsHuman(h, owner, { statement: 'Human owner dispatch', criteria: [simpleCriteria[0]] })
  const secondPlan = h.engine.plan(
    { objectiveId: second.objective.id, title: 'Human dispatch item', detail: 'no-op', acceptance: ['reported'], criterionIds: ['c1'] },
    h.actor(owner),
  )
  assert.equal(secondPlan.ok, true)
  owner.humanTurn('dispatch as the human owner')
  const byHuman = await h.engine.dispatch({ itemId: secondPlan.item.id, persona: 'architect', brief: 'human dispatch' }, h.actor(owner))
  owner.idle()
  assert.equal(byHuman.ok, true, JSON.stringify(byHuman))
  assert.equal(h.engine.state.items.get(secondPlan.item.id).state, 'dispatched')
  assert.equal(ctx.activations[1].request.maxDepth, 2)
  h.close()
  section('child-depth cap is absolute: a root owner §1, a nested owner §2; a human owner dispatch folds')
}

console.log(`\nobjective-engine selftests passed (${passed.length} sections)`)
